import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildRampSchedule, targetRpsAt } from '../lib/ramp.js';
import { loadRun, runSequentialPipeline, validateExperiment, workloadProfile } from '../scenarios/service-bottleneck-ramp-load-test/execute.js';
import { buildLiveResult, buildTrialResult as buildRampTrialResult, finalizeResult, renderAnalysis } from '../scenarios/service-bottleneck-ramp-load-test/report.js';
import { evaluateCompletedWindows, parseK6Points, rampExitIsExecutionFailure, reduceWindowDecisions } from '../scenarios/service-bottleneck-ramp-load-test/window.js';
import { optionsFromArgs } from '../scripts/orchestrate.js';
import { devReleaseContract, replicaApplyArgs, replicaRestoreArgs } from '../lib/dev-rollout.js';

const root = resolve(new URL('..', import.meta.url).pathname);
const runPath = resolve(root, 'values', 'runs', 'local-bottleneck-ramp-replicas-1.yaml');
const baselineRunPath = resolve(root, 'values', 'runs', 'local-baseline-90days-ramp-replicas-1.yaml');

function point(metric, second, value) {
  return JSON.stringify({ type: 'Point', metric, data: { time: new Date(Date.UTC(2026, 6, 24, 0, 0, second, 500)).toISOString(), value, tags: {} } });
}

function healthyWindow(index, targetRps) {
  return { index, eligible: true, breached: false, target_rps: targetRps, reasons: [], ended_at: `2026-07-24T00:00:${String(index * 10).padStart(2, '0')}.000Z` };
}

function breachedWindow(index, targetRps, code = 'actual_rps_stalled_against_reference') {
  return { index, eligible: true, breached: true, target_rps: targetRps, reasons: [{ code }], ended_at: `2026-07-24T00:00:${String(index * 10).padStart(2, '0')}.000Z` };
}

test('RUN ramp YAML은 1 replica, baseline-90days와 모든 필수 ramp 필드를 검증한다', () => {
  const experiment = loadRun(runPath);
  assert.equal(experiment.scenario, 'service-bottleneck-ramp-load-test');
  assert.equal(experiment.run.deployment.replicas, 1);
  assert.equal(experiment.run.cleanup, true);
  assert.equal(experiment.dataset.profile, 'baseline-90days');
  assert.equal(experiment.run.ramp.services['catalog-service'].maxRps, 300);
  assert.equal(experiment.serviceOrder.length, 8);
  assert.ok(!experiment.serviceOrder.includes('dropmong-web'));
  assert.equal(experiment.run.ramp.workerLatencyHintMs, 1000);
  assert.deepEqual(workloadProfile(experiment, 'catalog-service').observability.metricSpecs.map((spec) => spec.id), ['cpu_utilization', 'memory_utilization', 'pod_restarts']);
  for (const field of ['increaseRpsPerSecond', 'evaluationWindowSeconds', 'minimumSamplesPerWindow', 'consecutiveBreachWindows']) assert.ok(experiment.run.ramp[field] > 0);
  const invalid = structuredClone(experiment);
  delete invalid.run.ramp.minimumSamplesPerWindow;
  assert.throws(() => validateExperiment(invalid), /minimumSamplesPerWindow/);
});

test('명시적 90일 RUN은 dataset, preset, scenario를 중복 없이 조합한다', () => {
  const legacy = loadRun(runPath);
  const experiment = loadRun(baselineRunPath);
  assert.equal(experiment.run.name, 'local-baseline-90days-ramp-replicas-1');
  assert.equal(experiment.run.verificationOnly, false);
  assert.equal(experiment.dataset.profile, 'baseline-90days');
  assert.equal(experiment.dataset.profileDocument.days, 90);
  assert.equal(experiment.run.preset, 'baseline-90days-replicas-1');
  assert.equal(experiment.run.deployment.replicas, 1);
  assert.deepEqual(experiment.sources.dataset, legacy.sources.dataset);
  assert.deepEqual(experiment.sources.preset, legacy.sources.preset);
  assert.deepEqual(experiment.sources.scenario, legacy.sources.scenario);
  for (const service of Object.keys(experiment.services)) {
    const schedule = workloadProfile(experiment, service).ramp.schedule;
    assert.ok(schedule.maxRps > schedule.startRps, service);
    assert.ok(schedule.durationSeconds >= experiment.run.ramp.evaluationWindowSeconds * experiment.run.ramp.consecutiveBreachWindows, service);
  }
});

