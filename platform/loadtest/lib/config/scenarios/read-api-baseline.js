import { nonNegativeNumber, optional, positiveInteger, positiveNumber, rate, parseStages } from '../env.js';

export function getReadApiBaselineConfig() {
  const vus = positiveInteger('LOADTEST_READ_API_VUS', 5);
  const stages = parseStages('LOADTEST_READ_API_STAGES');

  return {
    requestPrefix: optional('LOADTEST_READ_API_REQUEST_PREFIX', 'loadtest-read'),
    requestIdBase: '',
    timeoutSeconds: positiveNumber('LOADTEST_READ_API_TIMEOUT_SECONDS', 10),
    vus,
    plannedMaxVus: Math.max(vus, ...stages.map((stage) => stage.target)),
    duration: optional('LOADTEST_READ_API_DURATION', '2m'),
    stages,
    gracefulStop: optional('LOADTEST_READ_API_GRACEFUL_STOP', '30s'),
    thinkTimeSeconds: nonNegativeNumber('LOADTEST_READ_API_THINK_TIME_SECONDS', 0),
    pollSeconds: 0,
    pollIntervalSeconds: 0,
    paymentAmount: 0,
    maxSeatAttempts: 1,
    concertLimit: positiveInteger('LOADTEST_READ_API_CONCERT_LIMIT', 50),
    performanceLimit: positiveInteger('LOADTEST_READ_API_PERFORMANCE_LIMIT', 50),
    seatLimit: positiveInteger('LOADTEST_READ_API_SEAT_LIMIT', 200),
    thresholds: {
      httpReqFailedRate: rate('LOADTEST_READ_API_THRESHOLD_HTTP_REQ_FAILED_RATE', 0.01),
      httpReqDurationP95Ms: positiveNumber('LOADTEST_READ_API_THRESHOLD_HTTP_REQ_DURATION_P95_MS', 500),
      httpReqDurationP99Ms: positiveNumber('LOADTEST_READ_API_THRESHOLD_HTTP_REQ_DURATION_P99_MS', 1000),
      checksRate: rate('LOADTEST_READ_API_THRESHOLD_CHECKS_RATE', 0.99),
    },
  };
}
