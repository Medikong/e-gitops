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

test('공통 실행기는 이미지 build와 서비스 환경 주입을 수행하지 않는다', () => {
  const source = read('scripts', 'orchestrate.js');
  const taskfile = read('Taskfile.yml');
  assert.doesNotMatch(source, /buildImages|createRuntimeSecrets|applySecret|readRuntimeCredentialValues|kubectl', \['create'/);
  assert.doesNotMatch(taskfile, /credentials:ensure|ensure-local-credentials/);
  assert.doesNotMatch(source, /coupon code|couponSecretBundle/i);
  assert.doesNotMatch(source, /existingSecrets|loadtestInputs/);
});

test('로컬 RUN은 추가 입력 생성 없이 기존 Helm values로 공통 실행기를 호출한다', () => {
  const taskfile = read('Taskfile.yml');
  const environment = parse(read('values', 'environments', 'local.yaml')).environment;
  assert.match(taskfile, /prepare:local/);
  assert.doesNotMatch(taskfile, /prepare-local-inputs/);
  assert.match(taskfile, /task: prepare:local/);
  assert.equal(environment.loadtestNamespace, 'dropmong-loadtest-local');
  assert.equal('accessTokenInput' in environment, false);
  assert.equal('localDatasetValues' in environment.helm, false);
});

test('k6 inspect는 주소 목록 또는 token 파일 없이 선택한 ramp 서비스만 검사한다', () => {
  const taskfile = read('Taskfile.yml');
  assert.match(taskfile, /scenarios\/service-bottleneck-ramp-load-test\/execute\.js/);
  assert.doesNotMatch(taskfile, /for workload in workloads\/\*\.js/);
  assert.doesNotMatch(taskfile, /LOADTEST_FIXTURE_MANIFEST|LOADTEST_ACCESS_TOKEN_FILE/);
});

test('local Dataset은 기존 Helm values에 DB 연결을 직접 기록한다', () => {
  const values = parse(read('values', 'local.yaml'));
  const template = read('templates', 'dataset-job.yaml');
  const orchestrator = read('scripts', 'orchestrate.js');
  assert.equal(Object.keys(values.datasetJob.directEnv).length, 8);
  assert.ok(Object.keys(values.datasetJob.directEnv).every((name) => name.startsWith('DATASET_DATABASE_URL_')));
  assert.match(template, /\.Values\.datasetJob\.directEnv/);
  assert.doesNotMatch(template, /datasetJob\.existingSecrets/);
  assert.doesNotMatch(orchestrator, /localDatasetValuesPath|prepare-local-inputs/);
});

test('로컬 Dataset은 쿠폰 코드 원문이나 해시 키를 요구하지 않는다', () => {
  const values = read('values', 'local.yaml');
  assert.doesNotMatch(values, /COUPON_CODE_HASH_KEY|coupon-codes\.json|COUPON_SECRET/i);
  assert.match(values, /DATASET_DATABASE_URL_/);
});

test('상태 변경 Idempotency-Key는 service business key 한도 안에서 trial별로 고유하다', () => {
  const runtime = read('lib', 'runtime.js');
  assert.match(runtime, /crypto\.sha256\(scope, 'hex'\)\.slice\(0, 16\)/);
  assert.match(runtime, /sanitizeName\(prefix\)\.slice\(0, 24\)/);
  assert.doesNotMatch(runtime, /\$\{sanitizeName\(prefix\)\}-\$\{env\('LOADTEST_RUN_ID'/);
});

test('authenticated workload는 k6 setup에서 발급한 메모리 Bearer token만 사용한다', () => {
  const runtime = read('lib', 'runtime.js');
  const orchestrator = read('scripts', 'orchestrate.js');
  const k6Template = read('templates', 'k6-job.yaml');
  assert.match(runtime, /bootstrapAccessTokens/);
  assert.match(runtime, /Authorization: `Bearer \$\{token\}`/);
  assert.doesNotMatch(orchestrator, /prepareLocalAccessTokens/);
  assert.doesNotMatch(k6Template, /access-tokens|LOADTEST_ACCESS_TOKEN_FILE/);
  for (const workload of ['user-service.js', 'coupon-service.js', 'interest-service.js', 'order-service.js', 'payment-service.js', 'notification-service.js']) {
    const source = read('workloads', workload);
    assert.match(source, /bootstrapAccessTokens/);
    assert.doesNotMatch(source, /X-Principal|X-User-Id/);
  }
});

test('로컬 Istio ingress는 Coupon 경로를 User와 Web catch-all보다 먼저 인증 라우팅한다', () => {
  const routing = parse(read('..', 'istio', 'local', 'routing.yaml'));
  const policy = parse(read('..', 'istio', 'local', 'browser-authz-policy.yaml'));
  const routes = routing.spec.http;
  const names = routes.map((route) => route.name);
  assert.ok(names.indexOf('coupon-api') < names.indexOf('user'));
  assert.ok(names.indexOf('coupon-api') < names.indexOf('web'));
  const coupon = routes.find((route) => route.name === 'coupon-api');
  assert.deepEqual(coupon.route[0].destination, {
    host: 'coupon-service.dropmong-coupon.svc.cluster.local',
    port: { number: 8080 },
  });
  const protectedPaths = policy.spec.rules[0].to[0].operation.paths;
  assert.ok(protectedPaths.includes('/api/v1/users/me/coupons*'));
  assert.ok(protectedPaths.includes('/api/v1/coupon-campaigns*'));
  assert.ok(protectedPaths.includes('/api/v1/coupon-code-redemptions*'));
});

test('Interest workload는 실제 data envelope와 소문자 active 상태를 검증한다', () => {
  const workload = read('workloads', 'interest-service.js');
  assert.match(workload, /const data = jsonData\(response\);/);
  assert.match(workload, /data\.dropId === fixture\.dropId && data\.status === 'active'/);
  assert.doesNotMatch(workload, /data\.status === 'ACTIVE'/);
});

test('로컬 Dropmong Web은 Catalog 내부 URL, Catalog egress, 개발 checkout mock을 함께 가진다', () => {
  const base = parse(read('..', '..', 'values', 'services', 'dropmong-web.yaml'));
  const local = parse(read('..', '..', 'values', 'services', 'dev', 'dropmong-web.yaml'));
  const baseEnv = Object.fromEntries(base.container.env.map((entry) => [entry.name, entry.value]));
  const localEnv = Object.fromEntries(local.container.env.map((entry) => [entry.name, entry.value]));
  assert.equal(baseEnv.CATALOG_INTERNAL_BASE_URL, 'http://catalog-service.dropmong-catalog.svc.cluster.local:8081');
  assert.equal(localEnv.DEV_MOCK_MODE, 'true');
  assert.equal(localEnv.CATALOG_INTERNAL_BASE_URL, baseEnv.CATALOG_INTERNAL_BASE_URL);
  const catalogEgress = base.networkPolicy.egress.find((rule) => rule.to?.some((peer) => peer.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name'] === 'dropmong-catalog'));
  assert.deepEqual(catalogEgress, {
    to: [{
      namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'dropmong-catalog' } },
      podSelector: { matchLabels: { app: 'catalog-service' } },
    }],
    ports: [{ protocol: 'TCP', port: 8081 }],
  });
  const catalog = parse(read('..', '..', 'values', 'services', 'catalog.yaml'));
  assert.ok(catalog.networkPolicy.ingress.some((rule) => rule.from?.some((peer) => (
    peer.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name'] === 'dropmong-web'
      && peer.podSelector?.matchLabels?.app === 'dropmong-web'
  )) && rule.ports?.some((port) => port.protocol === 'TCP' && port.port === 8081)));
});

test('Web development-session decoder는 k6 encoding 모듈을 명시적으로 가져온다', () => {
  const runtime = read('lib', 'runtime.js');
  assert.match(runtime, /import encoding from 'k6\/encoding';/);
  assert.match(runtime, /encoding\.b64decode\(payload, 'rawurl', 's'\)/);
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
  assert.ok(ramp.rollingWindow.metrics.includes('referenceRps'));
  assert.ok(ramp.rollingWindow.metrics.includes('peakActualRps'));
  assert.deepEqual(Object.keys(ramp.rollingWindow.stopReasons).sort(), [
    'actual_rps_stalled_against_reference',
    'check_failure_observed',
    'dropped_iterations_observed',
    'http_error_observed',
  ]);
  assert.doesNotMatch(read('values', 'scenarios', 'service-bottleneck-ramp-load-test.yaml'), /^\s*slo:/m);
  assert.match(read('lib', 'runtime.js'), /const thresholds = ramp \? \{/);
  assert.equal(readdirSync(join(root, 'workloads')).filter((name) => name.endsWith('.js')).length, 9);
});

test('1일 저RPS smoke는 모든 서비스 순차 실행용 RUN, preset, dataset을 갖는다', () => {
  const dataset = parse(read('values', 'datasets', 'smoke-1day.yaml')).dataset;
  const staticScenario = parse(read('values', 'scenarios', 'service-static-replica-capacity-load-test.yaml'));
  const staticPreset = parse(read('values', 'presets', 'service-static-replica-capacity-load-test', 'local-smoke-1day-low-rps.yaml')).preset;
  assert.equal(dataset.parameters.days, 1);
  const maximumEndpointCount = Math.max(...Object.values(staticScenario.services).map((service) => service.endpointMix.length));
  assert.ok(staticPreset.execution.warmupSeconds >= maximumEndpointCount);
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
