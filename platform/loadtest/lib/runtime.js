import { check, fail } from 'k6';
import crypto from 'k6/crypto';
import encoding from 'k6/encoding';
import exec from 'k6/execution';
import http from 'k6/http';
import { Counter, Rate, Trend } from 'k6/metrics';
import { createAddressBook } from './deterministic-data.js';
import { k6EndpointMetrics } from './k6-metrics.js';
import { buildRampSchedule } from './ramp.js';

const measuredRequests = new Counter('loadtest_requests');
const endpointRequests = new Counter('loadtest_endpoint_requests');
const successfulRequests = new Counter('loadtest_successes');
const failedRequests = new Counter('loadtest_errors');
const errorRate = new Rate('loadtest_error_rate');
const latency = new Trend('loadtest_latency', true);
const AUTH_BATCH_SIZE = 64;

function env(name, fallback = '') {
  const value = __ENV[name];
  return value === undefined || value === null || value === '' ? fallback : value;
}

function positiveNumber(name, fallback) {
  const value = Number(env(name, String(fallback)));
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

function nonNegativeNumber(name, fallback) {
  const value = Number(env(name, String(fallback)));
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return value;
}

function sanitizeName(value) {
  return String(value).replace(/[^a-zA-Z0-9_.-]/g, '_');
}

export function runtimeAddressing(profile) {
  const dataset = profile.dataset;
  if (!dataset?.parameters || dataset.seed === undefined) throw new Error('dataset addressing metadata is required');
  return createAddressBook({ profile: dataset.profile, parameters: dataset.parameters }, dataset.seed, {
    sha256: (input) => crypto.sha256(input, 'hex'),
    sha1: (input) => crypto.sha1(input, 'hex'),
  });
}

export function datasetAuthPassword(profile) {
  if (profile.dataset?.seed === undefined) throw new Error('dataset seed is required for test authentication');
  return crypto.sha256(`dropmong-loadtest-auth:${String(profile.dataset.seed)}`, 'hex');
}

export function bearerHeaders(setupData, userId) {
  const token = setupData?.accessTokens?.[userId];
  if (typeof token !== 'string' || !token) throw new Error('runtime authentication did not produce a token for the addressed user');
  return { Authorization: `Bearer ${token}` };
}

function authIntentData(response) {
  if (response.status !== 201) throw new Error(`runtime authentication intent failed with status ${response.status}`);
  const data = jsonData(response);
  if (!data?.authIntentId || !data?.authFlowToken) throw new Error('runtime authentication intent response is invalid');
  return data;
}

function authIntentRequest(profile, index) {
  return {
    method: 'POST',
    url: `${profile.baseUrl.replace(/\/+$/, '')}/api/v1/auth/intents`,
    body: JSON.stringify({ returnPath: '/loadtest', intentType: 'navigation' }),
    params: {
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Client-Channel': 'ios', 'Idempotency-Key': uniqueKey(`runtime-auth-intent-${index}`, index) },
      redirects: 0,
      timeout: env('LOADTEST_HTTP_TIMEOUT', '10s'),
    },
  };
}

function authSignInRequest(profile, addresses, password, index, intent) {
  return {
    method: 'POST',
    url: `${profile.baseUrl.replace(/\/+$/, '')}/api/v1/auth/signins/email`,
    body: JSON.stringify({ authIntentId: intent.authIntentId, email: addresses.email(index), password, rememberMe: false }),
    params: {
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Auth-Flow-Token': intent.authFlowToken, 'Idempotency-Key': uniqueKey(`runtime-auth-signin-${index}`, index) },
      redirects: 0,
      timeout: env('LOADTEST_HTTP_TIMEOUT', '10s'),
    },
  };
}

// k6 setup data is shared in memory with VUs and is not written to reports.
// Each token is minted through the public auth contract after dataset seeding.
export function bootstrapAccessTokens(profile, addresses, runtimePlan = null) {
  const accessTokens = {};
  const password = datasetAuthPassword(profile);
  const indexes = runtimePlan?.authUserIndexes ?? Array.from({ length: addresses.profile.authUserPoolSize }, (_, index) => index);
  for (let start = 0; start < indexes.length; start += AUTH_BATCH_SIZE) {
    const batch = indexes.slice(start, start + AUTH_BATCH_SIZE);
    const intents = http.batch(batch.map((index) => authIntentRequest(profile, index))).map(authIntentData);
    const responses = http.batch(batch.map((index, offset) => authSignInRequest(profile, addresses, password, index, intents[offset])));
    for (let offset = 0; offset < batch.length; offset += 1) {
      const data = jsonData(responses[offset]);
      if (responses[offset].status !== 200 || !data?.tokens?.accessToken) throw new Error(`runtime authentication sign-in failed with status ${responses[offset].status}`);
      accessTokens[addresses.user(batch[offset])] = data.tokens.accessToken;
    }
  }
  return { accessTokens };
}

export function buildOptions(profile) {
  const ramp = profile.ramp;
  const targetRps = positiveNumber('LOADTEST_TARGET_RPS', ramp?.maxRps ?? profile.adaptive.startRps);
  const rampSchedule = ramp ? buildRampSchedule(ramp) : null;
  const measureSeconds = positiveNumber('LOADTEST_MEASURE_SECONDS', rampSchedule?.durationSeconds ?? profile.adaptive.trialMeasureSeconds);
  const phase = env('LOADTEST_PHASE', 'trial');
  const latencyHintMs = ramp?.workerLatencyHintMs ?? profile.thresholds?.p99Ms ?? 1000;
  const p99Seconds = Math.max(0.1, latencyHintMs / 1000);
  const preAllocatedVUs = Math.max(2, Math.ceil(targetRps * p99Seconds * 1.5));
  const maxVUs = Math.max(preAllocatedVUs, Math.ceil(preAllocatedVUs * 2));
  const thresholds = ramp ? {
    // An exploratory ramp records latency and errors but does not turn an
    // unvalidated SLO into a k6 stop condition.
    loadtest_requests: ['count>0'],
  } : {
    loadtest_requests: ['count>0'],
    loadtest_error_rate: [`rate<=${profile.thresholds.errorRate}`],
    checks: [`rate>=${profile.thresholds.checkPassRate}`],
    loadtest_latency: [
      `p(95)<${profile.thresholds.p95Ms}`,
      `p(99)<${profile.thresholds.p99Ms}`,
    ],
    dropped_iterations: ['count<=0'],
  };
  for (const endpoint of profile.endpointMix) {
    if (endpoint.weight <= 0) {
      continue;
    }
    if (ramp) {
      // k6 retains tagged submetrics in its end-of-run summary only when a
      // threshold selects them. These neutral thresholds preserve route-level
      // measurements without turning the exploratory ramp into an SLO gate.
      thresholds[`loadtest_endpoint_requests{endpoint:${endpoint.name}}`] = ['count>=0'];
      thresholds[`loadtest_error_rate{endpoint:${endpoint.name}}`] = ['rate>=0'];
      thresholds[`checks{endpoint:${endpoint.name}}`] = ['rate>=0'];
      thresholds[`loadtest_latency{endpoint:${endpoint.name}}`] = ['max>=0'];
      continue;
    }
    thresholds[`loadtest_latency{endpoint:${endpoint.name}}`] = [
      `p(95)<${endpoint.p95Ms || profile.thresholds.p95Ms}`,
      `p(99)<${endpoint.p99Ms || profile.thresholds.p99Ms}`,
    ];
    thresholds[`loadtest_endpoint_requests{endpoint:${endpoint.name}}`] = ['count>0'];
    thresholds[`loadtest_error_rate{endpoint:${endpoint.name}}`] = [`rate<=${profile.thresholds.errorRate}`];
    thresholds[`checks{endpoint:${endpoint.name}}`] = [`rate>=${profile.thresholds.checkPassRate}`];
  }
  return {
    discardResponseBodies: false,
    noConnectionReuse: false,
    summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
    scenarios: {
      measured: {
        executor: ramp ? 'ramping-arrival-rate' : 'constant-arrival-rate',
        ...(ramp ? { startRate: rampSchedule.startRps, stages: rampSchedule.stages } : { rate: targetRps, duration: `${measureSeconds}s` }),
        timeUnit: '1s',
        preAllocatedVUs,
        maxVUs,
        gracefulStop: phase === 'confirmation' ? '15s' : '5s',
        tags: {
          phase,
          run_id: env('LOADTEST_RUN_ID', 'inspect'),
          service: profile.service,
          trial_id: env('LOADTEST_TRIAL_ID', 'inspect'),
        },
      },
    },
    thresholds,
  };
}

function activeEndpoints(profile) {
  const endpoints = profile.endpointMix.filter((endpoint) => Number(endpoint.weight) > 0);
  if (endpoints.length === 0) {
    throw new Error(`${profile.service} profile has no active endpoint`);
  }
  for (const endpoint of endpoints) {
    const weight = Number(endpoint.weight);
    if (!Number.isSafeInteger(weight) || weight <= 0) {
      throw new Error(`${profile.service}/${endpoint.name} weight must be a positive integer`);
    }
  }
  return endpoints;
}

function greatestCommonDivisor(left, right) {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

function buildEndpointPlan(profile) {
  const endpoints = activeEndpoints(profile);
  const divisor = endpoints
    .map((endpoint) => Number(endpoint.weight))
    .reduce((current, weight) => greatestCommonDivisor(current, weight));
  const quotas = endpoints.map((endpoint) => Number(endpoint.weight) / divisor);
  const total = quotas.reduce((sum, quota) => sum + quota, 0);
  const current = endpoints.map(() => 0);
  const schedule = [];

  // Smooth weighted round-robin spreads low-weight endpoints through the cycle
  // instead of placing all high-weight requests first.
  for (let slot = 0; slot < total; slot += 1) {
    let selected = 0;
    for (let index = 0; index < endpoints.length; index += 1) {
      current[index] += quotas[index];
      if (current[index] > current[selected]) {
        selected = index;
      }
    }
    current[selected] -= total;
    schedule.push(selected);
  }
  return { endpoints, quotas, schedule };
}

function selectFromEndpointPlan(plan, iteration) {
  if (!Number.isSafeInteger(iteration) || iteration < 0) {
    throw new Error('iteration must be a non-negative integer');
  }
  if (iteration < plan.endpoints.length) {
    return { endpoint: plan.endpoints[iteration], occurrence: 0 };
  }

  // The initial one-per-endpoint prefix guarantees coverage in short trials.
  const tailIteration = iteration - plan.endpoints.length;
  const cycle = Math.floor(tailIteration / plan.schedule.length);
  const position = tailIteration % plan.schedule.length;
  const selected = plan.schedule[position];
  let previousInCycle = 0;
  for (let index = 0; index < position; index += 1) {
    if (plan.schedule[index] === selected) {
      previousInCycle += 1;
    }
  }
  return {
    endpoint: plan.endpoints[selected],
    occurrence: 1 + cycle * plan.quotas[selected] + previousInCycle,
  };
}

export function endpointSelectionAt(profile, iteration) {
  return selectFromEndpointPlan(buildEndpointPlan(profile), iteration);
}

// This is the shared execution contract between the dataset and k6 phases:
// only users that the scheduled requests can actually address receive a token.
// The resolver remains workload-specific because its routes own the data shape.
export function buildAuthTokenPlan(profile, resolveUserIndex) {
  const iterationBudget = Number(profile.runtimePlan?.iterationBudget);
  if (!Number.isSafeInteger(iterationBudget) || iterationBudget < 1) {
    throw new Error('runtime plan requires a positive iterationBudget');
  }
  const indexes = new Set();
  for (let iteration = 0; iteration < iterationBudget; iteration += 1) {
    const index = resolveUserIndex(endpointSelectionAt(profile, iteration));
    // Public ranking routes do not require a user token.
    if (index == null) continue;
    if (!Number.isSafeInteger(index) || index < 0 || index >= profile.dataset.parameters.runtime_auth_user_pool_size) {
      throw new Error('runtime plan resolved an invalid auth user index');
    }
    indexes.add(index);
  }
  return { schemaVersion: 'dropmong.loadtest.runtime-plan/v1', iterationBudget, authUserIndexes: [...indexes].sort((left, right) => left - right) };
}

let cachedWriteAllocations;

function writeAllocation(poolName) {
  if (cachedWriteAllocations === undefined) {
    const raw = env('LOADTEST_WRITE_ALLOCATIONS', '{}');
    try {
      cachedWriteAllocations = JSON.parse(raw);
    } catch (error) {
      fail(`LOADTEST_WRITE_ALLOCATIONS is invalid JSON: ${String(error)}`);
    }
  }
  const configured = cachedWriteAllocations && cachedWriteAllocations[poolName];
  if (configured) {
    return { start: Number(configured.start), size: Number(configured.size) };
  }
  return {
    start: Number(env('LOADTEST_WRITE_SLICE_START', '-1')),
    size: Number(env('LOADTEST_WRITE_SLICE_SIZE', '0')),
  };
}

export function writeIndex(poolName, occurrence) {
  const { start, size } = writeAllocation(poolName);
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(size) || size <= 0) {
    fail(`write address pool ${poolName} requires a valid orchestrator-provided slice`);
  }
  if (!Number.isSafeInteger(occurrence) || occurrence < 0) {
    fail(`write address pool ${poolName} occurrence is invalid`);
  }
  const index = start + occurrence;
  if (index >= start + size) {
    fail(`runtime address range ${poolName} exhausted at index ${index}; reseed or allocate another slice`);
  }
  return index;
}

export function uniqueKey(prefix, occurrence) {
  // Some services compose this value into a bounded business key together
  // with the user ID and a request fingerprint. Keep the wire key short while
  // retaining deterministic per-run, per-trial, per-occurrence uniqueness.
  const scope = `${env('LOADTEST_RUN_ID', 'run')}|${env('LOADTEST_TRIAL_ID', 'trial')}|${occurrence}`;
  return `${sanitizeName(prefix).slice(0, 24)}-${crypto.sha256(scope, 'hex').slice(0, 16)}`;
}

function queryString(query) {
  const entries = Object.entries(query || {}).filter(([, value]) => value !== undefined && value !== null && value !== '');
  return entries.length === 0 ? '' : `?${entries.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&')}`;
}

function requestTags(profile, endpoint, measured) {
  return {
    endpoint: endpoint.name,
    endpoint_class: endpoint.classification,
    measured: String(measured),
    name: endpoint.route,
    phase: env('LOADTEST_PHASE', 'trial'),
    run_id: env('LOADTEST_RUN_ID', 'unknown'),
    service: profile.service,
    trial_id: env('LOADTEST_TRIAL_ID', 'unknown'),
  };
}

function traceparentHeader() {
  const value = env('LOADTEST_TRACEPARENT');
  if (!value) return {};
  if (!/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/i.test(value)) throw new Error('LOADTEST_TRACEPARENT is invalid');
  return { traceparent: value };
}

export function request(profile, endpoint, options) {
  const measured = options.measured !== false;
  const url = `${profile.baseUrl.replace(/\/+$/, '')}${options.path}${queryString(options.query)}`;
  const payload = options.body === undefined || options.body === null ? null : JSON.stringify(options.body);
  const tags = requestTags(profile, endpoint, measured);
  const response = http.request(options.method || endpoint.method, url, payload, {
    cookies: options.cookies,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Loadtest-Traffic': 'true',
      ...traceparentHeader(),
      ...options.headers,
    },
    redirects: options.redirects === undefined ? 0 : options.redirects,
    responseCallback: http.expectedStatuses(...(options.expectedStatuses || endpoint.expectedStatuses)),
    tags,
    timeout: env('LOADTEST_HTTP_TIMEOUT', '10s'),
  });
  const expectedStatuses = options.expectedStatuses || endpoint.expectedStatuses;
  const statusOk = expectedStatuses.includes(response.status);
  if (measured) {
    measuredRequests.add(1, tags);
    endpointRequests.add(1, tags);
    latency.add(response.timings.duration, tags);
  }

  let contractOk = true;
  let validatorFailed = false;
  if (options.validate) {
    try {
      contractOk = Boolean(options.validate(response));
    } catch (_) {
      contractOk = false;
      validatorFailed = true;
    }
  }
  if (measured) {
    check(response, {
      [`${endpoint.name} status`]: () => statusOk,
      [`${endpoint.name} contract`]: () => contractOk,
    }, tags);
    errorRate.add(!statusOk || !contractOk, tags);
    if (statusOk && contractOk) {
      successfulRequests.add(1, tags);
    } else {
      failedRequests.add(1, tags);
      console.log(JSON.stringify({
        event: 'api_step_results',
        endpoint: endpoint.name,
        error_class: validatorFailed ? 'contract_validator' : (statusOk ? 'contract' : 'api_status'),
        expected_statuses: expectedStatuses,
        run_id: tags.run_id,
        service: profile.service,
        status: response.status,
        trial_id: tags.trial_id,
      }));
    }
  }
  if (!statusOk || !contractOk) {
    const failureKind = validatorFailed ? 'contract validator' : (statusOk ? 'contract' : 'status');
    fail(`${endpoint.name} ${failureKind} failed with status ${response.status}`);
  }
  return response;
}

