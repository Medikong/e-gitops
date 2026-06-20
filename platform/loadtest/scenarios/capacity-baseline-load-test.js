import http from 'k6/http';
import exec from 'k6/execution';
import { check, fail, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

import { getConfig } from '../lib/config.js';
import { durationSeconds } from '../lib/http-metrics.js';
import { logExperimentConditions } from '../lib/log.js';
import { requireField } from '../lib/pick.js';
import { capacityBaselineSummaryOutput } from '../lib/report.js';

const config = getConfig();
const SERVICE_ORDER = [
  'auth-service',
  'concert-service',
  'reservation-service',
  'payment-service',
  'ticket-service',
  'notification-service',
];
const SERVICE_SCENARIOS = {
  'auth-service': 'capacity-baseline-auth',
  'concert-service': 'capacity-baseline-concert',
  'reservation-service': 'capacity-baseline-reservation',
  'payment-service': 'capacity-baseline-payment',
  'ticket-service': 'capacity-baseline-ticket',
  'notification-service': 'capacity-baseline-notification',
};
const SERVICE_FUNCTIONS = {
  'auth-service': 'measureAuth',
  'concert-service': 'measureConcert',
  'reservation-service': 'measureReservation',
  'payment-service': 'measurePayment',
  'ticket-service': 'measureTicket',
  'notification-service': 'measureNotification',
};
const SERVICE_STEPS = {
  'auth-service': ['capacity_baseline.auth.login'],
  'concert-service': [
    'capacity_baseline.concert.concerts',
    'capacity_baseline.concert.performances',
    'capacity_baseline.concert.seats',
  ],
  'reservation-service': ['capacity_baseline.reservation.create'],
  'payment-service': ['capacity_baseline.payment.approve'],
  'ticket-service': ['capacity_baseline.ticket.list'],
  'notification-service': ['capacity_baseline.notification.list'],
};
const ACTIVE_SERVICE_ORDER = config.serviceSteps || SERVICE_ORDER;
const STEP_API = {
  'capacity_baseline.auth.login': { method: 'POST', route: 'POST /auth/login' },
  'capacity_baseline.concert.concerts': { method: 'GET', route: 'GET /concerts' },
  'capacity_baseline.concert.performances': { method: 'GET', route: 'GET /concerts/{concertId}/performances' },
  'capacity_baseline.concert.seats': { method: 'GET', route: 'GET /performances/{performanceId}/seats' },
  'capacity_baseline.reservation.create': { method: 'POST', route: 'POST /reservations' },
  'capacity_baseline.payment.approve': { method: 'POST', route: 'POST /payments' },
  'capacity_baseline.ticket.list': { method: 'GET', route: 'GET /tickets/me' },
  'capacity_baseline.notification.list': { method: 'GET', route: 'GET /notifications' },
};

const capacityApiSuccess = new Rate('loadtest_capacity_api_success');
const capacityResourceObservationSuccess = new Rate('loadtest_capacity_resource_observation_success');
const cpuUsageMilli = new Trend('loadtest_capacity_cpu_usage_m');
const cpuThrottlingRatio = new Trend('loadtest_capacity_cpu_throttling_ratio');
const resourceTargets = Object.fromEntries((config.resourceObservation.targets || []).map((target) => [target.service, target]));
const metricsApiSources = new Set(['metrics-api', 'metrics.k8s.io']);
const serviceAccountToken = config.resourceObservation.enabled && metricsApiSources.has(config.resourceObservation.source)
  ? open('/var/run/secrets/kubernetes.io/serviceaccount/token')
  : '';
const kubernetesApi = (__ENV.KUBERNETES_SERVICE_HOST && __ENV.KUBERNETES_SERVICE_PORT)
  ? `https://${__ENV.KUBERNETES_SERVICE_HOST}:${__ENV.KUBERNETES_SERVICE_PORT}`
  : 'https://kubernetes.default.svc';

function stageId(service, stage) {
  return `${service.replace(/-service$/, '')}_rps_${String(stage.target).replace(/\./g, '_')}`;
}

function serviceDurationSeconds() {
  return (config.stages || []).reduce((total, stage) => total + durationSeconds(stage.duration), 0);
}

function serviceStartTime(service) {
  const index = ACTIVE_SERVICE_ORDER.indexOf(service);
  const offset = index * (serviceDurationSeconds() + durationSeconds(config.gracefulStop));
  return `${offset}s`;
}

function scenarioForService(service) {
  return {
    executor: 'ramping-arrival-rate',
    exec: SERVICE_FUNCTIONS[service],
    startTime: serviceStartTime(service),
    timeUnit: config.timeUnit,
    preAllocatedVUs: config.preAllocatedVUs,
    maxVUs: config.maxVUs,
    stages: config.stages,
    gracefulStop: config.gracefulStop,
    tags: {
      environment: config.environment,
      profile: config.dataset.profile,
      test_type: config.testType,
      measured_service: service,
      target: config.target,
    },
  };
}

function thresholdTags(service, step, stage) {
  return `capacity_step:${stageId(service, stage)},measured_service:${service},step:${step}`;
}

function serviceThresholdTags(service, stage) {
  return `capacity_step:${stageId(service, stage)},measured_service:${service}`;
}

function capacityThresholds() {
  const thresholds = {
    loadtest_capacity_api_success: [`rate>${config.thresholds.checksRate}`],
  };
  if (config.resourceObservation.enabled) {
    thresholds.loadtest_capacity_resource_observation_success = ['rate>0.99'];
  }
  for (const service of ACTIVE_SERVICE_ORDER) {
    for (const stage of config.stages || []) {
      for (const step of SERVICE_STEPS[service]) {
        const tags = thresholdTags(service, step, stage);
        thresholds[`http_req_duration{${tags}}`] = [
          `p(95)<${config.thresholds.httpReqDurationP95Ms}`,
          `p(99)<${config.thresholds.httpReqDurationP99Ms}`,
        ];
        thresholds[`http_req_failed{${tags}}`] = [`rate<${config.thresholds.httpReqFailedRate}`];
        thresholds[`checks{${tags}}`] = [`rate>${config.thresholds.checksRate}`];
      }
      if (config.resourceObservation.enabled) {
        thresholds[`loadtest_capacity_cpu_usage_m{${serviceThresholdTags(service, stage)}}`] = ['avg>=0'];
        thresholds[`loadtest_capacity_cpu_throttling_ratio{${serviceThresholdTags(service, stage)}}`] = ['avg>=0'];
      }
    }
  }
  return thresholds;
}

export const options = {
  setupTimeout: config.setupTimeout,
  scenarios: Object.fromEntries(ACTIVE_SERVICE_ORDER.map((service) => [SERVICE_SCENARIOS[service], scenarioForService(service)])),
  thresholds: capacityThresholds(),
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  tags: {
    environment: config.environment,
    profile: config.dataset.profile,
    test_type: config.testType,
    target: config.target,
  },
  insecureSkipTLSVerify: config.resourceObservation.enabled,
};

function customerEmail(index) {
  const width = config.customerPool.padWidth || 6;
  return `${config.customerPool.emailPrefix}-${String(index).padStart(width, '0')}@${config.customerPool.emailDomain}`;
}

function loginCustomer(index) {
  const response = http.post(`${config.baseUrl}/auth/login`, JSON.stringify({
    email: customerEmail(index),
    password: config.customerPool.password,
  }), {
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Loadtest-Traffic': 'true',
    },
    timeout: `${config.timeoutSeconds}s`,
    tags: {
      environment: config.environment,
      profile: config.dataset.profile,
      test_type: config.testType,
      target: config.target,
      phase: 'capacity_baseline_setup',
    },
  });
  if (response.status !== 200) {
    fail(`capacity_baseline.setup.login failed with status ${response.status}`);
  }
  try {
    const body = response.json();
    return {
      accessToken: requireField(body, 'accessToken', 'capacity_baseline.setup.login'),
      user: requireField(body, 'user', 'capacity_baseline.setup.login'),
    };
  } catch (error) {
    fail(`capacity_baseline.setup.login returned invalid json: ${error.message}`);
  }
  return null;
}

