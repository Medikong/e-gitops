import { nonNegativeNumber, optional, positiveInteger, positiveNumber, rate, parseStages } from '../env.js';

const EXECUTORS = new Set(['constant-vus', 'ramping-vus', 'constant-arrival-rate', 'ramping-arrival-rate']);

function reservationLoadConfig(prefix, defaults) {
  const executor = optional(`${prefix}_EXECUTOR`, defaults.executor);
  if (!EXECUTORS.has(executor)) {
    throw new Error(`${prefix}_EXECUTOR must be one of ${Array.from(EXECUTORS).join(', ')}`);
  }
  const vus = positiveInteger(`${prefix}_VUS`, defaults.vus);
  const ratePerTimeUnit = positiveInteger(`${prefix}_RATE`, defaults.rate);
  const preAllocatedVus = positiveInteger(`${prefix}_PRE_ALLOCATED_VUS`, Math.max(vus, defaults.preAllocatedVUs));
  const maxVus = positiveInteger(`${prefix}_MAX_VUS`, Math.max(vus, preAllocatedVus, defaults.maxVUs));
  const stages = parseStages(`${prefix}_STAGES`);
  const stageMax = Math.max(0, ...stages.map((stage) => stage.target));

  return {
    executor,
    requestPrefix: optional(`${prefix}_REQUEST_PREFIX`, defaults.requestPrefix),
    requestIdBase: '',
    stepPrefix: defaults.stepPrefix,
    timeoutSeconds: positiveNumber(`${prefix}_TIMEOUT_SECONDS`, defaults.timeoutSeconds),
    setupTimeout: optional(`${prefix}_SETUP_TIMEOUT`, defaults.setupTimeout),
    vus,
    rate: ratePerTimeUnit,
    timeUnit: optional(`${prefix}_TIME_UNIT`, defaults.timeUnit),
    preAllocatedVUs: preAllocatedVus,
    maxVUs: maxVus,
    plannedMaxVus: Math.max(vus, maxVus, stageMax),
    duration: optional(`${prefix}_DURATION`, defaults.duration),
    stages,
    gracefulStop: optional(`${prefix}_GRACEFUL_STOP`, defaults.gracefulStop),
    thinkTimeSeconds: nonNegativeNumber(`${prefix}_THINK_TIME_SECONDS`, defaults.thinkTimeSeconds),
    activeCustomerCount: positiveInteger(`${prefix}_ACTIVE_CUSTOMER_COUNT`, defaults.activeCustomerCount),
    maxSeatAttempts: positiveInteger(`${prefix}_MAX_SEAT_ATTEMPTS`, defaults.maxSeatAttempts),
    concertLimit: positiveInteger(`${prefix}_CONCERT_LIMIT`, defaults.concertLimit),
    performanceLimit: positiveInteger(`${prefix}_PERFORMANCE_LIMIT`, defaults.performanceLimit),
    seatLimit: positiveInteger(`${prefix}_SEAT_LIMIT`, defaults.seatLimit),
    seatCandidateCount: positiveInteger(`${prefix}_SEAT_CANDIDATE_COUNT`, defaults.seatCandidateCount),
    seatSelectionMode: defaults.seatSelectionMode,
    allowReservationConflicts: defaults.allowReservationConflicts,
    thresholds: {
      httpReqFailedRate: rate(`${prefix}_THRESHOLD_HTTP_REQ_FAILED_RATE`, defaults.thresholds.httpReqFailedRate),
      httpReqDurationP95Ms: positiveNumber(`${prefix}_THRESHOLD_HTTP_REQ_DURATION_P95_MS`, defaults.thresholds.httpReqDurationP95Ms),
      httpReqDurationP99Ms: positiveNumber(`${prefix}_THRESHOLD_HTTP_REQ_DURATION_P99_MS`, defaults.thresholds.httpReqDurationP99Ms),
      checksRate: rate(`${prefix}_THRESHOLD_CHECKS_RATE`, defaults.thresholds.checksRate),
      reservationHandledRate: rate(`${prefix}_THRESHOLD_HANDLED_RATE`, defaults.thresholds.reservationHandledRate),
      reservationCreatedRate: rate(`${prefix}_THRESHOLD_CREATED_RATE`, defaults.thresholds.reservationCreatedRate),
      reservationInfraFailureRate: rate(`${prefix}_THRESHOLD_INFRA_FAILURE_RATE`, defaults.thresholds.reservationInfraFailureRate),
    },
  };
}

export function getReservationCreateConfig() {
  return reservationLoadConfig('LOADTEST_RESERVATION_CREATE', {
    requestPrefix: 'loadtest-reservation-create',
    stepPrefix: 'reservation_create',
    executor: 'ramping-vus',
    timeoutSeconds: 10,
    setupTimeout: '10m',
    vus: 5,
    rate: 1,
    timeUnit: '1s',
    preAllocatedVUs: 10,
    maxVUs: 20,
    duration: '2m',
    gracefulStop: '30s',
    thinkTimeSeconds: 0,
    activeCustomerCount: 100,
    maxSeatAttempts: 3,
    concertLimit: 50,
    performanceLimit: 50,
    seatLimit: 200,
    seatCandidateCount: 200,
    seatSelectionMode: 'distributed_available',
    allowReservationConflicts: false,
    thresholds: {
      httpReqFailedRate: 0.01,
      httpReqDurationP95Ms: 500,
      httpReqDurationP99Ms: 1000,
      checksRate: 0.99,
      reservationHandledRate: 0.99,
      reservationCreatedRate: 0.99,
      reservationInfraFailureRate: 0.01,
    },
  });
}

export function getReservationSeatContentionConfig() {
  return reservationLoadConfig('LOADTEST_RESERVATION_SEAT_CONTENTION', {
    requestPrefix: 'loadtest-reservation-contention',
    stepPrefix: 'reservation_seat_contention',
    executor: 'ramping-arrival-rate',
    timeoutSeconds: 10,
    setupTimeout: '10m',
    vus: 5,
    rate: 1,
    timeUnit: '1s',
    preAllocatedVUs: 10,
    maxVUs: 20,
    duration: '2m',
    gracefulStop: '30s',
    thinkTimeSeconds: 0,
    activeCustomerCount: 100,
    maxSeatAttempts: 1,
    concertLimit: 10,
    performanceLimit: 10,
    seatLimit: 50,
    seatCandidateCount: 5,
    seatSelectionMode: 'single_showtime_small_candidate_pool',
    allowReservationConflicts: true,
    thresholds: {
      httpReqFailedRate: 0.05,
      httpReqDurationP95Ms: 750,
      httpReqDurationP99Ms: 1500,
      checksRate: 0.95,
      reservationHandledRate: 0.95,
      reservationCreatedRate: 0.0001,
      reservationInfraFailureRate: 0.01,
    },
  });
}
