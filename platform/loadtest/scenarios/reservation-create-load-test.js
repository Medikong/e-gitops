import { fail, group } from 'k6';
import { Counter, Rate } from 'k6/metrics';

import { getConfig, requireCustomerPool, requireDatasetCredentials } from '../lib/config.js';
import { httpStepThresholds, RESERVATION_CREATE_STEPS } from '../lib/http-metrics.js';
import {
  logExperimentConditions,
  logJourneyStep,
  logRunFailed,
  logRunFinished,
  logRunStarted,
} from '../lib/log.js';
import { requireField } from '../lib/pick.js';
import { summaryOutput } from '../lib/report.js';
import {
  createReservationAttempt,
  selectReservationTarget,
} from '../flows/reservation-journey.js';
import {
  customerTokenForIteration,
  executorConfig,
  iterationConfig,
  pauseBetweenIterations,
  prepareCustomerTokens,
  prepareRunScopedDataset,
  runScopedConfig,
} from '../flows/reservation-load-setup.js';

const config = getConfig();
const reservationHandledRate = new Rate('loadtest_reservation_handled_rate');
const reservationCreatedRate = new Rate('loadtest_reservation_created_rate');
const reservationInfraFailureRate = new Rate('loadtest_reservation_infra_failure_rate');
const reservationCreate201Rate = new Rate('loadtest_reservation_create_201_rate');
const reservationCreate409Rate = new Rate('loadtest_reservation_create_409_rate');
const reservationCreate5xxRate = new Rate('loadtest_reservation_create_5xx_rate');
const reservationCreateTimeoutRate = new Rate('loadtest_reservation_create_timeout_rate');
const reservationCreate201Count = new Counter('loadtest_reservation_create_201_count');
const reservationCreate409Count = new Counter('loadtest_reservation_create_409_count');
const reservationCreate5xxCount = new Counter('loadtest_reservation_create_5xx_count');
const reservationCreateTimeoutCount = new Counter('loadtest_reservation_create_timeout_count');
const PRE_LOGIN_STEP = 'reservation_create.setup.pre_login';
const RESERVATION_CREATE_STEP = 'reservation_create.reservation.create';

function stateFromTarget(target) {
  return {
    concertId: target.concertId,
    performanceId: target.performanceId,
    showtimeId: target.showtimeId,
    seatId: target.seatId,
    seatCount: target.seatCount,
    seatCandidateCount: target.seatCandidateCount,
  };
}

function metricTags(runConfig) {
  return {
    environment: runConfig.environment,
    profile: runConfig.dataset.profile,
    test_type: runConfig.testType,
    target: runConfig.target,
    step: RESERVATION_CREATE_STEP,
  };
}

function recordReservationStatus(runConfig, status) {
  const tags = metricTags(runConfig);
  const is201 = status === 201;
  const is409 = status === 409;
  const isTimeout = status === 0;
  const is5xx = status >= 500 && status < 600;

  reservationCreate201Rate.add(is201, tags);
  reservationCreate409Rate.add(is409, tags);
  reservationCreate5xxRate.add(is5xx, tags);
  reservationCreateTimeoutRate.add(isTimeout, tags);
  if (is201) {
    reservationCreate201Count.add(1, tags);
  }
  if (is409) {
    reservationCreate409Count.add(1, tags);
  }
  if (is5xx) {
    reservationCreate5xxCount.add(1, tags);
  }
  if (isTimeout) {
    reservationCreateTimeoutCount.add(1, tags);
  }
}

function parseCreatedReservation(response) {
  let body;
  try {
    body = response.json();
  } catch (error) {
    fail(`${RESERVATION_CREATE_STEP} returned invalid json: ${error.message}`);
  }
  requireField(body, 'id', RESERVATION_CREATE_STEP);
  return body;
}