export function setup() {
  logExperimentConditions(config, 'capacity_baseline');
  const customerTokens = [];
  const needsCustomerTokens = ACTIVE_SERVICE_ORDER.some((service) => (
    ['reservation-service', 'payment-service', 'ticket-service', 'notification-service'].includes(service)
  ));
  if (needsCustomerTokens) {
    const preparedCustomers = Math.max(1, config.activeCustomerCount);
    for (let index = 1; index <= preparedCustomers; index += 1) {
      const auth = loginCustomer(index);
      customerTokens.push({
        userId: String(requireField(requireField(auth, 'user', 'capacity_baseline.setup.login'), 'id', 'capacity_baseline.setup.login')),
        accessToken: requireField(auth, 'accessToken', 'capacity_baseline.setup.login'),
      });
    }
  }
  return {
    measurementStartedAtMs: Date.now(),
    customerTokens,
    concertId: `${config.dataset.revision}-concert-0001`,
    performanceId: `${config.dataset.revision}-showtime-0001-0001`,
  };
}

function stageForService(setupData, service) {
  const serviceIndex = ACTIVE_SERVICE_ORDER.indexOf(service);
  const elapsedSeconds = Math.max(0, (Date.now() - setupData.measurementStartedAtMs) / 1000);
  const serviceElapsed = elapsedSeconds - (serviceIndex * (serviceDurationSeconds() + durationSeconds(config.gracefulStop)));
  let upperBound = 0;
  for (let index = 0; index < config.stages.length; index += 1) {
    upperBound += durationSeconds(config.stages[index].duration);
    if (serviceElapsed <= upperBound || index === config.stages.length - 1) {
      return {
        ...config.stages[index],
        index,
        id: stageId(service, config.stages[index]),
      };
    }
  }
  return {
    ...config.stages[0],
    index: 0,
    id: stageId(service, config.stages[0]),
  };
}

