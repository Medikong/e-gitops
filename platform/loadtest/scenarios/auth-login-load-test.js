import http from 'k6/http';
import { check, fail, group, sleep } from 'k6';
import { Rate } from 'k6/metrics';

import { loginWithCredentials } from '../lib/auth.js';
import { getConfig } from '../lib/config.js';
import { customerPoolAccount, customerPoolIndexForIteration } from '../lib/customer-pool.js';
import { AUTH_LOGIN_STEPS, httpStepThresholds } from '../lib/http-metrics.js';
import {
  logAuthLoginAccountPoolPrepared,
  logExperimentConditions,
  logRunFailed,
  logRunFinished,
  logRunStarted,
} from '../lib/log.js';
import { requireField } from '../lib/pick.js';
import { summaryOutput } from '../lib/report.js';

const config = getConfig();
const authLoginSuccess = new Rate('loadtest_auth_login_success');

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
      throw new Error('LOADTEST_AUTH_LOGIN_STAGES is required for ramping-arrival-rate');
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
      throw new Error('LOADTEST_AUTH_LOGIN_STAGES is required for ramping-vus');
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

function setupTags(runConfig) {
  return {
    environment: runConfig.environment,
    profile: runConfig.dataset.profile,
    test_type: runConfig.testType,
    target: runConfig.target,
    phase: 'setup',
  };
}

function setupRequestJson(runConfig, method, path, body, expectedStatuses) {
  const payload = body === null || body === undefined ? null : JSON.stringify(body);
  const response = http.request(method, `${runConfig.baseUrl}${path}`, payload, {
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Loadtest-Traffic': 'true',
    },
    responseCallback: http.expectedStatuses(...expectedStatuses),
    timeout: `${runConfig.timeoutSeconds}s`,
    tags: setupTags(runConfig),
  });

  const ok = check(response, {
    'auth login account setup returned expected status': (res) => expectedStatuses.includes(res.status),
    'auth login account setup returned json': (res) => String(res.headers['Content-Type'] || res.headers['content-type'] || '').includes('application/json'),
  }, setupTags(runConfig));
  if (!ok) {
    fail(`auth login account setup failed with status ${response.status}`);
  }

  try {
    return {
      status: response.status,
      body: response.json(),
    };
  } catch (error) {
    fail(`auth login account setup returned invalid json: ${error.message}`);
  }
  return null;
}

function verifyCustomerToken(body, step) {
  const user = requireField(body, 'user', step);
  if (requireField(user, 'role', step) !== 'CUSTOMER') {
    fail(`${step} returned non-CUSTOMER user`);
  }
  requireField(body, 'accessToken', step);
}

function signupOrVerifyAccount(runConfig, index) {
  const account = customerPoolAccount(runConfig, index);
  const signup = setupRequestJson(
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
    verifyCustomerToken(signup.body, 'auth_login.account_signup');
    return { created: true };
  }

  const login = setupRequestJson(
    runConfig,
    'POST',
    '/auth/login',
    {
      email: account.email,
      password: account.password,
    },
    [200],
  );
  verifyCustomerToken(login.body, 'auth_login.account_login_verify');
  return { created: false };
}

function requirePreparedAccountCapacity(runConfig) {
  if (!runConfig.customerPool.password) {
    throw new Error('LOADTEST_CUSTOMER_POOL_PASSWORD is required for auth login loadtest');
  }
  if (runConfig.customerPool.size < runConfig.plannedMaxVus) {
    throw new Error('LOADTEST_CUSTOMER_POOL_SIZE must be greater than or equal to the planned max VUs');
  }
}

function pauseBetweenIterations(runConfig) {
  if (runConfig.thinkTimeSeconds > 0) {
    sleep(runConfig.thinkTimeSeconds);
  }
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
    loadtest_auth_login_success: [`rate>${config.thresholds.authLoginSuccessRate}`],
    ...httpStepThresholds(AUTH_LOGIN_STEPS, config.thresholds),
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
  requirePreparedAccountCapacity(config);
  logExperimentConditions(config, 'auth_login_setup');
  const state = {
    createdCustomers: 0,
    reusedCustomers: 0,
    verifiedCustomers: 0,
  };

  for (let index = 0; index < config.customerPool.size; index += 1) {
    const result = signupOrVerifyAccount(config, index);
    if (result.created) {
      state.createdCustomers += 1;
    } else {
      state.reusedCustomers += 1;
    }
    state.verifiedCustomers += 1;
  }

  logAuthLoginAccountPoolPrepared(config, state);
  logExperimentConditions(config, 'auth_login_measurement');
  return { preparedCustomers: state.verifiedCustomers };
}

export default function authLoginLoadTest() {
  const runConfig = iterationConfig();
  logRunStarted(runConfig);

  try {
    group('POST /auth/login', () => {
      const auth = loginWithCredentials(
        runConfig,
        'auth_login.login',
        runConfig.customer.email,
        runConfig.customer.password,
      );
      requireField(auth, 'accessToken', 'auth_login.login');
      authLoginSuccess.add(true);
    });
    logRunFinished(runConfig);
  } catch (error) {
    authLoginSuccess.add(false);
    logRunFailed(runConfig, 'auth_login.login', error);
    throw error;
  } finally {
    pauseBetweenIterations(runConfig);
  }
}

export function handleSummary(data) {
  return summaryOutput(config, data);
}