test('ramp replica 적용과 원복은 기존 dev chart의 layered values를 사용하며 replica만 임시로 바꾼다', () => {
  const experiment = loadRun(runPath);
  const contract = devReleaseContract(experiment, 'catalog-service');
  const apply = replicaApplyArgs(contract, 1);
  const restore = replicaRestoreArgs(contract);
  assert.ok(contract.files.some((file) => file.endsWith('/values/base.yaml')));
  assert.ok(contract.files.some((file) => file.endsWith('/values/env/dev.yaml')));
  assert.ok(contract.files.some((file) => file.endsWith('/values/services/catalog.yaml')));
  assert.match(apply.join(' '), /nodeSelector=\{\}/);
  assert.match(restore.join(' '), /nodeSelector=\{\}/);
  assert.ok(apply.includes('--no-hooks'));
  assert.ok(restore.includes('--no-hooks'));
  assert.match(apply.join(' '), /image\.digest=/);
  assert.match(restore.join(' '), /image\.digest=/);
  assert.match(apply.join(' '), /image\.tag=dev/);
  assert.match(restore.join(' '), /image\.tag=dev/);
  assert.deepEqual(apply.filter((item) => item.startsWith('deployment.replicas=')), ['deployment.replicas=1']);
  assert.equal(restore.some((item) => item.startsWith('deployment.replicas=')), false);
  assert.equal(apply.includes('--reuse-values'), false);
});

test('ramp는 로컬 Helm values에 직접 정의한 Dataset 연결을 사용한다', () => {
  const source = readFileSync(resolve(root, 'values', 'local.yaml'), 'utf8');
  assert.match(source, /DATASET_DATABASE_URL_AUTH_SERVICE/);
  assert.match(source, /DATASET_DATABASE_URL_NOTIFICATION_SERVICE/);
});

test('ramping-arrival-rate schedule은 일정 기울기로 증가하고 maxRps를 넘지 않는다', () => {
  const schedule = buildRampSchedule({ startRps: 10, maxRps: 30, increaseRpsPerSecond: 2 });
  assert.equal(schedule.durationSeconds, 10);
  assert.deepEqual(schedule.stages, [{ duration: '10s', target: 30 }]);
  assert.equal(targetRpsAt(schedule, 3), 16);
  assert.equal(targetRpsAt(schedule, 100), 30);
  assert.throws(() => buildRampSchedule({ startRps: 10, maxRps: 10, increaseRpsPerSecond: 2 }));
});

test('최근 window 경계만 집계하고 최소 표본 미달 window는 판정에서 제외한다', () => {
  const lines = [];
  for (let second = 0; second < 20; second += 1) {
    lines.push(point('loadtest_requests', second, 1), point('loadtest_error_rate', second, 0), point('checks', second, 1), point('loadtest_latency', second, 20));
  }
  const points = parseK6Points(`${lines.join('\n')}\n`);
  const schedule = buildRampSchedule({ startRps: 1, maxRps: 101, increaseRpsPerSecond: 1 });
  const windows = evaluateCompletedWindows(points, {
    startedAt: '2026-07-24T00:00:00.000Z', now: '2026-07-24T00:00:20.000Z', schedule,
    evaluationWindowSeconds: 10, minimumSamplesPerWindow: 11,
  });
  assert.equal(windows.length, 2);
  assert.equal(windows[0].request_count, 10);
  assert.equal(windows[1].request_count, 10);
  assert.equal(windows[0].status, 'insufficient_samples');
  assert.equal(windows[1].status, 'insufficient_samples');
});

