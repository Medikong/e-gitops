import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildLiveResult,
  buildRunReport,
  buildTrialResult,
  finalizeResult,
  percentile,
  scenarioObservability,
  summarizeNumbers,
} from '../scenarios/service-static-replica-capacity-load-test/report.js';

const profile = {
  service: 'catalog-service',
  adaptive: { rpsTolerance: 0.05 },
  thresholds: { errorRate: 0.01, checkPassRate: 1, p95Ms: 150, p99Ms: 300 },
  endpointMix: [
    { name: 'catalog.list', route: 'GET /drops', classification: 'read', weight: 60 },
    { name: 'catalog.detail', route: 'GET /drops/{dropId}', classification: 'read', weight: 40, p95Ms: 180, p99Ms: 360 },
  ],
  observability: {
    metricSpecs: [
      { id: 'cpu_utilization', unit: 'percent', required: false },
      { id: 'memory_utilization', unit: 'percent', required: false },
      { id: 'pod_restarts', unit: 'restarts', required: false },
    ],
  },
};

function runtimeSummary() {
  return {
    request_count: 100,
    actual_rps: 10,
    successful_requests: 100,
    failed_requests: 0,
    error_rate: 0,
    check_pass_rate: 1,
    failed_checks: 0,
    dropped_iterations: 0,
    p50_ms: 20,
    p95_ms: 80,
    p99_ms: 120,
    max_latency_ms: 180,
    thresholds_passed: true,
    endpoints: [
      { endpoint: 'catalog.list', requests: 60, actual_rps: 6, error_rate: 0, checks_rate: 1, p50_ms: 15, p95_ms: 70, p99_ms: 100 },
      { endpoint: 'catalog.detail', requests: 40, actual_rps: 4, error_rate: 0, checks_rate: 1, p50_ms: 25, p95_ms: 100, p99_ms: 150 },
    ],
  };
}

function nativeK6Summary() {
  return {
    metrics: {
      loadtest_requests: { values: { count: 100, rate: 10 } },
      loadtest_successes: { values: { count: 100 } },
      loadtest_errors: { values: { count: 0 } },
      loadtest_error_rate: { values: { rate: 0 } },
      checks: { values: { rate: 1, fails: 0 } },
      dropped_iterations: { values: { count: 0 } },
      loadtest_latency: { values: { med: 20, 'p(95)': 80, 'p(99)': 120, max: 180 } },
      'loadtest_endpoint_requests{endpoint:catalog.list}': { values: { count: 60, rate: 6 } },
      'loadtest_error_rate{endpoint:catalog.list}': { values: { rate: 0 } },
      'checks{endpoint:catalog.list}': { values: { rate: 1 } },
      'loadtest_latency{endpoint:catalog.list}': { values: { med: 15, 'p(95)': 70, 'p(99)': 100 } },
      'loadtest_endpoint_requests{endpoint:catalog.detail}': { values: { count: 40, rate: 4 } },
      'loadtest_error_rate{endpoint:catalog.detail}': { values: { rate: 0 } },
      'checks{endpoint:catalog.detail}': { values: { rate: 1 } },
      'loadtest_latency{endpoint:catalog.detail}': { values: { med: 25, 'p(95)': 100, 'p(99)': 150 } },
    },
  };
}

function availableSnapshot() {
  return {
    status: 'available',
    window: { started_at: '2026-07-24T00:00:00Z', finished_at: '2026-07-24T00:00:10Z' },
    metrics: {
      cpu_utilization: { status: 'available', value: 0, series: [] },
      memory_utilization: { status: 'available', value: 37.5, series: [] },
      pod_restarts: { status: 'available', value: 0, series: [] },
    },
  };
}

function execution() {
  return {
    run_id: 'run-1',
    run_definition: 'local-smoke-1day-static-replicas-1',
    scenario: 'service-static-replica-capacity-load-test',
    preset: 'local-smoke-1day-low-rps',
    mode: 'static-replica-capacity',
    status: 'pass',
    replicas: 1,
    started_at: '2026-07-24T00:00:00Z',
    finished_at: '2026-07-24T00:10:00Z',
    dataset: { profile: 'smoke-1day', seed: '1', revision: 'sha' },
    services: {
      'catalog-service': {
        status: 'passed',
        workload: 'drop-list-and-detail',
        profile,
        replicas: 1,
        capacity: { status: 'passed', confirmation: { stable_rps: 10 } },
        restoration: { status: 'restored' },
      },
    },
    failures: [],
  };
}

function trial(overrides = {}) {
  return buildTrialResult({
    trialId: 'catalog-confirm-1',
    service: 'catalog-service',
    profile,
    rawK6Summary: runtimeSummary(),
    targetRps: 10,
    durationSeconds: 10,
    k6ExitCode: 0,
    startedAt: '2026-07-24T00:00:00Z',
    finishedAt: '2026-07-24T00:00:10Z',
    observability: availableSnapshot(),
    phase: 'confirmation',
    replicas: 1,
    ...overrides,
  });
}

test('percentile and number summary preserve explicit zero values', () => {
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.deepEqual(summarizeNumbers([]), {
    count: 0,
    average: null,
    p50: null,
    p95: null,
    p99: null,
    min: null,
    max: null,
    first: null,
    last: null,
    delta: null,
    coefficient_of_variation: null,
  });
});

