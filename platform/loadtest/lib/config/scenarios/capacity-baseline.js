import {
  nonNegativeNumber,
  optional,
  positiveInteger,
  positiveNumber,
  rate,
  parseStages,
  parseStringArray,
} from '../env.js';

const SERVICE_STEP_ALIASES = {
  auth: 'auth-service',
  'auth-service': 'auth-service',
  concert: 'concert-service',
  'concert-service': 'concert-service',
  reservation: 'reservation-service',
  'reservation-service': 'reservation-service',
  payment: 'payment-service',
  'payment-service': 'payment-service',
  ticket: 'ticket-service',
  'ticket-service': 'ticket-service',
  notification: 'notification-service',
  'notification-service': 'notification-service',
};

const DEFAULT_SERVICE_STEPS = [
  'auth-service',
  'concert-service',
  'reservation-service',
  'payment-service',
  'ticket-service',
  'notification-service',
];

function parseJsonObject(name, fallback) {
  const raw = optional(name, JSON.stringify(fallback));
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${name} must be a JSON object: ${error.message}`);
  }
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error(`${name} must be a JSON object`);
  }
  return value;
}

function parseServiceSteps() {
  const values = parseStringArray('LOADTEST_CAPACITY_BASELINE_SERVICE_STEPS');
  if (values.length === 0) {
    return DEFAULT_SERVICE_STEPS;
  }
  const seen = new Set();
  return values.map((value, index) => {
    const normalized = SERVICE_STEP_ALIASES[String(value).trim()];
    if (!normalized) {
      throw new Error(`LOADTEST_CAPACITY_BASELINE_SERVICE_STEPS[${index}] must be one of ${Object.keys(SERVICE_STEP_ALIASES).join(', ')}`);
    }
    if (seen.has(normalized)) {
      throw new Error(`LOADTEST_CAPACITY_BASELINE_SERVICE_STEPS contains duplicate service step: ${value}`);
    }
    seen.add(normalized);
    return normalized;
  });
}

function parseResourceTargets() {
  const raw = optional('LOADTEST_CAPACITY_BASELINE_RESOURCE_TARGETS', '[]');
  let targets;
  try {
    targets = JSON.parse(raw);
  } catch (error) {
    throw new Error(`LOADTEST_CAPACITY_BASELINE_RESOURCE_TARGETS must be JSON: ${error.message}`);
  }
  if (!Array.isArray(targets)) {
    throw new Error('LOADTEST_CAPACITY_BASELINE_RESOURCE_TARGETS must be a JSON array');
  }
  return targets.map((target, index) => {
    if (!target || !target.service || !target.namespace || !target.podSelector) {
      throw new Error(`LOADTEST_CAPACITY_BASELINE_RESOURCE_TARGETS[${index}] requires service, namespace, podSelector`);
    }
    return {
      service: String(target.service),
      namespace: String(target.namespace),
      podSelector: String(target.podSelector),
      podRegex: target.podRegex ? String(target.podRegex) : `${String(target.service)}-.*`,
    };
  });
}

export function getCapacityBaselineConfig() {
  const stages = parseStages('LOADTEST_CAPACITY_BASELINE_STAGES');
  if (stages.length === 0) {
    throw new Error('LOADTEST_CAPACITY_BASELINE_STAGES is required');
  }
  const vus = positiveInteger('LOADTEST_CAPACITY_BASELINE_VUS', 5);
  const preAllocatedVus = positiveInteger('LOADTEST_CAPACITY_BASELINE_PRE_ALLOCATED_VUS', Math.max(vus, 10));
  const maxVus = positiveInteger('LOADTEST_CAPACITY_BASELINE_MAX_VUS', Math.max(vus, preAllocatedVus));
  const stageMax = Math.max(0, ...stages.map((stage) => stage.target));

  return {
    requestPrefix: optional('LOADTEST_CAPACITY_BASELINE_REQUEST_PREFIX', 'loadtest-capacity-baseline'),
    requestIdBase: '',
    stepPrefix: 'capacity_baseline',
    executor: 'ramping-arrival-rate',
    timeoutSeconds: positiveNumber('LOADTEST_CAPACITY_BASELINE_TIMEOUT_SECONDS', 10),
    setupTimeout: optional('LOADTEST_CAPACITY_BASELINE_SETUP_TIMEOUT', '5m'),
    vus,
    rate: positiveInteger('LOADTEST_CAPACITY_BASELINE_RATE', 1),
    timeUnit: optional('LOADTEST_CAPACITY_BASELINE_TIME_UNIT', '1s'),
    preAllocatedVUs: preAllocatedVus,
    maxVUs: maxVus,
    plannedMaxVus: Math.max(vus, maxVus, preAllocatedVus, stageMax),
    duration: optional('LOADTEST_CAPACITY_BASELINE_DURATION', '1m'),
    serviceSteps: parseServiceSteps(),
    stages,
    gracefulStop: optional('LOADTEST_CAPACITY_BASELINE_GRACEFUL_STOP', '15s'),
    thinkTimeSeconds: nonNegativeNumber('LOADTEST_CAPACITY_BASELINE_THINK_TIME_SECONDS', 0),
    activeCustomerCount: positiveInteger('LOADTEST_CAPACITY_BASELINE_ACTIVE_CUSTOMER_COUNT', 20),
    concertLimit: positiveInteger('LOADTEST_CAPACITY_BASELINE_CONCERT_LIMIT', 50),
    performanceLimit: positiveInteger('LOADTEST_CAPACITY_BASELINE_PERFORMANCE_LIMIT', 50),
    seatLimit: positiveInteger('LOADTEST_CAPACITY_BASELINE_SEAT_LIMIT', 200),
    ticketListLimit: positiveInteger('LOADTEST_CAPACITY_BASELINE_TICKET_LIST_LIMIT', 20),
    paymentAmount: positiveInteger('LOADTEST_CAPACITY_BASELINE_PAYMENT_AMOUNT', 50000),
    targetUtilization: positiveNumber('LOADTEST_CAPACITY_BASELINE_TARGET_UTILIZATION', 0.7),
    seedMethod: optional('LOADTEST_CAPACITY_BASELINE_SEED_METHOD', 'deterministic_bulk_insert'),
    fixedConditions: parseJsonObject('LOADTEST_CAPACITY_BASELINE_FIXED_CONDITIONS', {}),
    resourceObservation: {
      enabled: optional('LOADTEST_CAPACITY_BASELINE_RESOURCE_OBSERVATION_ENABLED', 'false') === 'true',
      source: optional('LOADTEST_CAPACITY_BASELINE_RESOURCE_OBSERVATION_SOURCE', 'prometheus'),
      prometheusUrl: optional(
        'LOADTEST_CAPACITY_BASELINE_PROMETHEUS_URL',
        'http://kube-prometheus-stack-prometheus.monitoring.svc.cluster.local:9090',
      ).replace(/\/+$/, ''),
      queryWindow: optional('LOADTEST_CAPACITY_BASELINE_RESOURCE_QUERY_WINDOW', '1m'),
      pollEveryIterations: positiveInteger('LOADTEST_CAPACITY_BASELINE_RESOURCE_POLL_EVERY_ITERATIONS', 10),
      targets: parseResourceTargets(),
    },
    schemaRevisions: parseJsonObject('LOADTEST_CAPACITY_BASELINE_SCHEMA_REVISIONS', {}),
    seedRowCounts: parseJsonObject('LOADTEST_CAPACITY_BASELINE_SEED_ROW_COUNTS', {}),
    thresholds: {
      httpReqFailedRate: rate('LOADTEST_CAPACITY_BASELINE_THRESHOLD_HTTP_REQ_FAILED_RATE', 0.01),
      httpReqDurationP95Ms: positiveNumber('LOADTEST_CAPACITY_BASELINE_THRESHOLD_HTTP_REQ_DURATION_P95_MS', 100),
      httpReqDurationP99Ms: positiveNumber('LOADTEST_CAPACITY_BASELINE_THRESHOLD_HTTP_REQ_DURATION_P99_MS', 300),
      checksRate: rate('LOADTEST_CAPACITY_BASELINE_THRESHOLD_CHECKS_RATE', 0.99),
    },
  };
}