test('ramp는 고정 SLO 대신 직전 정상 실측 RPS를 reference로 삼아 두 window 연속 정체를 찾는다', () => {
  const lines = [];
  const addWindow = (startSecond, rps, latency) => {
    for (let second = startSecond; second < startSecond + 10; second += 1) {
      for (let request = 0; request < rps; request += 1) {
        lines.push(point('loadtest_requests', second, 1));
        lines.push(point('loadtest_error_rate', second, 0));
        lines.push(point('checks', second, 1));
        lines.push(point('loadtest_latency', second, latency));
      }
    }
  };
  addWindow(0, 10, 20);
  addWindow(10, 20, 20);
  addWindow(20, 20, 800);
  addWindow(30, 20, 900);
  const points = parseK6Points(`${lines.join('\n')}\n`);
  const schedule = buildRampSchedule({ startRps: 10, maxRps: 60, increaseRpsPerSecond: 1 });
  const windows = evaluateCompletedWindows(points, {
    startedAt: '2026-07-24T00:00:00.000Z', now: '2026-07-24T00:00:40.000Z', schedule,
    evaluationWindowSeconds: 10, minimumSamplesPerWindow: 50,
  });
  assert.deepEqual(windows.map((window) => window.reference_actual_rps), [null, 10, 20, 20]);
  assert.equal(windows[0].status, 'reference');
  assert.equal(windows[2].breached, true);
  assert.deepEqual(windows[2].reasons.map((reason) => reason.code), ['actual_rps_stalled_against_reference']);
  assert.equal(windows[2].p95_ms, 800);
  assert.ok(!windows[2].reasons.some((reason) => /slo/.test(reason.code)));
  const decision = reduceWindowDecisions(windows, 2);
  assert.equal(decision.termination.reason, 'consecutive_reference_degradation_windows');
  assert.equal(decision.reference.peak_actual_rps, 20);
  assert.equal(decision.degradation.first.target_rps, 35);
  assert.equal(decision.degradation.first.actual_rps, 20);
});

test('연속 위반은 누적하고 정상 window가 나오면 처음부터 다시 센다', () => {
  const windows = [breachedWindow(1, 10), healthyWindow(2, 20), breachedWindow(3, 30), breachedWindow(4, 40)];
  const result = reduceWindowDecisions(windows, 2);
  assert.equal(result.termination.first_window_index, 3);
  assert.equal(result.termination.last_window_index, 4);
  assert.equal(result.last_healthy_rps, 20);
  assert.equal(result.first_degraded_rps, 30);
});

test('최소 표본 미달 window는 연속 위반 계산에서 제외하고 마지막 정상 RPS를 보존한다', () => {
  const ignored = { index: 2, eligible: false, breached: false, target_rps: 20, reasons: [], status: 'insufficient_samples' };
  const result = reduceWindowDecisions([healthyWindow(1, 10), breachedWindow(2, 20), ignored, breachedWindow(4, 40)], 2);
  assert.equal(result.last_healthy_rps, 10);
  assert.equal(result.first_degraded_rps, 20);
});

test('병목 도달에 따른 k6 중단과 k6 script 실행 실패를 구분한다', () => {
  assert.equal(rampExitIsExecutionFailure(130, true), false);
  assert.equal(rampExitIsExecutionFailure(99, false), true);
  assert.equal(rampExitIsExecutionFailure(2, true), true);
  assert.equal(rampExitIsExecutionFailure(2, false), true);
});

test('서비스별 dataset 준비와 ramp는 한 번씩만 순차 실행한다', async () => {
  const experiment = loadRun(runPath);
  const events = [];
  const services = ['catalog-service', 'coupon-service'];
  const results = await runSequentialPipeline({ experiment, services, hooks: {
    checkReadiness: async (service) => events.push(`ready:${service}`),
    checkMigration: async (service) => events.push(`migration:${service}`),
    deployReplicas: async (service) => events.push(`deploy:${service}`),
    prepareDataset: async (service) => events.push(`dataset:${service}`),
    runRamp: async (service) => { events.push(`ramp:${service}`); return { status: 'max_rps_reached' }; },
    persistServiceResult: async ({ service }) => events.push(`persist:${service}`),
  } });
  assert.deepEqual(results.map((result) => result.service), services);
  assert.equal(events.filter((event) => event.startsWith('dataset:')).length, services.length);
  assert.deepEqual(events, [
    'ready:catalog-service', 'migration:catalog-service', 'deploy:catalog-service', 'dataset:catalog-service', 'ramp:catalog-service', 'persist:catalog-service',
    'ready:coupon-service', 'migration:coupon-service', 'deploy:coupon-service', 'dataset:coupon-service', 'ramp:coupon-service', 'persist:coupon-service',
  ]);
});

test('ramp RUN 선택은 새 mode를 사용하고 static RUN 계약은 그대로 유지한다', () => {
  const ramp = optionsFromArgs(['--run', runPath, '--services', 'catalog-service']);
  const staticRun = optionsFromArgs(['--run', resolve(root, 'values', 'runs', 'local-smoke-replicas-1.yaml'), '--services', 'catalog-service']);
  assert.equal(ramp.mode, 'bottleneck-ramp');
  assert.equal(workloadProfile(ramp.experiment, 'catalog-service').ramp.schedule.maxRps, 300);
  assert.equal(staticRun.mode, 'static-replica-capacity');
  assert.equal(staticRun.confirmation, true);
});

