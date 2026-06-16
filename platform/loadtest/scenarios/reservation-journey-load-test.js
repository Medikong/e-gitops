import { group, sleep } from 'k6';
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
  loginCustomer,
  selectReservationTarget,
  waitForTicket,
} from '../flows/reservation-journey.js';

const config = getConfig();
const journeySuccess = new Rate('loadtest_reservation_journey_success');
const reservationConflictRate = new Rate('loadtest_reservation_conflict_rate');
const ticketIssuedRate = new Rate('loadtest_ticket_issued_rate');

function iterationConfig() {
  const runId = `${Date.now()}-${__VU}-${__ITER}`;
  const customerIndex = customerPoolIndexForIteration(config, __VU, __ITER);
  return {
    ...config,
    runId,
    requestIdBase: `${config.requestPrefix}-${config.scenario}-${runId}`,
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
  logExperimentConditions(config, 'reservation_journey');
  return {};
}

export default function reservationJourneyLoadTest() {
  const runConfig = iterationConfig();
  const state = {};
  let step = 'init';
  let conflictMetricRecorded = false;
  let ticketMetricRecorded = false;

  logRunStarted(runConfig);
  try {
    group('auth.login', () => {
      step = 'reservation_journey.auth.login';
      const auth = loginCustomer(runConfig, runConfig.customer);
      state.customerId = requireField(auth.user, 'id', step);
      state.customerToken = auth.accessToken;
      logJourneyStep(runConfig, step, 'success', state);
    });

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
