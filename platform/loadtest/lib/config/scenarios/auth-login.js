import { nonNegativeNumber, optional, positiveInteger, positiveNumber, rate, parseStages } from '../env.js';

const EXECUTORS = new Set(['constant-vus', 'ramping-vus', 'constant-arrival-rate', 'ramping-arrival-rate']);

export function getAuthLoginConfig() {
  const executor = optional('LOADTEST_AUTH_LOGIN_EXECUTOR', 'constant-vus');
  if (!EXECUTORS.has(executor)) {
    throw new Error(`LOADTEST_AUTH_LOGIN_EXECUTOR must be one of ${Array.from(EXECUTORS).join(', ')}`);
  }
  const vus = positiveInteger('LOADTEST_AUTH_LOGIN_VUS', 5);
  const ratePerTimeUnit = positiveInteger('LOADTEST_AUTH_LOGIN_RATE', 1);
  const preAllocatedVus = positiveInteger('LOADTEST_AUTH_LOGIN_PRE_ALLOCATED_VUS', Math.max(vus, 10));
  const maxVus = positiveInteger('LOADTEST_AUTH_LOGIN_MAX_VUS', Math.max(vus, preAllocatedVus));
  const stages = parseStages('LOADTEST_AUTH_LOGIN_STAGES');
  const stageMax = Math.max(0, ...stages.map((stage) => stage.target));
  const plannedMaxVus = executor.endsWith('arrival-rate')
    ? Math.max(vus, maxVus, preAllocatedVus, stageMax)
    : Math.max(vus, stageMax);

  return {
    executor,
    summaryStep: 'auth_login.login',
    requestPrefix: optional('LOADTEST_AUTH_LOGIN_REQUEST_PREFIX', 'loadtest-auth-login'),
    requestIdBase: '',
    timeoutSeconds: positiveNumber('LOADTEST_AUTH_LOGIN_TIMEOUT_SECONDS', 10),
    setupTimeout: optional('LOADTEST_AUTH_LOGIN_SETUP_TIMEOUT', '10m'),
    vus,
    rate: ratePerTimeUnit,
    timeUnit: optional('LOADTEST_AUTH_LOGIN_TIME_UNIT', '1s'),
    preAllocatedVUs: preAllocatedVus,
    maxVUs: maxVus,
    plannedMaxVus,
    duration: optional('LOADTEST_AUTH_LOGIN_DURATION', '2m'),
    stages,
    gracefulStop: optional('LOADTEST_AUTH_LOGIN_GRACEFUL_STOP', '30s'),
    thinkTimeSeconds: nonNegativeNumber('LOADTEST_AUTH_LOGIN_THINK_TIME_SECONDS', 0),
    pollSeconds: 0,
    pollIntervalSeconds: 0,
    paymentAmount: 0,
    maxSeatAttempts: 1,
    concertLimit: 0,
    performanceLimit: 0,
    seatLimit: 0,
    thresholds: {
      httpReqFailedRate: rate('LOADTEST_AUTH_LOGIN_THRESHOLD_HTTP_REQ_FAILED_RATE', 0.01),
      httpReqDurationP95Ms: positiveNumber('LOADTEST_AUTH_LOGIN_THRESHOLD_HTTP_REQ_DURATION_P95_MS', 500),
      httpReqDurationP99Ms: positiveNumber('LOADTEST_AUTH_LOGIN_THRESHOLD_HTTP_REQ_DURATION_P99_MS', 1000),
      checksRate: rate('LOADTEST_AUTH_LOGIN_THRESHOLD_CHECKS_RATE', 0.99),
      authLoginSuccessRate: rate('LOADTEST_AUTH_LOGIN_THRESHOLD_SUCCESS_RATE', 0.99),
    },
  };
}