test('ramp 보고서는 마지막 정상 RPS, 최초 저하 RPS, 종료 조건과 dataset 1회 계약을 보존한다', () => {
  const execution = {
    run_id: 'ramp-test', run_definition: 'local-bottleneck-ramp-replicas-1', scenario: 'service-bottleneck-ramp-load-test', mode: 'bottleneck-ramp', replicas: 1, status: 'pass', started_at: '2026-07-24T00:00:00Z', finished_at: '2026-07-24T00:01:00Z',
    dataset: { profile: 'baseline-90days', seed: '20260723', revision: 'baseline-90days-v1' }, git: {}, images: {}, environment: {}, failures: [],
    services: { 'catalog-service': { status: 'bottleneck_reached', workload: 'drop-list-and-detail', replicas: 1, ramp: { status: 'bottleneck_reached', schedule: { startRps: 10, maxRps: 300, increaseRpsPerSecond: 2 }, evaluation_window_seconds: 10, dataset_preparations: 1, windows: [], last_healthy_rps: 40, first_degraded_rps: 50, reference: { peak_target_rps: 60, peak_actual_rps: 42, last_healthy_actual_rps: 40 }, degradation: { first: { target_rps: 50, actual_rps: 40, reference_actual_rps: 40 } }, terminated_at: '2026-07-24T00:00:30Z', stop_condition: { required_windows: 2, reasons: ['actual_rps_stalled_against_reference'] }, first_bottleneck_candidate: { candidate: 'service-capacity-growth-stalled' } } } },
  };
  const result = finalizeResult(buildLiveResult(execution));
  assert.equal(result.run.status, 'pass');
  assert.equal(result.services['catalog-service'].ramp.dataset_preparations, 1);
  assert.equal(result.services['catalog-service'].ramp.last_healthy_rps, 40);
  assert.equal(result.services['catalog-service'].ramp.first_degraded_rps, 50);
  assert.equal(result.services['catalog-service'].ramp.reference.peak_actual_rps, 42);
  assert.match(renderAnalysis(result), /peak 실측 RPS/);
  assert.match(renderAnalysis(result), /2개 연속 reference 저하/);
});

test('ramp 실행 실패 보고서는 측정되지 않은 RPS를 0이나 최대 RPS 도달로 오해하지 않는다', () => {
  const execution = {
    run_id: 'ramp-execution-failure', run_definition: 'local-bottleneck-ramp-replicas-1', scenario: 'service-bottleneck-ramp-load-test', mode: 'bottleneck-ramp', replicas: 1, status: 'fail', started_at: '2026-07-24T00:00:00Z', finished_at: '2026-07-24T00:01:00Z',
    dataset: { profile: 'baseline-90days' }, failures: [{ category: 'k6_script', service: 'catalog-service', message: 'k6 exited 137' }],
    services: { 'catalog-service': { status: 'failed', workload: 'drop-list-and-detail', replicas: 1, ramp: { status: 'failed', schedule: { startRps: 10, maxRps: 300, increaseRpsPerSecond: 2 }, evaluation_window_seconds: 10, dataset_preparations: 1, windows: [], last_healthy_rps: null, first_degraded_rps: null, terminated_at: '2026-07-24T00:00:10Z', stop_condition: null, first_bottleneck_candidate: { candidate: 'not-observed' }, execution_reasons: [{ code: 'k6_execution_exit', category: 'execution', message: 'k6 exited 137' }] } } },
  };
  const result = finalizeResult(buildLiveResult(execution));
  const analysis = renderAnalysis(result);
  assert.equal(result.run.status, 'fail');
  assert.match(analysis, /\| catalog-service \| failed \| unavailable \| unavailable \|/);
  assert.match(analysis, /종료: 실행 실패\(k6_execution_exit\)/);
  assert.match(analysis, /실행 실패 근거: k6 exited 137/);
  assert.doesNotMatch(analysis, /설정한 최대 RPS 도달/);
});