export function jsonData(response) {
  const body = response.json();
  return body && typeof body === 'object' && body.data !== undefined ? body.data : body;
}

function metricValue(data, name, key, fallback = null) {
  const metric = data.metrics && data.metrics[name];
  const value = metric && metric.values && metric.values[key];
  return Number.isFinite(value) ? value : fallback;
}

function endpointSummary(data, profile, endpoint) {
  return k6EndpointMetrics(data, { endpointMix: [endpoint] }, {
    durationSeconds: positiveNumber('LOADTEST_MEASURE_SECONDS', profile.ramp?.schedule?.durationSeconds ?? profile.adaptive.trialMeasureSeconds),
  })[0];
}

function summaryDocument(profile, addresses, data) {
  const checksRate = metricValue(data, 'checks', 'rate', 0);
  const requests = metricValue(data, 'loadtest_requests', 'count', 0);
  const successes = metricValue(data, 'loadtest_successes', 'count', 0);
  const failures = metricValue(data, 'loadtest_errors', 'count', 0);
  const targetRps = positiveNumber('LOADTEST_TARGET_RPS', profile.ramp?.maxRps ?? profile.adaptive.startRps);
  const endpoints = profile.endpointMix
    .filter((endpoint) => endpoint.weight > 0)
    .map((endpoint) => endpointSummary(data, profile, endpoint));
  const k6ThresholdsPassed = Object.values(data.metrics || {}).every((metric) => (
    !metric.thresholds || Object.values(metric.thresholds).every((threshold) => threshold.ok)
  ));
  const document = {
    schema_version: 1,
    event: 'loadtest_run_report',
    run_id: env('LOADTEST_RUN_ID', 'unknown'),
    trial_id: env('LOADTEST_TRIAL_ID', 'unknown'),
    service: profile.service,
    scenario: env('LOADTEST_SCENARIO', 'service-static-replica-capacity-load-test'),
    replicas: Number(env('LOADTEST_REPLICAS', '1')),
    workload: profile.workload,
    phase: env('LOADTEST_PHASE', 'trial'),
    dataset_profile: profile.dataset?.profile ?? null,
    dataset_seed: profile.dataset?.seed ?? null,
    target_rps: targetRps,
    actual_rps: metricValue(data, 'loadtest_requests', 'rate', 0),
    request_count: requests,
    successful_requests: successes,
    failed_requests: failures,
    success_rate: requests > 0 ? successes / requests : 0,
    error_rate: metricValue(data, 'loadtest_error_rate', 'rate', requests > 0 ? failures / requests : 1),
    check_pass_rate: checksRate,
    failed_checks: metricValue(data, 'checks', 'fails', 0),
    dropped_iterations: metricValue(data, 'dropped_iterations', 'count', 0),
    p50_ms: metricValue(data, 'loadtest_latency', 'med'),
    p95_ms: metricValue(data, 'loadtest_latency', 'p(95)'),
    p99_ms: metricValue(data, 'loadtest_latency', 'p(99)'),
    max_latency_ms: metricValue(data, 'loadtest_latency', 'max'),
    thresholds_passed: requests > 0 && endpoints.every((endpoint) => Number(endpoint.requests) > 0) && k6ThresholdsPassed,
    endpoints,
    metadata: {
      gitops_git_sha: env('LOADTEST_GITOPS_GIT_SHA', 'unknown'),
      service_git_sha: env('LOADTEST_SERVICE_GIT_SHA', 'unknown'),
      gitops_dirty: env('LOADTEST_GITOPS_GIT_DIRTY', 'unknown'),
      service_dirty: env('LOADTEST_SERVICE_GIT_DIRTY', 'unknown'),
      k6_image: env('LOADTEST_K6_IMAGE', 'unknown'),
      seeder_image: env('LOADTEST_SEEDER_IMAGE', 'unknown'),
      service_image: env('LOADTEST_SERVICE_IMAGE', 'unknown'),
      kubernetes_context: env('LOADTEST_KUBERNETES_CONTEXT', 'unknown'),
      namespace: env('LOADTEST_NAMESPACE', 'unknown'),
      runtime_addressing_strategy: 'deterministic-seed-addressing',
    },
  };
  return document;
}

