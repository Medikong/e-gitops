import http from 'k6/http';
import { check, fail, group, sleep } from 'k6';
import { Rate } from 'k6/metrics';

import { getConfig, requireCustomerPool } from '../lib/config.js';
import { customerPoolAccount, customerPoolIndexForIteration } from '../lib/customer-pool.js';
import { httpStepThresholds, RESERVATION_JOURNEY_STEPS } from '../lib/http-metrics.js';
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
  approvePayment,
  createReservationWithSeatRetry,
  selectReservationTarget,
  waitForTicket,
} from '../flows/reservation-journey.js';

const config = getConfig();
const journeySuccess = new Rate('loadtest_reservation_journey_success');
const reservationConflictRate = new Rate('loadtest_reservation_conflict_rate');
const ticketIssuedRate = new Rate('loadtest_ticket_issued_rate');
const PRE_LOGIN_STEP = 'reservation_journey.setup.pre_login';

function iterationConfig() {
  const iterationId = `${Date.now()}-${__VU}-${__ITER}`;
  const customerIndex = customerPoolIndexForIteration(config, __VU, __ITER);
  return {
    ...config,
    iterationId,
    requestIdBase: `${config.requestPrefix}-${config.scenario}-${iterationId}`,
    customer: {
      ...customerPoolAccount(config, customerIndex),
      index: customerIndex,
    },
  };
}

function executorConfig() {
  if (config.executor === 'ramping-arrival-rate') {
    if (config.stages.length === 0) {
      throw new Error('LOADTEST_RESERVATION_JOURNEY_STAGES is required for ramping-arrival-rate');
    }
    return {
      executor: 'ramping-arrival-rate',
      timeUnit: config.timeUnit,
      preAllocatedVUs: config.preAllocatedVUs,
      maxVUs: config.maxVUs,
      stages: config.stages,
      gracefulStop: config.gracefulStop,
    };
  }
  if (config.executor === 'constant-arrival-rate') {
    return {
      executor: 'constant-arrival-rate',
      rate: config.rate,
      timeUnit: config.timeUnit,
      duration: config.duration,
      preAllocatedVUs: config.preAllocatedVUs,
      maxVUs: config.maxVUs,
      gracefulStop: config.gracefulStop,
    };
  }
  if (config.executor === 'ramping-vus') {
    if (config.stages.length === 0) {
      throw new Error('LOADTEST_RESERVATION_JOURNEY_STAGES is required for ramping-vus');
    }
    return {
      executor: 'ramping-vus',
      stages: config.stages,
      gracefulStop: config.gracefulStop,
    };
  }
  return {
    executor: 'constant-vus',
    vus: config.vus,
    duration: config.duration,
    gracefulStop: config.gracefulStop,
  };
}

function pauseBetweenIterations(runConfig) {
  if (runConfig.thinkTimeSeconds > 0) {
    sleep(runConfig.thinkTimeSeconds);
  }
}

function preLoginTags(runConfig) {
  return {
    environment: runConfig.environment,
    profile: runConfig.dataset.profile,
    test_type: runConfig.testType,
    target: runConfig.target,
    phase: 'setup',
  };
}

function preLoginCustomer(runConfig, account) {
  const payload = JSON.stringify({
    email: account.email,
    password: account.password,
  });
  const response = http.request('POST', `${runConfig.baseUrl}/auth/login`, payload, {
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Loadtest-Traffic': 'true',
    },
    responseCallback: http.expectedStatuses(200),
    timeout: `${runConfig.timeoutSeconds}s`,
    tags: {
      ...preLoginTags(runConfig),
      name: 'POST /auth/login',
      route: 'POST /auth/login',
      service: 'auth-service',
    },
  });

  const ok = check(response, {
    'reservation journey pre-login returned 200': (res) => res.status === 200,
    'reservation journey pre-login returned json': (res) => String(res.headers['Content-Type'] || res.headers['content-type'] || '').includes('application/json'),
  }, preLoginTags(runConfig));
  if (!ok) {
    fail(`${PRE_LOGIN_STEP} failed with status ${response.status}`);
  }

  try {
    return response.json();
  } catch (error) {
    fail(`${PRE_LOGIN_STEP} returned invalid json: ${error.message}`);
  }
  return null;
}

