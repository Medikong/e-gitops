import http from 'k6/http';
import { check, fail, group, sleep } from 'k6';
import { Counter, Rate } from 'k6/metrics';

import { loginAdmin, loginProvider } from '../lib/auth.js';
import { getConfig, requireCustomerPool, requireDatasetCredentials } from '../lib/config.js';
import { activeCustomerCount, customerPoolAccount, customerPoolIndexForIteration } from '../lib/customer-pool.js';
import {
  httpStageThresholds,
  httpStepThresholds,
  loadStageForElapsed,
  loadStageId,
  RESERVATION_JOURNEY_STEPS,
  serviceLabel,
} from '../lib/http-metrics.js';
import {
  logDatasetFinished,
  logExperimentConditions,
  logJourneyStep,
  logRunFailed,
  logRunFinished,
  logRunStarted,
} from '../lib/log.js';
import { requireField } from '../lib/pick.js';
import { summaryOutput } from '../lib/report.js';
import { observeScaleOut, scaleOutOptions, setupScaleOutBaselines } from '../lib/scale-out.js';
import {
  approvePayment,
  createReservationWithSeatRetry,
  selectReservationTarget,
  waitForTicket,
} from '../flows/reservation-journey.js';
import { setupReadApiBasicDataset } from '../flows/datasets/read-api-basic.js';

const config = getConfig();
const journeySuccess = new Rate('loadtest_reservation_journey_success');
const reservationConflictRate = new Rate('loadtest_reservation_conflict_rate');
const ticketIssuedRate = new Rate('loadtest_ticket_issued_rate');
const reservationCreate201Rate = new Rate('loadtest_reservation_create_201_rate');
const reservationCreate409Rate = new Rate('loadtest_reservation_create_409_rate');
const reservationCreate5xxRate = new Rate('loadtest_reservation_create_5xx_rate');
const reservationCreateTimeoutRate = new Rate('loadtest_reservation_create_timeout_rate');
const reservationCreate201Count = new Counter('loadtest_reservation_create_201_count');
const reservationCreate409Count = new Counter('loadtest_reservation_create_409_count');
const reservationCreate5xxCount = new Counter('loadtest_reservation_create_5xx_count');
const reservationCreateTimeoutCount = new Counter('loadtest_reservation_create_timeout_count');
const PRE_LOGIN_STEP = 'reservation_journey.setup.pre_login';
const RESERVATION_CREATE_STEP = 'reservation_journey.reservation.create';

function measurementElapsedSeconds(setupData) {
  if (!setupData || !setupData.measurementStartedAtMs) {
    return 0;
  }
  return Math.max(0, (Date.now() - setupData.measurementStartedAtMs) / 1000);
}

function iterationConfig(setupData) {
  const datasetRevision = setupData && setupData.datasetRevision ? setupData.datasetRevision : config.dataset.revision;
  const runBaseConfig = {
    ...config,
    dataset: {
      ...config.dataset,
      revision: datasetRevision,
    },
  };
  const iterationId = `${Date.now()}-${__VU}-${__ITER}`;
  const customerIndex = customerPoolIndexForIteration(runBaseConfig, __VU, __ITER);
  const loadStage = loadStageForElapsed(runBaseConfig.stages, measurementElapsedSeconds(setupData));
  return {
    ...runBaseConfig,
    loadStage,
    iterationId,
    requestIdBase: `${config.requestPrefix}-${config.scenario}-${iterationId}`,
    customer: {
      index: customerIndex,
    },
  };
}

