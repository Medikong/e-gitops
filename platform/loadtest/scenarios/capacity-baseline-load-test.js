import http from 'k6/http';
import crypto from 'k6/crypto';
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
  'reservation-service': 'capacity-baseline-reservation',
  'payment-service': 'capacity-baseline-payment',
  'ticket-service': 'capacity-baseline-ticket',
  'notification-service': 'capacity-baseline-notification',
};
const SERVICE_FUNCTIONS = {
  'auth-service': 'measureAuth',
  'reservation-service': 'measureReservation',
  'payment-service': 'measurePayment',
  'ticket-service': 'measureTicket',
  'notification-service': 'measureNotification',
};
const SERVICE_STEPS = {
  'auth-service': ['capacity_baseline.auth.login'],
  'concert-service': [
    'capacity_baseline.concert.recommended',
    'capacity_baseline.concert.detail',
    'capacity_baseline.concert.calendar',
    'capacity_baseline.concert.date_performances',
    'capacity_baseline.concert.seat_map',
  ],
  'reservation-service': ['capacity_baseline.reservation.create'],
  'payment-service': ['capacity_baseline.payment.create'],
  'ticket-service': ['capacity_baseline.ticket.issue', 'capacity_baseline.ticket.list'],
  'notification-service': ['capacity_baseline.notification.list'],
};
const ACTIVE_SERVICE_ORDER = config.serviceSteps || SERVICE_ORDER;
const CONCERT_MEASUREMENTS = [
  {
    service: 'concert-service',
    key: 'concert-recommended',
    scenario: 'capacity-baseline-concert-recommended',
    exec: 'measureConcertRecommended',
    step: 'capacity_baseline.concert.recommended',
    capacityStepPrefix: 'concert_recommended',
  },
  {
    service: 'concert-service',
    key: 'concert-detail',
    scenario: 'capacity-baseline-concert-detail',
    exec: 'measureConcertDetail',
    step: 'capacity_baseline.concert.detail',
    capacityStepPrefix: 'concert_detail',
  },
  {
    service: 'concert-service',
    key: 'concert-calendar',
    scenario: 'capacity-baseline-concert-calendar',
    exec: 'measureConcertCalendar',
    step: 'capacity_baseline.concert.calendar',
    capacityStepPrefix: 'concert_calendar',
  },
  {
    service: 'concert-service',
    key: 'concert-date-performances',
    scenario: 'capacity-baseline-concert-date-performances',
    exec: 'measureConcertDatePerformances',
    step: 'capacity_baseline.concert.date_performances',
    capacityStepPrefix: 'concert_date_performances',
  },
  {
    service: 'concert-service',
    key: 'concert-seat-map',
    scenario: 'capacity-baseline-concert-seat-map',
    exec: 'measureConcertSeatMap',
    step: 'capacity_baseline.concert.seat_map',
    capacityStepPrefix: 'concert_seat_map',
  },
];
const ACTIVE_MEASUREMENTS = ACTIVE_SERVICE_ORDER.flatMap((service) => {
  if (service === 'concert-service') {
    return CONCERT_MEASUREMENTS;
  }
  return [{
    service,
    key: service,
    scenario: SERVICE_SCENARIOS[service],
    exec: SERVICE_FUNCTIONS[service],
    steps: SERVICE_STEPS[service],
    capacityStepPrefix: service.replace(/-service$/, ''),
  }];
});
const MEASUREMENT_BY_KEY = Object.fromEntries(ACTIVE_MEASUREMENTS.map((measurement) => [measurement.key, measurement]));
const STEP_API = {
  'capacity_baseline.auth.login': { method: 'POST', route: 'POST /auth/login' },
  'capacity_baseline.concert.recommended': { method: 'GET', route: 'GET /concerts/recommended?sort=latest&cursor={cursor}' },
  'capacity_baseline.concert.detail': { method: 'GET', route: 'GET /concerts/{concertId}' },
  'capacity_baseline.concert.calendar': { method: 'GET', route: 'GET /concerts/{concertId}/calendar?yearMonth=YYYY-MM' },
  'capacity_baseline.concert.date_performances': { method: 'GET', route: 'GET /concerts/{concertId}/dates/{date}/performances' },
  'capacity_baseline.concert.seat_map': { method: 'GET', route: 'GET /performances/{performanceId}/seat-map' },
  'capacity_baseline.reservation.create': { method: 'POST', route: 'POST /reservations' },
  'capacity_baseline.payment.create': { method: 'POST', route: 'POST /payments' },
  'capacity_baseline.ticket.issue': { method: 'POST', route: 'POST /tickets/issue' },
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

function stageIdForMeasurement(measurement, stage) {
  return `${measurement.capacityStepPrefix}_rps_${String(stage.target).replace(/\./g, '_')}`;
}

function stagesForService(service) {
  return (config.serviceStages && config.serviceStages[service]) || config.stages || [];
}

function serviceDurationSeconds(service) {
  return stagesForService(service).reduce((total, stage) => total + durationSeconds(stage.duration), 0);
}

function measurementDurationSeconds(measurement) {
  return serviceDurationSeconds(measurement.service);
}

function measurementOffsetSeconds(measurementKey) {
  let offset = 0;
  for (const measurement of ACTIVE_MEASUREMENTS) {
    if (measurement.key === measurementKey) {
      return offset;
    }
    offset += measurementDurationSeconds(measurement) + durationSeconds(config.gracefulStop);
  }
  return offset;
}

function measurementStartTime(measurement) {
  return `${measurementOffsetSeconds(measurement.key)}s`;
}

function scenarioForMeasurement(measurement) {
  return {
    executor: 'ramping-arrival-rate',
    exec: measurement.exec,
    startTime: measurementStartTime(measurement),
    timeUnit: config.timeUnit,
    preAllocatedVUs: config.preAllocatedVUs,
    maxVUs: config.maxVUs,
    stages: stagesForService(measurement.service),
    gracefulStop: config.gracefulStop,
    tags: {
      environment: config.environment,
      profile: config.dataset.profile,
      test_type: config.testType,
      measured_service: measurement.service,
      measurement: measurement.key,
      target: config.target,
    },
  };
}

function thresholdTags(service, step, stage) {
  const measurement = measurementForStep(service, step);
  return `capacity_step:${stageIdForMeasurement(measurement, stage)},measured_service:${service},step:${step}`;
}

function serviceThresholdTags(service, stage, step = null) {
  const measurement = step === null
    ? ACTIVE_MEASUREMENTS.find((candidate) => candidate.service === service)
    : measurementForStep(service, step);
  return `capacity_step:${stageIdForMeasurement(measurement, stage)},measured_service:${service}`;
}

function measurementForStep(service, step) {
  if (service === 'concert-service') {
    return CONCERT_MEASUREMENTS.find((measurement) => measurement.step === step);
  }
  return MEASUREMENT_BY_KEY[service];
}

function capacityThresholds() {
  const thresholds = {
    loadtest_capacity_api_success: [`rate>${config.thresholds.checksRate}`],
  };
  if (config.resourceObservation.enabled) {
    thresholds.loadtest_capacity_resource_observation_success = ['rate>0.99'];
  }
  for (const service of ACTIVE_SERVICE_ORDER) {
    for (const stage of stagesForService(service)) {
      for (const step of SERVICE_STEPS[service]) {
        const tags = thresholdTags(service, step, stage);
        const sloP95Ms = config.endpointSloP95Ms[step] || config.thresholds.httpReqDurationP95Ms;
        thresholds[`http_req_duration{${tags}}`] = [
          `p(95)<${sloP95Ms}`,
          `p(99)<${config.thresholds.httpReqDurationP99Ms}`,
        ];
        thresholds[`http_req_failed{${tags}}`] = [`rate<${config.thresholds.httpReqFailedRate}`];
        thresholds[`checks{${tags}}`] = [`rate>${config.thresholds.checksRate}`];
      }
      if (config.resourceObservation.enabled) {
        for (const step of SERVICE_STEPS[service]) {
          thresholds[`loadtest_capacity_cpu_usage_m{${serviceThresholdTags(service, stage, step)}}`] = ['avg>=0'];
          thresholds[`loadtest_capacity_cpu_throttling_ratio{${serviceThresholdTags(service, stage, step)}}`] = ['avg>=0'];
        }
      }
    }
  }
  return thresholds;
}

export const options = {
  setupTimeout: config.setupTimeout,
  scenarios: Object.fromEntries(ACTIVE_MEASUREMENTS.map((measurement) => [measurement.scenario, scenarioForMeasurement(measurement)])),
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
    concertId: datasetUuid('concert', 1),
    performanceId: datasetUuid('showtime', 1, 1),
  };
}