function iterationConfig(setupData, service) {
  const iterationId = `${Date.now()}-${exec.scenario.name}-${exec.scenario.iterationInTest}`;
  const stage = stageForService(setupData, service);
  return {
    ...config,
    measuredService: service,
    capacityStage: stage,
    iterationId,
    requestIdBase: `${config.requestPrefix}-${config.scenario}-${iterationId}`,
  };
}

function customerToken(setupData) {
  const index = exec.scenario.iterationInTest % setupData.customerTokens.length;
  return setupData.customerTokens[index];
}

function tags(runConfig, step) {
  const metadata = STEP_API[step];
  return {
    environment: runConfig.environment,
    profile: runConfig.dataset.profile,
    test_type: runConfig.testType,
    target: runConfig.target,
    measured_service: runConfig.measuredService,
    capacity_step: runConfig.capacityStage.id,
    capacity_step_target_rps: String(runConfig.capacityStage.target),
    step,
    api: metadata.route,
    name: metadata.route,
    route: metadata.route,
  };
}

function requestJson(runConfig, step, method, path, body = null, extraHeaders = {}, query = {}) {
  const queryText = Object.entries(query)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  const payload = body === null || body === undefined ? null : JSON.stringify(body);
  const response = http.request(method, `${runConfig.baseUrl}${path}${queryText ? `?${queryText}` : ''}`, payload, {
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Loadtest-Traffic': 'true',
      'X-Request-Id': runConfig.requestIdBase,
      ...extraHeaders,
    },
    timeout: `${runConfig.timeoutSeconds}s`,
    tags: tags(runConfig, step),
  });
  const ok = check(response, {
    [`${step} returned 2xx`]: (res) => res.status >= 200 && res.status < 300,
    [`${step} returned json`]: (res) => String(res.headers['Content-Type'] || res.headers['content-type'] || '').includes('application/json'),
  }, tags(runConfig, step));
  capacityApiSuccess.add(ok, tags(runConfig, step));
  if (!ok) {
    fail(`${step} failed with status ${response.status}`);
  }
  try {
    return response.json();
  } catch (error) {
    fail(`${step} returned invalid json: ${error.message}`);
  }
  return null;
}

function authHeaders(setupData) {
  return {
    Authorization: `Bearer ${customerToken(setupData).accessToken}`,
  };
}

function itemsFrom(body, step) {
  if (Array.isArray(body)) {
    return body;
  }
  const items = body && body.items;
  if (!Array.isArray(items)) {
    fail(`${step} returned no items array`);
  }
  return items;
}

function capacityId(prefix, number) {
  return `${config.dataset.revision}-${prefix}-${String(number).padStart(6, '0')}`;
}