function metricTags(runConfig) {
  return {
    environment: runConfig.environment,
    profile: runConfig.dataset.profile,
    test_type: runConfig.testType,
    target: runConfig.target,
    step: RESERVATION_CREATE_STEP,
    ...(runConfig.loadStage ? {
      load_stage: runConfig.loadStage.id,
      load_stage_label: runConfig.loadStage.label,
      load_stage_target: String(runConfig.loadStage.target),
    } : {}),
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

function reservationCreateStageThresholds(stages) {
  const result = {};
  for (let index = 0; index < (stages || []).length; index += 1) {
    const stageId = loadStageId(stages[index], index);
    result[`loadtest_reservation_create_5xx_rate{load_stage:${stageId}}`] = ['rate>=0'];
    result[`loadtest_reservation_create_timeout_rate{load_stage:${stageId}}`] = ['rate>=0'];
  }
  return result;
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

function setupAuthRequestJson(runConfig, method, path, body, expectedStatuses) {
  const payload = body === null || body === undefined ? null : JSON.stringify(body);
  const route = `${method} ${path}`;
  const service = serviceLabel(PRE_LOGIN_STEP);
  const response = http.request(method, `${runConfig.baseUrl}${path}`, payload, {
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Loadtest-Traffic': 'true',
    },
    responseCallback: http.expectedStatuses(...expectedStatuses),
    timeout: `${runConfig.timeoutSeconds}s`,
    tags: {
      ...preLoginTags(runConfig),
      name: route,
      route,
      service,
      step: PRE_LOGIN_STEP,
    },
  });

  const ok = check(response, {
    'reservation journey setup auth returned expected status': (res) => expectedStatuses.includes(res.status),
    'reservation journey setup auth returned json': (res) => String(res.headers['Content-Type'] || res.headers['content-type'] || '').includes('application/json'),
  }, {
    ...preLoginTags(runConfig),
    route,
    service,
    step: PRE_LOGIN_STEP,
  });
  if (!ok) {
    fail(`${PRE_LOGIN_STEP} ${method} ${path} failed with status ${response.status}`);
  }

  try {
    return {
      status: response.status,
      body: response.json(),
    };
  } catch (error) {
    fail(`${PRE_LOGIN_STEP} ${method} ${path} returned invalid json: ${error.message}`);
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

function runScopedConfig(runConfig) {
  const runToken = String(runConfig.runId || 'run')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(-24) || 'run';
  const datasetRevision = `${runConfig.dataset.revision}-${runToken}`;
  return {
    ...runConfig,
    dataset: {
      ...runConfig.dataset,
      revision: datasetRevision,
    },
    customerPool: {
      ...runConfig.customerPool,
      revision: datasetRevision,
    },
  };
}

function prepareRunScopedDataset(runConfig) {
  requireDatasetCredentials(runConfig);
  const tokens = {};
  group('dataset.auth', () => {
    tokens.provider = loginProvider(runConfig).accessToken;
    tokens.admin = loginAdmin(runConfig).accessToken;
  });
  const state = {};
  group('dataset.setup', () => {
    Object.assign(state, setupReadApiBasicDataset(runConfig, tokens));
  });
  logDatasetFinished(runConfig, state);
  return state;
}

function signupOrLoginCustomer(runConfig, index) {
  const account = customerPoolAccount(runConfig, index);
  const signup = setupAuthRequestJson(
    runConfig,
    'POST',
    '/auth/signup',
    {
      email: account.email,
      password: account.password,
      displayName: account.displayName,
    },
    [201, 409],
  );

  if (signup.status === 201) {
    return { created: true, token: customerTokenFromAuth(index, signup.body) };
  }

  const login = setupAuthRequestJson(
    runConfig,
    'POST',
    '/auth/login',
    {
      email: account.email,
      password: account.password,
    },
    [200],
  );
  return { created: false, token: customerTokenFromAuth(index, login.body) };
}

function prepareCustomerTokens(runConfig) {
  const customerTokens = [];
  const activeCount = activeCustomerCount(runConfig);
  const state = {
    createdCustomers: 0,
    reusedCustomers: 0,
    verifiedCustomers: 0,
    activeCustomers: activeCount,
  };
  for (let index = 0; index < runConfig.customerPool.size; index += 1) {
    const result = signupOrLoginCustomer(runConfig, index);
    if (result.created) {
      state.createdCustomers += 1;
    } else {
      state.reusedCustomers += 1;
    }
    state.verifiedCustomers += 1;
    if (index < activeCount) {
      customerTokens.push(result.token);
    }
  }
  return { customerTokens, state };
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
  ...scaleOutOptions(config),
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
    ...httpStepThresholds([PRE_LOGIN_STEP, ...RESERVATION_JOURNEY_STEPS], config.thresholds),
    ...httpStageThresholds(config.executor === 'ramping-arrival-rate' ? config.stages : [], config.thresholds),
    ...reservationCreateStageThresholds(config.executor === 'ramping-arrival-rate' ? config.stages : []),
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
  logExperimentConditions(setupConfig, 'reservation_journey_setup');
  const datasetState = prepareRunScopedDataset(setupConfig);
  const { customerTokens, state } = prepareCustomerTokens(setupConfig);
  logExperimentConditions(setupConfig, 'reservation_journey_measurement');
  return {
    customerTokens,
    customerState: state,
    datasetState,
    datasetRevision: setupConfig.dataset.revision,
    measurementStartedAtMs: Date.now(),
    scaleOutBaselines: setupScaleOutBaselines(setupConfig),
  };
}

export default function reservationJourneyLoadTest(setupData) {
  const runConfig = iterationConfig(setupData);
  const customerToken = customerTokenForIteration(setupData, runConfig.customer.index);
  const state = {
    customerId: customerToken.customerId,
    customerToken: customerToken.accessToken,
  };
  let step = 'init';
  let conflictMetricRecorded = false;
  let ticketMetricRecorded = false;

  observeScaleOut(runConfig, setupData, __ITER);
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
        (isConflict, status) => {
          recordReservationStatus(runConfig, status);
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
