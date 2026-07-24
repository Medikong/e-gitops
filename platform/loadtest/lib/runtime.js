import { check, fail } from 'k6';
import exec from 'k6/execution';
import http from 'k6/http';
import { SharedArray } from 'k6/data';
import { Counter, Rate, Trend } from 'k6/metrics';
import { k6EndpointMetrics } from './k6-metrics.js';
import { buildRampSchedule } from './ramp.js';

const measuredRequests = new Counter('loadtest_requests');
const endpointRequests = new Counter('loadtest_endpoint_requests');
const successfulRequests = new Counter('loadtest_successes');
const failedRequests = new Counter('loadtest_errors');
const errorRate = new Rate('loadtest_error_rate');
const latency = new Trend('loadtest_latency', true);

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

export function parseJsonFixture(text) {
  const fixture = JSON.parse(text);
  if (!fixture || typeof fixture !== 'object' || Array.isArray(fixture)) {
    throw new Error('fixture manifest must be a JSON object');
  }
  if (!fixture.pools || typeof fixture.pools !== 'object') {
    throw new Error('fixture manifest must contain pools');
  }
  return fixture;
}

export function loadSharedFixtures(profile, path) {
  const prefix = sanitizeName(`${profile.service}-fixtures`);
  const metadata = new SharedArray(`${prefix}-metadata`, () => {
    const fixture = parseJsonFixture(open(path));
    const { pools: _pools, ...rest } = fixture;
    void _pools;
    return [rest];
  })[0];
  const poolNames = [...new Set(profile.endpointMix.map((endpoint) => endpoint.fixturePool).filter(Boolean))].sort();
  const pools = Object.fromEntries(poolNames.map((poolName) => [poolName, new SharedArray(`${prefix}-${sanitizeName(poolName)}`, () => {
    const fixture = parseJsonFixture(open(path));
    const values = fixture.pools[poolName];
    if (!Array.isArray(values) || !values.length) throw new Error(`fixture pool ${poolName} is missing or empty`);
    return values;
  })]));
  return { ...metadata, pools };
}

export function loadAccessTokens(fixtures, path = env('LOADTEST_ACCESS_TOKEN_FILE')) {
  if (!path) throw new Error('LOADTEST_ACCESS_TOKEN_FILE is required by an authenticated workload');
  const document = new SharedArray('loadtest-access-tokens', () => [JSON.parse(open(path))])[0];
  const dataset = document?.dataset;
  if (
    document?.schemaVersion !== 1
    || !Array.isArray(document.tokens)
    || dataset?.profile !== fixtures.dataset?.profile
    || dataset?.profileHash !== fixtures.dataset?.profileHash
    || String(dataset?.seed ?? '') !== String(fixtures.dataset?.seed ?? '')
  ) {
    throw new Error('access token input does not match the fixture manifest');
  }
  const tokens = {};
  for (const entry of document.tokens) {
    if (!entry || typeof entry.userId !== 'string' || typeof entry.accessToken !== 'string' || !entry.accessToken || tokens[entry.userId]) {
      throw new Error('access token input is invalid');
    }
    tokens[entry.userId] = entry.accessToken;
  }
  return tokens;
}

export function bearerHeaders(tokens, userId) {
  const token = tokens[userId];
  if (typeof token !== 'string' || !token) throw new Error('access token input does not contain the requested fixture user');
  return { Authorization: `Bearer ${token}` };
}

export function buildOptions(profile) {
  const ramp = profile.ramp;
  const targetRps = positiveNumber('LOADTEST_TARGET_RPS', ramp?.maxRps ?? profile.adaptive.startRps);
  const rampSchedule = ramp ? buildRampSchedule(ramp) : null;
  const measureSeconds = positiveNumber('LOADTEST_MEASURE_SECONDS', rampSchedule?.durationSeconds ?? profile.adaptive.trialMeasureSeconds);
  const phase = env('LOADTEST_PHASE', 'trial');
  const p99Seconds = Math.max(0.1, profile.thresholds.p99Ms / 1000);
  const preAllocatedVUs = Math.max(2, Math.ceil(targetRps * p99Seconds * 1.5));
  const maxVUs = Math.max(preAllocatedVUs, Math.ceil(preAllocatedVUs * 2));
  const thresholds = {
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

function pool(fixtures, name) {
  const values = fixtures.pools[name];
  if (!Array.isArray(values) || values.length === 0) {
    fail(`fixture pool ${name} is missing or empty`);
  }
  return values;
}

export function readFixture(fixtures, poolName, occurrence) {
  const values = pool(fixtures, poolName);
  return values[occurrence % values.length];
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

export function writeFixture(fixtures, poolName, occurrence) {
  const values = pool(fixtures, poolName);
  const { start, size } = writeAllocation(poolName);
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(size) || size <= 0) {
    fail(`write fixture ${poolName} requires a valid orchestrator-provided slice`);
  }
  if (!Number.isSafeInteger(occurrence) || occurrence < 0) {
    fail(`write fixture ${poolName} occurrence is invalid`);
  }
  const index = start + occurrence;
  if (index >= start + size || index >= values.length) {
    fail(`write fixture ${poolName} exhausted at index ${index}; reseed or allocate another slice`);
  }
  return values[index];
}

export function uniqueKey(prefix, occurrence) {
  return `${sanitizeName(prefix)}-${env('LOADTEST_RUN_ID', 'run')}-${env('LOADTEST_TRIAL_ID', 'trial')}-${occurrence}`.slice(0, 128);
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

function summaryDocument(profile, fixtures, data) {
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
    dataset_profile: fixtures.dataset && fixtures.dataset.profile,
    dataset_seed: fixtures.dataset && fixtures.dataset.seed,
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
    thresholds_passed: requests > 0 && endpoints.every((endpoint) => endpoint.sample_count > 0) && k6ThresholdsPassed,
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
      write_fixture_strategy: fixtures.allocation && fixtures.allocation.strategy,
    },
  };
  return document;
}

export function createServiceLifecycle(profile, fixtures, handlers) {
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
        dataset_profile: fixtures.dataset && fixtures.dataset.profile,
        dataset_seed: fixtures.dataset && fixtures.dataset.seed,
        target_rps: positiveNumber('LOADTEST_TARGET_RPS', profile.ramp?.maxRps ?? profile.adaptive.startRps),
        measure_seconds: positiveNumber('LOADTEST_MEASURE_SECONDS', profile.ramp?.schedule?.durationSeconds ?? profile.adaptive.trialMeasureSeconds),
        ...(profile.ramp ? { start_rps: profile.ramp.startRps, increase_rps_per_second: profile.ramp.increaseRpsPerSecond } : {}),
      };
      console.log(JSON.stringify(conditions));
      return handlers.setup ? handlers.setup(profile, fixtures) : {};
    },

    run(setupData) {
      const selection = selectFromEndpointPlan(endpointPlan, exec.scenario.iterationInTest);
      const handler = handlers[selection.endpoint.name];
      if (!handler) {
        fail(`handler is missing for ${selection.endpoint.name}`);
      }
      handler({
        endpoint: selection.endpoint,
        fixtures,
        occurrence: selection.occurrence,
        profile,
        setupData,
      });
    },

    handleSummary(data) {
      const summary = summaryDocument(profile, fixtures, data);
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
