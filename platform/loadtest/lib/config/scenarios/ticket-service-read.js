import { nonNegativeNumber, optional, positiveInteger, positiveNumber, rate, parseStages } from '../env.js';

const EXECUTORS = new Set(['constant-vus', 'ramping-vus', 'constant-arrival-rate', 'ramping-arrival-rate']);

export function getTicketServiceReadConfig() {
  const executor = optional('LOADTEST_TICKET_SERVICE_READ_EXECUTOR', 'constant-arrival-rate');
  if (!EXECUTORS.has(executor)) {
    throw new Error(`LOADTEST_TICKET_SERVICE_READ_EXECUTOR must be one of ${Array.from(EXECUTORS).join(', ')}`);
  }
  const vus = positiveInteger('LOADTEST_TICKET_SERVICE_READ_VUS', 5);
  const ratePerTimeUnit = positiveInteger('LOADTEST_TICKET_SERVICE_READ_RATE', 1);
  const preAllocatedVus = positiveInteger('LOADTEST_TICKET_SERVICE_READ_PRE_ALLOCATED_VUS', Math.max(vus, 10));
  const maxVus = positiveInteger('LOADTEST_TICKET_SERVICE_READ_MAX_VUS', Math.max(vus, preAllocatedVus));
  const stages = parseStages('LOADTEST_TICKET_SERVICE_READ_STAGES');
  const stageMax = Math.max(0, ...stages.map((stage) => stage.target));

  return {
    executor,
    requestPrefix: optional('LOADTEST_TICKET_SERVICE_READ_REQUEST_PREFIX', 'loadtest-ticket-read'),
    requestIdBase: '',
    timeoutSeconds: positiveNumber('LOADTEST_TICKET_SERVICE_READ_TIMEOUT_SECONDS', 10),
    setupTimeout: optional('LOADTEST_TICKET_SERVICE_READ_SETUP_TIMEOUT', '10m'),
    vus,
    rate: ratePerTimeUnit,
    timeUnit: optional('LOADTEST_TICKET_SERVICE_READ_TIME_UNIT', '1s'),
    preAllocatedVUs: preAllocatedVus,
    maxVUs: maxVus,
    plannedMaxVus: Math.max(vus, maxVus, stageMax),
    duration: optional('LOADTEST_TICKET_SERVICE_READ_DURATION', '2m'),
    stages,
    gracefulStop: optional('LOADTEST_TICKET_SERVICE_READ_GRACEFUL_STOP', '30s'),
    thinkTimeSeconds: nonNegativeNumber('LOADTEST_TICKET_SERVICE_READ_THINK_TIME_SECONDS', 0),
    ticketListLimit: positiveInteger('LOADTEST_TICKET_SERVICE_READ_TICKET_LIST_LIMIT', 20),
    ticketListPaginationPages: positiveInteger('LOADTEST_TICKET_SERVICE_READ_TICKET_LIST_PAGINATION_PAGES', 3),
    ticketListMaxPages: positiveInteger('LOADTEST_TICKET_SERVICE_READ_TICKET_LIST_MAX_PAGES', 5),
    ticketSetupTicketsPerCustomer: positiveInteger('LOADTEST_TICKET_SERVICE_READ_TICKETS_PER_CUSTOMER', 60),
    ticketWaitTargetTicketPosition: positiveInteger('LOADTEST_TICKET_SERVICE_READ_WAIT_TARGET_TICKET_POSITION', 41),
    activeCustomerCount: positiveInteger('LOADTEST_TICKET_SERVICE_READ_ACTIVE_CUSTOMER_COUNT', 20),
    pollSeconds: 0,
    pollIntervalSeconds: 0,
    paymentAmount: 0,
    maxSeatAttempts: 1,
    concertLimit: 0,
    performanceLimit: 0,
    seatLimit: 0,
    thresholds: {
      httpReqFailedRate: rate('LOADTEST_TICKET_SERVICE_READ_THRESHOLD_HTTP_REQ_FAILED_RATE', 0.01),
      httpReqDurationP95Ms: positiveNumber('LOADTEST_TICKET_SERVICE_READ_THRESHOLD_HTTP_REQ_DURATION_P95_MS', 500),
      httpReqDurationP99Ms: positiveNumber('LOADTEST_TICKET_SERVICE_READ_THRESHOLD_HTTP_REQ_DURATION_P99_MS', 1000),
      checksRate: rate('LOADTEST_TICKET_SERVICE_READ_THRESHOLD_CHECKS_RATE', 0.99),
      ticketServiceReadSuccessRate: rate('LOADTEST_TICKET_SERVICE_READ_THRESHOLD_SUCCESS_RATE', 0.99),
    },
  };
}