test('scenario report reads endpoint-tagged k6 metrics into route-keyed API results', () => {
  const result = buildTrialResult({
    trialId: 'native-summary',
    service: 'catalog-service',
    profile,
    rawK6Summary: nativeK6Summary(),
    targetRps: 10,
    durationSeconds: 10,
    observability: availableSnapshot(),
  });
  const list = result.apis['GET /drops'];
  const detail = result.apis['GET /drops/{dropId}'];
  assert.equal(list.requests, 60);
  assert.equal(list.actual_rps, 6);
  assert.equal(list.error_rate, 0);
  assert.equal(list.checks_rate, 1);
  assert.equal(list.p50_ms, 15);
  assert.equal(list.p95_ms, 70);
  assert.equal(list.p99_ms, 100);
  assert.equal(list.decision.passed, true);
  assert.equal(detail.threshold.p95_ms_max, 180);
});

test('scenario-owned trial builder keeps API judgments and observability separate', () => {
  const result = trial();
  assert.equal(result.metrics.endpoints.length, 2);
  assert.equal(result.apis['GET /drops'].threshold.error_rate_max, 0.01);
  assert.equal(result.apis['GET /drops/{dropId}'].decision.passed, true);
  assert.equal(result.observability.status, 'available');
  assert.equal(result.observability.service.cpu_utilization, 0);
  assert.equal(result.observability.service.pod_restarts, 0);
  assert.equal(result.decision.passed, true);
});

test('missing observability metric is null with unavailable status and a sanitized reason', () => {
  const observation = scenarioObservability({
    status: 'available',
    metrics: {
      cpu_utilization: { status: 'available', value: 0 },
      memory_utilization: { status: 'unavailable', reason: 'token=must-not-appear' },
    },
  }, profile);
  assert.equal(observation.status, 'available');
  assert.equal(observation.service.cpu_utilization, 0);
  assert.equal(observation.service.memory_utilization, null);
  assert.equal(observation.service.metrics.memory_utilization.status, 'unavailable');
  assert.doesNotMatch(JSON.stringify(observation), /must-not-appear/);
  assert.equal(observation.service.metrics.pod_restarts.status, 'unavailable');
});

test('observability series keeps the last finite value, including zero', () => {
  const observation = scenarioObservability({
    status: 'available',
    metrics: {
      cpu_utilization: { status: 'available', unit: 'percent', series: [{ values: [[10, 41], [20, 0]] }] },
      memory_utilization: { status: 'available', unit: 'percent', series: [{ values: [[10, 20], [25, 33.5]] }] },
      pod_restarts: { status: 'available', unit: 'restarts', series: [{ values: [[15, 0]] }] },
    },
  }, profile);
  assert.equal(observation.status, 'available');
  assert.equal(observation.service.cpu_utilization, 0);
  assert.equal(observation.service.memory_utilization, 33.5);
  assert.equal(observation.service.pod_restarts, 0);
  assert.equal(observation.service.metrics.cpu_utilization.unit, 'percent');
});

test('observability query failure does not convert successful k6 into a failed trial', () => {
  const result = trial({ observability: { status: 'unavailable', reason: 'Authorization: Bearer must-not-appear' } });
  assert.equal(result.decision.passed, true);
  assert.equal(result.observability.status, 'unavailable');
  assert.equal(result.observability.service.cpu_utilization, null);
  assert.doesNotMatch(JSON.stringify(result), /must-not-appear/);
});

test('final static result chooses confirmation data and exposes service APIs and observability', () => {
  const search = trial({
    trialId: 'catalog-search-1',
    phase: 'trial',
    rawK6Summary: { ...runtimeSummary(), actual_rps: 5, request_count: 50 },
    targetRps: 5,
  });
  const confirmation = trial();
  const result = finalizeResult(buildLiveResult(execution(), [search, confirmation]));
  const service = result.services['catalog-service'];
  assert.equal(result.run.status, 'pass');
  assert.equal(result.run.preset, 'local-smoke-1day-low-rps');
  assert.equal(service.capacity.trials.length, 2);
  assert.equal(service.measurements.request.target_rps, 10);
  assert.equal(service.apis['GET /drops'].requests, 60);
  assert.equal(service.apis['GET /drops'].p99_ms, 100);
  assert.equal(service.observability.service.memory_utilization, 37.5);
});

test('final report rebuilds API fields from runner-owned raw k6 artifact and profile', () => {
  const rawTrial = {
    trial_id: 'raw-1',
    service: 'catalog-service',
    phase: 'confirmation',
    replicas: 1,
    metrics: { target_rps: 10, actual_rps: 10, error_rate: 0, check_pass_rate: 1, p95_ms: 80, p99_ms: 120 },
    raw_k6_summary: runtimeSummary(),
    observability: availableSnapshot(),
    profile,
    decision: { passed: true, conclusive: true, k6_exit_code: 0, reasons: [] },
  };
  const result = finalizeResult(buildLiveResult(execution(), [rawTrial]));
  assert.equal(result.services['catalog-service'].apis['GET /drops'].actual_rps, 6);
  assert.equal(result.services['catalog-service'].observability.status, 'available');
});

test('final report archives raw artifacts without introducing a resource collector artifact', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dropmong-report-'));
  try {
    const result = buildLiveResult(execution(), [trial()]);
    writeFileSync(join(directory, 'result.json'), `${JSON.stringify(result)}\n`);
    mkdirSync(join(directory, 'raw', 'k6', 'catalog-service'), { recursive: true });
    writeFileSync(join(directory, 'raw', 'k6', 'catalog-service', 'summary.json'), '{}\n');
    writeFileSync(join(directory, 'fixture-manifest.json'), '{}\n');
    const finalized = buildRunReport(directory);
    assert.equal(finalized.artifacts.evidence_status, 'archived');
    assert.equal(existsSync(join(directory, 'raw')), false);
    assert.deepEqual(readdirSync(directory).sort(), ['analysis.md', 'evidence.tar.gz', 'result.json']);
    assert.match(readFileSync(join(directory, 'analysis.md'), 'utf8'), /API별 결과는/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
