import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  boundedResourceName,
  contextApproved,
  currentRevisionReadyPods,
  datasetRestoreServices,
  diagnosticTail,
  formatFailureSummary,
  formatProgress,
  helmOverrideArgs,
  integerCandidate,
  optionsFromArgs,
  releaseRevisionFromStatus,
  safeRunId,
  splitContainerImage,
  TEST_SCENARIOS,
  validateServices,
  verificationDecision,
  warmupExitAction,
} from '../scripts/orchestrate.js';
import { fixtureConfigurationFailures, replicaApplyArgs, replicaRestoreArgs } from '../lib/dev-rollout.js';

const root = resolve(new URL('..', import.meta.url).pathname);
const valuesRoot = resolve(root, 'values');

test('공통 실행기는 시나리오를 선택하고 서비스 목록을 순차 대상으로만 관리한다', () => {
  assert.deepEqual(Object.keys(TEST_SCENARIOS), [
    'service-static-replica-capacity-load-test',
    'service-bottleneck-ramp-load-test',
  ]);
  assert.equal(validateServices('all').length, 9);
  assert.deepEqual(validateServices('catalog-service,catalog-service'), ['catalog-service']);
  assert.throws(() => validateServices('reference-service'));
  assert.equal(TEST_SCENARIOS['service-bottleneck-ramp-load-test'].mode, 'bottleneck-ramp');
});

test('RUN 선택은 preset과 scenario, dataset, environment, replica를 함께 전달한다', () => {
  const path = resolve(valuesRoot, 'runs', 'local-smoke-1day-ramp-replicas-1.yaml');
  const options = optionsFromArgs(['--run', path, '--run-id', 'local-options']);
  assert.equal(options.scenario, 'service-bottleneck-ramp-load-test');
  assert.equal(options.experiment.run.preset, 'local-smoke-1day-low-rps');
  assert.equal(options.experiment.dataset.profile, 'smoke-1day');
  assert.equal(options.experiment.environment.name, 'local');
  assert.equal(options.replicas, 1);
  assert.equal(options.cleanup, true);
  assert.equal('buildImages' in options, false);
  assert.equal('prepareCluster' in options, false);
});

test('dataset 복원 범위는 서비스 계약과 실제 DB 의존성으로 제한한다', () => {
  assert.deepEqual(datasetRestoreServices('catalog-service'), ['catalog-service']);
  assert.deepEqual(datasetRestoreServices('order-service'), ['order-service', 'payment-service']);
  assert.deepEqual(datasetRestoreServices('dropmong-web'), ['catalog-service']);
});

test('환경 allowlist가 없으면 원격 Kubernetes context를 기본 거부한다', () => {
  assert.equal(contextApproved('docker-desktop', ['docker-desktop']), true);
  assert.equal(contextApproved('aws-performance', []), false);
});

test('replica 적용과 원복은 같은 layered dev values를 사용하고 replica만 임시 override한다', () => {
  const contract = {
    release: 'catalog-dev',
    chart: '/tmp/chart',
    namespace: 'dropmong-catalog',
    files: ['/tmp/base.yaml', '/tmp/dev.yaml', '/tmp/catalog.yaml'],
    autoscaler: { hpa: { enabled: true }, keda: { enabled: true } },
    baseHelmSet: {
      nodeSelector: {},
      'image.registry': 'localhost:5001',
      'image.tag': 'dev',
      'image.digest': '',
      'image.pullPolicy': 'Always',
    },
  };
  const apply = replicaApplyArgs(contract, 1);
  const restore = replicaRestoreArgs(contract);
  assert.deepEqual(apply.filter((value) => value.endsWith('.yaml')), restore.filter((value) => value.endsWith('.yaml')));
  assert.match(apply.join(' '), /deployment\.replicas=1/);
  assert.ok(apply.includes('--no-hooks'));
  assert.ok(restore.includes('--no-hooks'));
  assert.match(apply.join(' '), /hpa\.enabled=false/);
  assert.match(apply.join(' '), /nodeSelector=\{\}/);
  assert.match(restore.join(' '), /nodeSelector=\{\}/);
  assert.match(apply.join(' '), /image\.digest=/);
  assert.match(restore.join(' '), /image\.digest=/);
  assert.match(apply.join(' '), /image\.tag=dev/);
  assert.match(restore.join(' '), /image\.tag=dev/);
  assert.match(apply.join(' '), /keda\.enabled=false/);
  assert.doesNotMatch(restore.join(' '), /deployment\.replicas=/);
  assert.doesNotMatch(restore.join(' '), /hpa\.enabled=false|keda\.enabled=false/);
});

test('Dataset/k6 입력 참조가 없으면 평문 대신 configuration 실패만 기록한다', () => {
  const failures = fixtureConfigurationFailures({ environment: { loadtestInputs: {} } }, ['auth-service', 'coupon-service']);
  assert.deepEqual(failures.map((failure) => failure.category), ['configuration', 'configuration']);
  assert.doesNotMatch(JSON.stringify(failures), /password=|coupon=|authorization/i);
});