function stageForMeasurement(setupData, measurement) {
  const stages = stagesForService(measurement.service);
  const elapsedSeconds = Math.max(0, (Date.now() - setupData.measurementStartedAtMs) / 1000);
  const serviceElapsed = elapsedSeconds - measurementOffsetSeconds(measurement.key);
  let upperBound = 0;
  for (let index = 0; index < stages.length; index += 1) {
    upperBound += durationSeconds(stages[index].duration);
    if (serviceElapsed <= upperBound || index === stages.length - 1) {
      return {
        ...stages[index],
        index,
        id: stageIdForMeasurement(measurement, stages[index]),
      };
    }
  }
  return {
    ...stages[0],
    index: 0,
    id: stageIdForMeasurement(measurement, stages[0]),
  };
}

function iterationConfig(setupData, measurementKey) {
  const measurement = MEASUREMENT_BY_KEY[measurementKey];
  const iterationId = `${Date.now()}-${exec.scenario.name}-${exec.scenario.iterationInTest}`;
  const stage = stageForMeasurement(setupData, measurement);
  return {
    ...config,
    measuredService: measurement.service,
    measurementKey: measurement.key,
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

function firstFrom(body, field, step) {
  const values = body && body[field];
  if (!Array.isArray(values) || values.length === 0) {
    fail(`${step} returned no ${field} array`);
  }
  return values[exec.scenario.iterationInTest % values.length] || values[0];
}

function datasetUuid(...parts) {
  const name = [config.dataset.revision, ...parts.map((part) => String(part))].join(':');
  const chars = crypto.sha256(name, 'hex').slice(0, 32).split('');
  chars[12] = '8';
  chars[16] = ((parseInt(chars[16], 16) & 0x3) | 0x8).toString(16);
  const value = chars.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
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

export function measureConcertRecommended(setupData) {
  const runConfig = iterationConfig(setupData, 'concert-recommended');
  try {
    const concertsBody = requestJson(
      runConfig,
      'capacity_baseline.concert.recommended',
      'GET',
      '/concerts/recommended',
      null,
      {},
      { sort: 'latest', cursor: setupData.recommendedCursor, limit: runConfig.concertLimit },
    );
    itemsFrom(concertsBody, 'capacity_baseline.concert.recommended');
  } finally {
    observeResources(runConfig);
  }
}

export function measureConcertDetail(setupData) {
  const runConfig = iterationConfig(setupData, 'concert-detail');
  try {
    requestJson(runConfig, 'capacity_baseline.concert.detail', 'GET', `/concerts/${encodeURIComponent(setupData.concertId)}`);
  } finally {
    observeResources(runConfig);
  }
}

export function measureConcertCalendar(setupData) {
  const runConfig = iterationConfig(setupData, 'concert-calendar');
  try {
    requestJson(
      runConfig,
      'capacity_baseline.concert.calendar',
      'GET',
      `/concerts/${encodeURIComponent(setupData.concertId)}/calendar`,
      null,
      {},
      { yearMonth: runConfig.calendarYearMonth },
    );
  } finally {
    observeResources(runConfig);
  }
}

export function measureConcertDatePerformances(setupData) {
  const runConfig = iterationConfig(setupData, 'concert-date-performances');
  try {
    const performancesBody = requestJson(
      runConfig,
      'capacity_baseline.concert.date_performances',
      'GET',
      `/concerts/${encodeURIComponent(setupData.concertId)}/dates/${encodeURIComponent(runConfig.performanceDate)}/performances`,
      null,
      {},
      { limit: runConfig.performanceLimit },
    );
    firstFrom(performancesBody, 'performances', 'capacity_baseline.concert.date_performances');
  } finally {
    observeResources(runConfig);
  }
}

export function measureConcertSeatMap(setupData) {
  const runConfig = iterationConfig(setupData, 'concert-seat-map');
  try {
    requestJson(
      runConfig,
      'capacity_baseline.concert.seat_map',
      'GET',
      `/performances/${encodeURIComponent(setupData.performanceId)}/seat-map`,
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
        seatId: datasetUuid('seat', iteration),
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
      'capacity_baseline.payment.create',
      'POST',
      '/payments',
      {
        reservationId: datasetUuid('pending-reservation', iteration),
        concertId: setupData.concertId,
        seatId: datasetUuid('payment-seat', iteration),
        amount: runConfig.paymentAmount,
        method: 'CARD',
        simulation: 'approve',
      },
      {
        ...authHeaders(setupData),
        'Idempotency-Key': datasetUuid('payment-idempotency', iteration),
      },
    );
  } finally {
    observeResources(runConfig);
  }
}

export function measureTicket(setupData) {
  const runConfig = iterationConfig(setupData, 'ticket-service');
  const iteration = exec.scenario.iterationInTest + 1;
  const poolIndex = ((iteration - 1) % runConfig.ticketIssuePoolCount) + 1;
  const token = customerToken(setupData);
  try {
    requestJson(
      runConfig,
      'capacity_baseline.ticket.issue',
      'POST',
      '/tickets/issue',
      {
        reservationId: datasetUuid('paid-reservation', poolIndex),
        userId: token.userId,
        concertId: setupData.concertId,
        seatId: datasetUuid('ticket-issue-seat', poolIndex),
      },
      authHeaders(setupData),
    );
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
