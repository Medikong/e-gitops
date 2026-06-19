import { nonNegativeNumber, optional, positiveInteger, positiveNumber, rate, parseStages } from '../env.js';

const EXECUTORS = new Set(['constant-vus', 'ramping-vus', 'constant-arrival-rate', 'ramping-arrival-rate']);

export function getReservationJourneyConfig() {
  const executor = optional('LOADTEST_RESERVATION_JOURNEY_EXECUTOR', 'ramping-vus');
  if (!EXECUTORS.has(executor)) {
    throw new Error(`LOADTEST_RESERVATION_JOURNEY_EXECUTOR must be one of ${Array.from(EXECUTORS).join(', ')}`);
  }
  const vus = positiveInteger('LOADTEST_RESERVATION_JOURNEY_VUS', 5);
  const ratePerTimeUnit = positiveInteger('LOADTEST_RESERVATION_JOURNEY_RATE', 1);
  const preAllocatedVus = positiveInteger('LOADTEST_RESERVATION_JOURNEY_PRE_ALLOCATED_VUS', Math.max(vus, 10));
  const maxVus = positiveInteger('LOADTEST_RESERVATION_JOURNEY_MAX_VUS', Math.max(vus, preAllocatedVus));
  const stages = parseStages('LOADTEST_RESERVATION_JOURNEY_STAGES');
  const stageMax = Math.max(0, ...stages.map((stage) => stage.target));

  return {
    executor,
    requestPrefix: optional('LOADTEST_RESERVATION_JOURNEY_REQUEST_PREFIX', 'loadtest-reservation'),
    requestIdBase: '',
    timeoutSeconds: positiveNumber('LOADTEST_RESERVATION_JOURNEY_TIMEOUT_SECONDS', 10),
    setupTimeout: optional('LOADTEST_RESERVATION_JOURNEY_SETUP_TIMEOUT', '10m'),
    vus,
    rate: ratePerTimeUnit,
    timeUnit: optional('LOADTEST_RESERVATION_JOURNEY_TIME_UNIT', '1s'),
    preAllocatedVUs: preAllocatedVus,
    maxVUs: maxVus,
    plannedMaxVus: Math.max(vus, maxVus, stageMax),
    duration: optional('LOADTEST_RESERVATION_JOURNEY_DURATION', '2m'),
    stages,
    gracefulStop: optional('LOADTEST_RESERVATION_JOURNEY_GRACEFUL_STOP', '30s'),
    thinkTimeSeconds: nonNegativeNumber('LOADTEST_RESERVATION_JOURNEY_THINK_TIME_SECONDS', 0),
    pollSeconds: positiveNumber('LOADTEST_RESERVATION_JOURNEY_POLL_SECONDS', 45),
    pollIntervalSeconds: positiveNumber('LOADTEST_RESERVATION_JOURNEY_POLL_INTERVAL_SECONDS', 2),
    ticketListLimit: positiveInteger('LOADTEST_RESERVATION_JOURNEY_TICKET_LIST_LIMIT', 20),
    ticketListMaxPages: positiveInteger('LOADTEST_RESERVATION_JOURNEY_TICKET_LIST_MAX_PAGES', 5),
    activeCustomerCount: positiveInteger('LOADTEST_RESERVATION_JOURNEY_ACTIVE_CUSTOMER_COUNT', 100),
    paymentAmount: positiveInteger('LOADTEST_RESERVATION_JOURNEY_PAYMENT_AMOUNT', 50000),
    maxSeatAttempts: positiveInteger('LOADTEST_RESERVATION_JOURNEY_MAX_SEAT_ATTEMPTS', 3),
    concertLimit: positiveInteger('LOADTEST_RESERVATION_JOURNEY_CONCERT_LIMIT', 50),
    performanceLimit: positiveInteger('LOADTEST_RESERVATION_JOURNEY_PERFORMANCE_LIMIT', 50),
    seatLimit: positiveInteger('LOADTEST_RESERVATION_JOURNEY_SEAT_LIMIT', 200),
    thresholds: {
      httpReqFailedRate: rate('LOADTEST_RESERVATION_JOURNEY_THRESHOLD_HTTP_REQ_FAILED_RATE', 0.01),
      httpReqDurationP95Ms: positiveNumber('LOADTEST_RESERVATION_JOURNEY_THRESHOLD_HTTP_REQ_DURATION_P95_MS', 500),
      httpReqDurationP99Ms: positiveNumber('LOADTEST_RESERVATION_JOURNEY_THRESHOLD_HTTP_REQ_DURATION_P99_MS', 1000),
      checksRate: rate('LOADTEST_RESERVATION_JOURNEY_THRESHOLD_CHECKS_RATE', 0.99),
      reservationJourneySuccessRate: rate('LOADTEST_RESERVATION_JOURNEY_THRESHOLD_SUCCESS_RATE', 0.99),
      reservationConflictRate: rate('LOADTEST_RESERVATION_JOURNEY_THRESHOLD_CONFLICT_RATE', 0.05),
      ticketIssuedRate: rate('LOADTEST_RESERVATION_JOURNEY_THRESHOLD_TICKET_ISSUED_RATE', 0.99),
    },
  };
}
