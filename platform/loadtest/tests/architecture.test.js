import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';

const root = resolve(new URL('..', import.meta.url).pathname);
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');

test('RUN 파일은 유지하고 scenario, preset, dataset, environment을 실행 조합으로 선언한다', () => {
  const runs = readdirSync(join(root, 'values', 'runs')).filter((name) => name.endsWith('.yaml')).sort();
  assert.ok(runs.length >= 10);
  for (const name of runs) {
    const run = parse(read('values', 'runs', name)).run;
    assert.equal(typeof run.scenario, 'string', name);
    assert.equal(typeof run.preset, 'string', name);
    assert.equal(typeof run.dataset, 'string', name);
    assert.equal(typeof run.environment, 'string', name);
    assert.equal(Number.isInteger(run.deployment?.replicas), true, name);
  }
});

test('resource collector Job, RBAC, start barrier와 반복 수집 경로는 남기지 않는다', () => {
  for (const path of [
    ['templates', 'resource-collector-job.yaml'],
    ['templates', 'collector-rbac.yaml'],
    ['scripts', 'resource-collector.js'],
    ['scripts', 'measurement-queries.js'],
  ]) assert.equal(existsSync(join(root, ...path)), false, path.join('/'));
  const all = [read('values.yaml'), read('values', 'local.yaml'), read('values', 'aws-dev.yaml'), read('templates', 'k6-job.yaml'), read('runner', 'Dockerfile')].join('\n');
  assert.doesNotMatch(all, /resourceCollector|resource-collector|LOADTEST_RESOURCE_SYNC_REQUIRED|collector-ready|start barrier/i);
});

test('공통 실행기는 이미지 build, Secret 생성과 서비스 환경 주입을 수행하지 않는다', () => {
  const source = read('scripts', 'orchestrate.js');
  const taskfile = read('Taskfile.yml');
  assert.doesNotMatch(source, /buildImages|createRuntimeSecrets|applySecret|readRuntimeCredentialValues|kubectl', \['create'/);
  assert.doesNotMatch(taskfile, /credentials:ensure|ensure-local-credentials/);
  assert.doesNotMatch(source, /coupon code|couponSecretBundle/i);
  assert.match(source, /existingSecrets/);
});

test('로컬 RUN은 같은 task 명령에서 입력 준비를 거친 뒤 공통 실행기를 호출한다', () => {
  const taskfile = read('Taskfile.yml');
  const environment = parse(read('values', 'environments', 'local.yaml')).environment;
  assert.match(taskfile, /prepare:local/);
  assert.match(taskfile, /scripts\/prepare-local-inputs\.js/);
  assert.match(taskfile, /task: prepare:local/);
  assert.equal(environment.loadtestNamespace, 'dropmong-loadtest-local');
  assert.equal(environment.accessTokenInput.existingSecret, 'dropmong-loadtest-k6-token-input');
  assert.equal(environment.loadtestInputs['coupon-service'].coupon.existingSecret, 'dropmong-loadtest-coupon-input');
});

test('local input credential fingerprint은 cache identity를 분리하되 평문을 cache에 넣지 않는다', () => {
  const inputs = read('scripts', 'prepare-local-inputs.js');
  const orchestrator = read('scripts', 'orchestrate.js');
  assert.match(inputs, /auth-credential-fingerprint/);
  assert.match(orchestrator, /credentialFingerprint/);
  assert.doesNotMatch(orchestrator, /DATASET_AUTH_PASSWORD_HASH|LOADTEST_AUTH_PASSWORD/);
});

test('authenticated workload는 fixture userId에 대응하는 Secret 파일 Bearer token만 사용한다', () => {
  const runtime = read('lib', 'runtime.js');
  const orchestrator = read('scripts', 'orchestrate.js');
  const k6Template = read('templates', 'k6-job.yaml');
  assert.match(runtime, /LOADTEST_ACCESS_TOKEN_FILE/);
  assert.match(runtime, /Authorization: `Bearer \$\{token\}`/);
  assert.match(orchestrator, /prepareLocalAccessTokens/);
  assert.match(k6Template, /access-tokens/);
  for (const workload of ['user-service.js', 'coupon-service.js', 'interest-service.js', 'order-service.js', 'payment-service.js', 'notification-service.js']) {
    const source = read('workloads', workload);
    assert.match(source, /loadAccessTokens/);
    assert.doesNotMatch(source, /X-Principal|X-User-Id/);
  }
});

test('scenario가 metric specification과 rolling-window 규칙을 소유하고 workload는 서비스 HTTP 요청을 소유한다', () => {
  const ramp = parse(read('values', 'scenarios', 'service-bottleneck-ramp-load-test.yaml'));
  const staticScenario = parse(read('values', 'scenarios', 'service-static-replica-capacity-load-test.yaml'));
  for (const scenario of [ramp, staticScenario]) {
    assert.deepEqual(scenario.observability.metricSpecs.map((spec) => spec.id), ['cpu_utilization', 'memory_utilization', 'pod_restarts']);
    for (const metric of scenario.observability.metricSpecs) assert.match(metric.query, /\{\{namespace\}\}/);
  }
  assert.equal(ramp.rampContract.executor, 'ramping-arrival-rate');
  assert.equal(ramp.rampContract.datasetPreparation, 'once-per-service');
  assert.equal(readdirSync(join(root, 'workloads')).filter((name) => name.endsWith('.js')).length, 9);
});

test('1일 저RPS smoke는 모든 서비스 순차 실행용 RUN, preset, dataset을 갖는다', () => {
  const dataset = parse(read('values', 'datasets', 'smoke-1day.yaml')).dataset;
  assert.equal(dataset.parameters.days, 1);
  for (const name of ['local-smoke-1day-ramp-replicas-1.yaml', 'local-smoke-1day-static-replicas-1.yaml']) {
    const run = parse(read('values', 'runs', name)).run;
    assert.equal(run.deployment.replicas, 1);
    assert.match(run.preset, /local-smoke-1day-low-rps/);
  }
});

test('dataset cache는 Helm 패키지에서 제외되고 service마다 한 번 준비하는 공통 전달 계약을 유지한다', () => {
  assert.match(read('.helmignore'), /^tmp\/$/m);
  const staticRunner = read('scenarios', 'service-static-replica-capacity-load-test', 'runner.js');
  const rampRunner = read('scenarios', 'service-bottleneck-ramp-load-test', 'runner.js');
  // verification과 capacity는 서로 배타적인 경로이며 각 경로에서 한 번만 준비한다.
  assert.equal((staticRunner.match(/prepareDataset\(/g) ?? []).length, 2);
  assert.match(staticRunner, /verificationOnly\s*\?\s*await runVerification\(context, service\)\s*:\s*await runCapacity\(context, service\)/);
  assert.equal((rampRunner.match(/prepareDataset\(/g) ?? []).length, 1);
  const source = read('scripts', 'orchestrate.js');
  assert.match(source, /datasetCacheStaged/);
  assert.match(source, /syncDatasetCacheFromPod/);
});

test('scenario report는 공통 YAML loader 없이 독립적으로 패키징된다', () => {
  const dockerfile = read('tools', 'Dockerfile');
  const report = read('scenarios', 'service-static-replica-capacity-load-test', 'report.js');
  assert.doesNotMatch(report, /from ['"]\.\/execute\.js['"]/);
  assert.match(dockerfile, /scenarios\/service-static-replica-capacity-load-test\/report\.js/);
});