export function createServiceLifecycle(profile, addresses, handlers) {
  const endpointPlan = buildEndpointPlan(profile);
  return {
    setup() {
      const conditions = {
        event: 'loadtest_experiment_conditions',
        run_id: env('LOADTEST_RUN_ID', 'unknown'),
        trial_id: env('LOADTEST_TRIAL_ID', 'unknown'),
        service: profile.service,
        scenario: env('LOADTEST_SCENARIO', 'service-static-replica-capacity-load-test'),
        replicas: Number(env('LOADTEST_REPLICAS', '1')),
        workload: profile.workload,
        phase: env('LOADTEST_PHASE', 'trial'),
        dataset_profile: profile.dataset?.profile ?? null,
        dataset_seed: profile.dataset?.seed ?? null,
        target_rps: positiveNumber('LOADTEST_TARGET_RPS', profile.ramp?.maxRps ?? profile.adaptive.startRps),
        measure_seconds: positiveNumber('LOADTEST_MEASURE_SECONDS', profile.ramp?.schedule?.durationSeconds ?? profile.adaptive.trialMeasureSeconds),
        ...(profile.ramp ? { start_rps: profile.ramp.startRps, increase_rps_per_second: profile.ramp.increaseRpsPerSecond } : {}),
      };
      console.log(JSON.stringify(conditions));
      return handlers.setup ? handlers.setup(profile, addresses) : {};
    },

    run(setupData) {
      const selection = selectFromEndpointPlan(endpointPlan, exec.scenario.iterationInTest);
      const handler = handlers[selection.endpoint.name];
      if (!handler) {
        fail(`handler is missing for ${selection.endpoint.name}`);
      }
      handler({
        endpoint: selection.endpoint,
        addresses,
        occurrence: selection.occurrence,
        profile,
        setupData,
      });
    },

    handleSummary(data) {
      const summary = summaryDocument(profile, addresses, data);
      console.log(JSON.stringify(summary));
      for (const endpoint of summary.endpoints) {
        console.log(JSON.stringify({
          event: 'api_step_results',
          run_id: summary.run_id,
          service: summary.service,
          replicas: summary.replicas,
          trial_id: summary.trial_id,
          ...endpoint,
        }));
      }
      const reportDir = env('LOADTEST_REPORT_DIR', '/loadtest/reports');
      const path = `${reportDir}/raw/k6/${sanitizeName(profile.service)}/${sanitizeName(summary.trial_id)}.summary.json`;
      return { [path]: JSON.stringify(summary, null, 2) };
    },
  };
}

export function endpointByName(profile, name) {
  const endpoint = profile.endpointMix.find((candidate) => candidate.name === name);
  if (!endpoint) {
    throw new Error(`unknown endpoint ${name}`);
  }
  return endpoint;
}

export function decodeSignedDevelopmentSession(value) {
  const payload = String(value || '').split('.')[0];
  if (!payload) {
    fail('development session cookie is missing');
  }
  return JSON.parse(encoding.b64decode(payload, 'rawurl', 's'));
}

export function configuredWarmupSeconds(profile) {
  return nonNegativeNumber('LOADTEST_WARMUP_SECONDS', profile.ramp ? 0 : profile.adaptive.trialWarmupSeconds);
}