function createReservationWithRetry(runConfig, customerToken, state) {
  for (let attempt = 0; attempt < runConfig.maxSeatAttempts; attempt += 1) {
    const target = attempt === 0 ? state : selectReservationTarget(runConfig, attempt);
    Object.assign(state, stateFromTarget(target));
    const response = createReservationAttempt(runConfig, customerToken, target);
    recordReservationStatus(runConfig, response.status);

    if (response.status === 201) {
      return parseCreatedReservation(response);
    }
    if (response.status === 409) {
      logJourneyStep(runConfig, RESERVATION_CREATE_STEP, 'conflict', state);
      continue;
    }
    if (response.status === 0) {
      state.failureClass = 'timeout';
      fail(`${RESERVATION_CREATE_STEP} timed out`);
    }
    if (response.status >= 500 && response.status < 600) {
      state.failureClass = '5xx';
      fail(`${RESERVATION_CREATE_STEP} failed with infrastructure status ${response.status}`);
    }
    state.failureClass = 'unexpected_status';
    fail(`${RESERVATION_CREATE_STEP} returned unexpected status ${response.status}`);
  }
  state.failureClass = 'conflict_exhausted';
  fail(`${RESERVATION_CREATE_STEP} exhausted ${runConfig.maxSeatAttempts} seat attempts`);
  return null;
}

export const options = {
  setupTimeout: config.setupTimeout,
  scenarios: {
    [config.scenario]: {
      ...executorConfig(config, 'LOADTEST_RESERVATION_CREATE'),
      tags: {
        environment: config.environment,
        profile: config.dataset.profile,
        test_type: config.testType,
        target: config.target,
      },
    },
  },
  thresholds: {
    http_req_failed: [`rate<${config.thresholds.httpReqFailedRate}`],
    http_req_duration: [
      `p(95)<${config.thresholds.httpReqDurationP95Ms}`,
      `p(99)<${config.thresholds.httpReqDurationP99Ms}`,
    ],
    checks: [`rate>${config.thresholds.checksRate}`],
    loadtest_reservation_handled_rate: [`rate>${config.thresholds.reservationHandledRate}`],
    loadtest_reservation_created_rate: [`rate>${config.thresholds.reservationCreatedRate}`],
    loadtest_reservation_infra_failure_rate: [`rate<${config.thresholds.reservationInfraFailureRate}`],
    ...httpStepThresholds(RESERVATION_CREATE_STEPS, config.thresholds),
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  tags: {
    environment: config.environment,
    profile: config.dataset.profile,
    test_type: config.testType,
    target: config.target,
  },
};

export function setup() {
  requireCustomerPool(config);
  const setupConfig = runScopedConfig(config);
  logExperimentConditions(setupConfig, 'reservation_create_setup');
  const datasetState = prepareRunScopedDataset(setupConfig, requireDatasetCredentials);
  const { customerTokens, state } = prepareCustomerTokens(setupConfig, PRE_LOGIN_STEP);
  logExperimentConditions(setupConfig, 'reservation_create_measurement');
  return {
    customerTokens,
    customerState: state,
    datasetState,
    datasetRevision: setupConfig.dataset.revision,
  };
}

export default function reservationCreateLoadTest(setupData) {
  const runConfig = iterationConfig(config, setupData);
  const customerToken = customerTokenForIteration(setupData, runConfig.customer.index, PRE_LOGIN_STEP);
  const state = {
    customerId: customerToken.customerId,
    customerToken: customerToken.accessToken,
  };
  let step = 'init';

  logRunStarted(runConfig);
  try {
    group('catalog.select_seat', () => {
      step = 'reservation_create.catalog.select_seat';
      const target = selectReservationTarget(runConfig, 0);
      Object.assign(state, stateFromTarget(target));
      logJourneyStep(runConfig, step, 'success', state);
    });

    group('reservation.create', () => {
      step = RESERVATION_CREATE_STEP;
      const reservation = createReservationWithRetry(runConfig, state.customerToken, state);
      state.reservationId = requireField(reservation, 'id', step);
      logJourneyStep(runConfig, step, 'success', state);
    });

    reservationHandledRate.add(true);
    reservationCreatedRate.add(true);
    reservationInfraFailureRate.add(false);
    logRunFinished(runConfig, state);
  } catch (error) {
    reservationHandledRate.add(false);
    reservationCreatedRate.add(false);
    reservationInfraFailureRate.add(state.failureClass === 'timeout' || state.failureClass === '5xx');
    logJourneyStep(runConfig, step, 'failed', state);
    logRunFailed(runConfig, step, error, state);
    throw error;
  } finally {
    pauseBetweenIterations(runConfig);
  }
}

export function handleSummary(data) {
  return summaryOutput(config, data);
}