function customerTokenFromAuth(index, auth) {
  const user = requireField(auth, 'user', PRE_LOGIN_STEP);
  if (requireField(user, 'role', PRE_LOGIN_STEP) !== 'CUSTOMER') {
    fail(`${PRE_LOGIN_STEP} returned non-CUSTOMER user`);
  }
  return {
    customerIndex: index,
    customerId: requireField(user, 'id', PRE_LOGIN_STEP),
    accessToken: requireField(auth, 'accessToken', PRE_LOGIN_STEP),
  };
}

function prepareCustomerTokens(runConfig) {
  const customerTokens = [];
  for (let index = 0; index < runConfig.customerPool.size; index += 1) {
    const account = customerPoolAccount(runConfig, index);
    customerTokens.push(customerTokenFromAuth(index, preLoginCustomer(runConfig, account)));
  }
  return customerTokens;
}

function customerTokenForIteration(setupData, customerIndex) {
  const tokens = setupData && Array.isArray(setupData.customerTokens) ? setupData.customerTokens : [];
  const token = tokens[customerIndex];
  if (!token || token.customerIndex !== customerIndex || !token.customerId || !token.accessToken) {
    fail(`reservation_journey.setup.pre_login did not prepare a token for customer index ${customerIndex}`);
  }
  return token;
}

function stateFromTarget(target) {
  return {
    concertId: target.concertId,
    performanceId: target.performanceId,
    showtimeId: target.showtimeId,
    seatId: target.seatId,
    seatCount: target.seatCount,
  };
}

export const options = {
  setupTimeout: config.setupTimeout,
  scenarios: {
    [config.scenario]: {
      ...executorConfig(),
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
    loadtest_reservation_journey_success: [`rate>${config.thresholds.reservationJourneySuccessRate}`],
    loadtest_reservation_conflict_rate: [`rate<${config.thresholds.reservationConflictRate}`],
    loadtest_ticket_issued_rate: [`rate>${config.thresholds.ticketIssuedRate}`],
    ...httpStepThresholds(RESERVATION_JOURNEY_STEPS, config.thresholds),
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
  logExperimentConditions(config, 'reservation_journey_setup');
  const customerTokens = prepareCustomerTokens(config);
  logExperimentConditions(config, 'reservation_journey_measurement');
  return { customerTokens };
}

export default function reservationJourneyLoadTest(setupData) {
  const runConfig = iterationConfig();
  const customerToken = customerTokenForIteration(setupData, runConfig.customer.index);
  const state = {
    customerId: customerToken.customerId,
    customerToken: customerToken.accessToken,
  };
  let step = 'init';
  let conflictMetricRecorded = false;
  let ticketMetricRecorded = false;

  logRunStarted(runConfig);
  try {
    group('catalog.select_seat', () => {
      step = 'reservation_journey.catalog.select_seat';
      const target = selectReservationTarget(runConfig, 0);
      Object.assign(state, stateFromTarget(target));
      logJourneyStep(runConfig, step, 'success', state);
    });

    group('reservation.create', () => {
      step = 'reservation_journey.reservation.create';
      const result = createReservationWithSeatRetry(
        runConfig,
        state.customerToken,
        (attempt) => {
          const target = attempt === 0 ? state : selectReservationTarget(runConfig, attempt);
          Object.assign(state, stateFromTarget(target));
          return target;
        },
        (isConflict) => {
          reservationConflictRate.add(isConflict);
          conflictMetricRecorded = true;
          if (isConflict) {
            logJourneyStep(runConfig, step, 'conflict', state);
          }
        },
      );
      Object.assign(state, stateFromTarget(result.target));
      state.reservationId = requireField(result.reservation, 'id', step);
      logJourneyStep(runConfig, step, 'success', state);
    });

    group('payment.approve', () => {
      step = 'reservation_journey.payment.approve';
      const payment = approvePayment(
        runConfig,
        state.customerToken,
        { id: state.reservationId },
        state,
      );
      state.paymentId = requireField(payment, 'id', step);
      logJourneyStep(runConfig, step, 'success', state);
    });

    group('ticket.wait', () => {
      step = 'reservation_journey.ticket.list';
      const ticket = waitForTicket(runConfig, state.customerToken, { id: state.reservationId });
      state.ticketId = requireField(ticket, 'id', step);
      ticketIssuedRate.add(true);
      ticketMetricRecorded = true;
      logJourneyStep(runConfig, step, 'success', state);
    });

    journeySuccess.add(true);
    logRunFinished(runConfig, state);
  } catch (error) {
    journeySuccess.add(false);
    if (!conflictMetricRecorded) {
      reservationConflictRate.add(false);
    }
    if (!ticketMetricRecorded) {
      ticketIssuedRate.add(false);
    }
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