function observeResources(runConfig) {
  if (!runConfig.resourceObservation.enabled) {
    return;
  }
  if (exec.scenario.iterationInTest % runConfig.resourceObservation.pollEveryIterations !== 0) {
    return;
  }
  const target = resourceTargets[runConfig.measuredService];
  if (!target) {
    capacityResourceObservationSuccess.add(false, resourceTags(runConfig));
    fail(`missing capacity baseline resource target for ${runConfig.measuredService}`);
  }
  if (runConfig.resourceObservation.source === 'prometheus') {
    observePrometheusResources(runConfig, target);
    return;
  }
  observeMetricsApiResources(runConfig, target);
}

function resourceTags(runConfig) {
  return {
    measured_service: runConfig.measuredService,
    capacity_step: runConfig.capacityStage.id,
  };
}

function observePrometheusResources(runConfig, target) {
  const selector = `namespace="${target.namespace}",pod=~"${target.podRegex}",container!="",container!="POD",pod!="",image!=""`;
  const window = runConfig.resourceObservation.queryWindow;
  const cpuUsage = prometheusQueryValue(
    runConfig,
    `sum(rate(container_cpu_usage_seconds_total{${selector}}[${window}])) * 1000`,
    'cpu_usage_m',
  );
  const throttlingRatio = prometheusQueryValue(
    runConfig,
    `sum(rate(container_cpu_cfs_throttled_periods_total{${selector}}[${window}])) / clamp_min(sum(rate(container_cpu_cfs_periods_total{${selector}}[${window}])), 0.001)`,
    'cpu_throttling_ratio',
  );
  cpuUsageMilli.add(cpuUsage, resourceTags(runConfig));
  cpuThrottlingRatio.add(throttlingRatio, resourceTags(runConfig));
  capacityResourceObservationSuccess.add(true, resourceTags(runConfig));
}

function prometheusQueryValue(runConfig, query, metricName) {
  const response = http.get(
    `${runConfig.resourceObservation.prometheusUrl}/api/v1/query?query=${encodeURIComponent(query)}`,
    {
      timeout: '5s',
      responseCallback: http.expectedStatuses(200),
      tags: {
        ...resourceTags(runConfig),
        step: 'capacity_baseline.resource.observe',
        resource_metric: metricName,
      },
    },
  );
  if (response.status !== 200) {
    capacityResourceObservationSuccess.add(false, resourceTags(runConfig));
    fail(`Prometheus resource observation failed with status ${response.status}`);
  }
  const body = response.json();
  if (!body || body.status !== 'success' || !body.data || !Array.isArray(body.data.result) || body.data.result.length === 0) {
    capacityResourceObservationSuccess.add(false, resourceTags(runConfig));
    fail(`Prometheus resource observation returned no data for ${metricName}`);
  }
  const value = Number(body.data.result[0].value[1]);
  if (!Number.isFinite(value)) {
    capacityResourceObservationSuccess.add(false, resourceTags(runConfig));
    fail(`Prometheus resource observation returned invalid value for ${metricName}`);
  }
  return value;
}

function observeMetricsApiResources(runConfig, target) {
  const response = http.get(
    `${kubernetesApi}/apis/metrics.k8s.io/v1beta1/namespaces/${encodeURIComponent(target.namespace)}/pods?labelSelector=${encodeURIComponent(target.podSelector)}`,
    {
      headers: {
        Authorization: `Bearer ${serviceAccountToken}`,
        Accept: 'application/json',
      },
      timeout: '5s',
      responseCallback: http.expectedStatuses(200),
      tags: {
        measured_service: runConfig.measuredService,
        capacity_step: runConfig.capacityStage.id,
        step: 'capacity_baseline.resource.observe',
      },
    },
  );
  if (response.status !== 200) {
    capacityResourceObservationSuccess.add(false, resourceTags(runConfig));
    fail(`metrics.k8s.io resource observation failed with status ${response.status}`);
  }
  const body = response.json();
  const usage = (body.items || []).reduce((total, pod) => total + (pod.containers || []).reduce((podTotal, container) => (
    podTotal + cpuQuantityToMilli((container.usage || {}).cpu)
  ), 0), 0);
  cpuUsageMilli.add(usage, {
    measured_service: runConfig.measuredService,
    capacity_step: runConfig.capacityStage.id,
  });
  cpuThrottlingRatio.add(0, {
    measured_service: runConfig.measuredService,
    capacity_step: runConfig.capacityStage.id,
  });
  capacityResourceObservationSuccess.add(true, resourceTags(runConfig));
}

