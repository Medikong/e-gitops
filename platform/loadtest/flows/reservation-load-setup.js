import http from 'k6/http';
import { check, fail, group, sleep } from 'k6';

import { loginAdmin, loginProvider } from '../lib/auth.js';
import { activeCustomerCount, customerPoolAccount, customerPoolIndexForIteration } from '../lib/customer-pool.js';
import { serviceLabel } from '../lib/http-metrics.js';
import { logDatasetFinished } from '../lib/log.js';
import { requireField } from '../lib/pick.js';
import { setupReadApiBasicDataset } from './datasets/read-api-basic.js';

export function executorConfig(config, envPrefix) {
  if (config.executor === 'ramping-arrival-rate') {
    if (config.stages.length === 0) {
      throw new Error(`${envPrefix}_STAGES is required for ramping-arrival-rate`);
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
      throw new Error(`${envPrefix}_STAGES is required for ramping-vus`);
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

export function iterationConfig(config, setupData) {
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
  return {
    ...runBaseConfig,
    iterationId,
    requestIdBase: `${config.requestPrefix}-${config.scenario}-${iterationId}`,
    customer: {
      index: customerIndex,
    },
  };
}

export function pauseBetweenIterations(runConfig) {
  if (runConfig.thinkTimeSeconds > 0) {
    sleep(runConfig.thinkTimeSeconds);
  }
}

export function runScopedConfig(runConfig) {
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

export function prepareRunScopedDataset(runConfig, requireDatasetCredentials) {
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

function preLoginTags(runConfig) {
  return {
    environment: runConfig.environment,
    profile: runConfig.dataset.profile,
    test_type: runConfig.testType,
    target: runConfig.target,
    phase: 'setup',
  };
}

function setupAuthRequestJson(runConfig, method, path, body, expectedStatuses, step) {
  const payload = body === null || body === undefined ? null : JSON.stringify(body);
  const route = `${method} ${path}`;
  const service = serviceLabel(step);
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
      step,
    },
  });

  const ok = check(response, {
    [`${step} returned expected status`]: (res) => expectedStatuses.includes(res.status),
    [`${step} returned json`]: (res) => String(res.headers['Content-Type'] || res.headers['content-type'] || '').includes('application/json'),
  }, {
    ...preLoginTags(runConfig),
    route,
    service,
    step,
  });
  if (!ok) {
    fail(`${step} ${method} ${path} failed with status ${response.status}`);
  }

  try {
    return {
      status: response.status,
      body: response.json(),
    };
  } catch (error) {
    fail(`${step} ${method} ${path} returned invalid json: ${error.message}`);
  }
  return null;
}

function customerTokenFromAuth(index, auth, step) {
  const user = requireField(auth, 'user', step);
  if (requireField(user, 'role', step) !== 'CUSTOMER') {
    fail(`${step} returned non-CUSTOMER user`);
  }
  return {
    customerIndex: index,
    customerId: requireField(user, 'id', step),
    accessToken: requireField(auth, 'accessToken', step),
  };
}

function signupOrLoginCustomer(runConfig, index, step) {
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
    step,
  );

  if (signup.status === 201) {
    return { created: true, token: customerTokenFromAuth(index, signup.body, step) };
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
    step,
  );
  return { created: false, token: customerTokenFromAuth(index, login.body, step) };
}

export function prepareCustomerTokens(runConfig, step) {
  const customerTokens = [];
  const activeCount = activeCustomerCount(runConfig);
  const state = {
    createdCustomers: 0,
    reusedCustomers: 0,
    verifiedCustomers: 0,
    activeCustomers: activeCount,
  };
  for (let index = 0; index < runConfig.customerPool.size; index += 1) {
    const result = signupOrLoginCustomer(runConfig, index, step);
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

export function customerTokenForIteration(setupData, customerIndex, step) {
  const tokens = setupData && Array.isArray(setupData.customerTokens) ? setupData.customerTokens : [];
  const token = tokens[customerIndex];
  if (!token || token.customerIndex !== customerIndex || !token.customerId || !token.accessToken) {
    fail(`${step} did not prepare a token for customer index ${customerIndex}`);
  }
  return token;
}