test('coupon Dataset Job은 기존 coupon fixture Secret 참조가 없으면 시작하지 않는다', () => {
  const fixtures = {
    'coupon-service': {
      dataset: { existingSecret: 'existing-dataset-fixture' },
      k6: { existingSecret: 'existing-k6-fixture' },
    },
  };
  const failures = fixtureConfigurationFailures({ environment: { loadtestInputs: fixtures } }, ['coupon-service']);
  assert.deepEqual(failures.map((failure) => failure.message), ['coupon-service coupon fixture reference is unavailable']);
});

test('서비스 release revision과 현재 revision Pod 판정은 엄격하다', () => {
  assert.equal(releaseRevisionFromStatus({ version: 17 }), 17);
  assert.throws(() => releaseRevisionFromStatus({ version: 0 }));
  const deployment = { metadata: { uid: 'deployment-uid', annotations: { 'deployment.kubernetes.io/revision': '2' } } };
  const replicaSets = [
    { metadata: { uid: 'old-rs', annotations: { 'deployment.kubernetes.io/revision': '1' }, ownerReferences: [{ uid: 'deployment-uid' }] } },
    { metadata: { uid: 'new-rs', annotations: { 'deployment.kubernetes.io/revision': '2' }, ownerReferences: [{ uid: 'deployment-uid' }] } },
  ];
  const pod = (name, owner) => ({ metadata: { name, ownerReferences: [{ uid: owner }] }, status: { conditions: [{ type: 'Ready', status: 'True' }] } });
  assert.deepEqual(currentRevisionReadyPods(deployment, replicaSets, [pod('old', 'old-rs'), pod('new', 'new-rs')]).map((item) => item.metadata.name), ['new']);
});

test('공통 실행기는 scenario 결과의 API 필드나 PromQL을 조립하지 않는다', () => {
  const source = readFileSync(resolve(root, 'scripts', 'orchestrate.js'), 'utf8');
  assert.doesNotMatch(source, /p95_ms|p99_ms|actual_rps|checks_rate|cpu_utilization|memory_utilization/);
  assert.match(source, /this\.handler\.executeService/);
  assert.match(source, /collectObservabilitySnapshot/);
  assert.match(source, /metricSpecs: profile\.observability/);
});

test('local 복구는 서비스 의존성 준비 지연을 고려한 rollout timeout을 사용한다', () => {
  const source = readFileSync(resolve(root, 'scripts', 'orchestrate.js'), 'utf8');
  const localEnvironment = readFileSync(resolve(valuesRoot, 'environments', 'local.yaml'), 'utf8');
  assert.match(source, /gitops\?\.rolloutTimeoutSeconds/);
  assert.match(source, /--timeout=\$\{timeoutSeconds\}s/);
  assert.match(localEnvironment, /rolloutTimeoutSeconds: 600/);
});

test('관측성 부재는 k6 성공을 실행 실패로 바꾸지 않는 검증 전용 판정이다', () => {
  const decision = verificationDecision({
    passed: false,
    conclusive: false,
    threshold_passed: false,
    k6_exit_code: 0,
    reasons: [{ code: 'metric_unavailable', category: 'observability', message: 'not available' }],
  });
  assert.equal(decision.passed, true);
  assert.deepEqual(decision.reasons, []);
  assert.equal(decision.performance_evaluation.applied, false);
});

test('이름, Helm override, image 및 k6 종료 코드는 안전하게 처리한다', () => {
  assert.ok(boundedResourceName('dropmong-loadtest-', 'a'.repeat(60), 63).length <= 63);
  assert.equal(safeRunId('Catalog Run'), 'catalog-run');
  assert.deepEqual(helmOverrideArgs('k6Job.enabled', true), ['--set', 'k6Job.enabled=true']);
  assert.deepEqual(helmOverrideArgs('dataset.services', 'order-service,payment-service'), ['--set-string', 'dataset.services=order-service\\,payment-service']);
  assert.deepEqual(splitContainerImage('localhost:5001/dropmong-loadtest-runner:run-1'), { registry: 'localhost:5001', repository: 'dropmong-loadtest-runner', tag: 'run-1' });
  assert.throws(() => splitContainerImage('dropmong-loadtest-runner:run-1'));
  assert.equal(warmupExitAction(99), 'continue_after_threshold_failure');
  assert.equal(warmupExitAction(2), 'script_failure');
  assert.equal(integerCandidate(28, { start_rps: 10, max_rps: 100, last_pass_rps: 20, first_fail_rps: 40, trials: [{ metrics: { target_rps: 30 } }] }), 28);
});

test('진행과 실패 요약은 비밀값을 정제한다', () => {
  const line = formatProgress('시행 시작', { service: 'catalog-service', token: 'must-not-appear', reason: 'password=must-not-appear' }, '2026-07-24T00:00:00.000Z');
  assert.doesNotMatch(line, /must-not-appear/);
  const summary = formatFailureSummary({ status: 'fail', failures: [{ category: 'k6_script', service: 'catalog-service', message: 'token=must-not-appear' }] }, '/tmp/run');
  assert.doesNotMatch(summary, /must-not-appear/);
  assert.doesNotMatch(diagnosticTail('level=error token=must-not-appear'), /must-not-appear/);
});