function cpuQuantityToMilli(value) {
  const text = String(value || '').trim();
  if (text.endsWith('n')) {
    return Number(text.slice(0, -1)) / 1000000;
  }
  if (text.endsWith('u')) {
    return Number(text.slice(0, -1)) / 1000;
  }
  if (text.endsWith('m')) {
    return Number(text.slice(0, -1));
  }
  const cores = Number(text);
  return Number.isFinite(cores) ? cores * 1000 : 0;
}

export function measureAuth(setupData) {
  const runConfig = iterationConfig(setupData, 'auth-service');
  try {
    requestJson(
      runConfig,
      'capacity_baseline.auth.login',
      'POST',
      '/auth/login',
      {
        email: customerEmail((exec.scenario.iterationInTest % config.activeCustomerCount) + 1),
        password: config.customerPool.password,
      },
    );
  } finally {
    observeResources(runConfig);
  }
  if (runConfig.thinkTimeSeconds > 0) {
    sleep(runConfig.thinkTimeSeconds);
  }
}

export function measureConcert(setupData) {
  const runConfig = iterationConfig(setupData, 'concert-service');
  try {
    const concertsBody = requestJson(runConfig, 'capacity_baseline.concert.concerts', 'GET', '/concerts', null, {}, { limit: runConfig.concertLimit });
    const concerts = itemsFrom(concertsBody, 'capacity_baseline.concert.concerts');
    const concert = concerts[exec.scenario.iterationInTest % concerts.length] || concerts[0];
    const concertId = requireField(concert, 'id', 'capacity_baseline.concert.concerts');
    const performancesBody = requestJson(
      runConfig,
      'capacity_baseline.concert.performances',
      'GET',
      `/concerts/${encodeURIComponent(concertId)}/performances`,
      null,
      {},
      { limit: runConfig.performanceLimit },
    );
    const performances = itemsFrom(performancesBody, 'capacity_baseline.concert.performances');
    const performance = performances[exec.scenario.iterationInTest % performances.length] || performances[0];
    const performanceId = requireField(performance, 'id', 'capacity_baseline.concert.performances');
    requestJson(
      runConfig,
      'capacity_baseline.concert.seats',
      'GET',
      `/performances/${encodeURIComponent(performanceId)}/seats`,
      null,
      {},
      { limit: runConfig.seatLimit },
    );
  } finally {
    observeResources(runConfig);
  }
}

export function measureReservation(setupData) {
  const runConfig = iterationConfig(setupData, 'reservation-service');
  const iteration = exec.scenario.iterationInTest + 1;
  try {
    requestJson(
      runConfig,
      'capacity_baseline.reservation.create',
      'POST',
      '/reservations',
      {
        concertId: setupData.concertId,
        showtimeId: setupData.performanceId,
        performanceId: setupData.performanceId,
        seatId: capacityId('seat', iteration),
      },
      authHeaders(setupData),
    );
  } finally {
    observeResources(runConfig);
  }
}

export function measurePayment(setupData) {
  const runConfig = iterationConfig(setupData, 'payment-service');
  const iteration = exec.scenario.iterationInTest + 1;
  try {
    requestJson(
      runConfig,
      'capacity_baseline.payment.approve',
      'POST',
      '/payments',
      {
        reservationId: capacityId('pending-reservation', iteration),
        concertId: setupData.concertId,
        seatId: capacityId('payment-seat', iteration),
        amount: runConfig.paymentAmount,
        method: 'CARD',
        simulation: 'approve',
      },
      {
        ...authHeaders(setupData),
        'Idempotency-Key': capacityId('payment-idempotency', iteration),
      },
    );
  } finally {
    observeResources(runConfig);
  }
}

export function measureTicket(setupData) {
  const runConfig = iterationConfig(setupData, 'ticket-service');
  try {
    requestJson(
      runConfig,
      'capacity_baseline.ticket.list',
      'GET',
      '/tickets/me',
      null,
      authHeaders(setupData),
      { limit: runConfig.ticketListLimit },
    );
  } finally {
    observeResources(runConfig);
  }
}

export function measureNotification(setupData) {
  const runConfig = iterationConfig(setupData, 'notification-service');
  try {
    requestJson(
      runConfig,
      'capacity_baseline.notification.list',
      'GET',
      '/notifications',
      null,
      authHeaders(setupData),
    );
  } finally {
    observeResources(runConfig);
  }
}

export function handleSummary(data) {
  return capacityBaselineSummaryOutput(config, data);
}