test('ramp scenario report keeps route-level k6 metrics while unavailable observability stays non-fatal', () => {
  const profile = {
    endpointMix: [{ name: 'catalog.list', route: 'GET /drops', classification: 'read', weight: 100 }],
    observability: { metricSpecs: [
      { id: 'cpu_utilization', unit: 'percent', required: false },
      { id: 'memory_utilization', unit: 'percent', required: false },
      { id: 'pod_restarts', unit: 'restarts', required: false },
    ] },
    ramp: { schedule: { startRps: 1, maxRps: 10, durationSeconds: 10 } },
  };
  const trial = buildRampTrialResult({
    trialId: 'catalog-ramp-1',
    service: 'catalog-service',
    profile,
    rawK6Summary: {
      request_count: 50,
      actual_rps: 5,
      error_rate: 0,
      check_pass_rate: 1,
      endpoints: [{ endpoint: 'catalog.list', requests: 50, actual_rps: 5, error_rate: 0, checks_rate: 1, p50_ms: 20, p95_ms: 70, p99_ms: 100 }],
    },
    durationSeconds: 10,
    observability: { status: 'unavailable', reason: 'token=must-not-appear' },
  });
  assert.equal(trial.apis['GET /drops'].requests, 50);
  assert.equal(trial.apis['GET /drops'].p99_ms, 100);
  assert.equal(trial.apis['GET /drops'].decision.applied, false);
  assert.equal(trial.apis['GET /drops'].decision.reason, 'reference_ramp_has_no_fixed_slo');
  assert.equal(trial.observability.service.cpu_utilization, null);
  assert.equal(trial.decision.passed, true);
  assert.doesNotMatch(JSON.stringify(trial), /must-not-appear/);
});

test('ramp final report rebuilds API fields from the runner raw summary and decorated profile', () => {
  const profile = {
    endpointMix: [{ name: 'catalog.list', route: 'GET /drops', classification: 'read', weight: 100 }],
    thresholds: { errorRate: 0.01, checkPassRate: 1, p95Ms: 150, p99Ms: 300 },
    observability: { metricSpecs: [
      { id: 'cpu_utilization', unit: 'percent', required: false },
      { id: 'memory_utilization', unit: 'percent', required: false },
      { id: 'pod_restarts', unit: 'restarts', required: false },
    ] },
    ramp: { schedule: { startRps: 1, maxRps: 10, durationSeconds: 10 } },
  };
  const execution = {
    run_id: 'ramp-raw-summary', scenario: 'service-bottleneck-ramp-load-test', replicas: 1, status: 'pass', failures: [],
    services: {
      'catalog-service': {
        status: 'max_rps_reached',
        replicas: 1,
        ramp: { status: 'max_rps_reached', schedule: profile.ramp.schedule, k6_exit_code: 0, windows: [] },
      },
    },
  };
  const runnerTrial = {
    trial_id: 'catalog-ramp-raw', service: 'catalog-service', replicas: 1, phase: 'ramp', profile,
    raw_k6_summary: { request_count: 50, actual_rps: 5, error_rate: 0, check_pass_rate: 1, endpoints: [{ endpoint: 'catalog.list', requests: 50, actual_rps: 5, error_rate: 0, checks_rate: 1, p50_ms: 20, p95_ms: 70, p99_ms: 100 }] },
    observability: { status: 'available', metrics: {
      cpu_utilization: { status: 'available', series: [{ values: [[1, 0]] }] },
      memory_utilization: { status: 'available', series: [{ values: [[1, 42]] }] },
      pod_restarts: { status: 'available', series: [{ values: [[1, 0]] }] },
    } },
    traces: { 'GET /drops': { trace_status: 'available', trace_samples: [{ trace_id: '0123456789abcdef0123456789abcdef', span_id: '1111111111111111', service: 'catalog-service', route: 'GET /drops', http_status_code: 200, duration_ms: 1, started_at: '2026-07-24T00:00:00.000Z', tempo_reference: '/api/traces/0123456789abcdef0123456789abcdef' }], reason: null } },
    decision: { passed: true, conclusive: true, reasons: [] },
  };
  const result = finalizeResult(buildLiveResult(execution, [runnerTrial]));
  assert.equal(result.run.status, 'pass');
  assert.equal(result.services['catalog-service'].apis['GET /drops'].actual_rps, 5);
  assert.equal(result.services['catalog-service'].apis['GET /drops'].traces.trace_status, 'available');
  assert.equal(result.services['catalog-service'].observability.service.cpu_utilization, 0);
  assert.equal(result.services['catalog-service'].observability.service.memory_utilization, 42);
});
