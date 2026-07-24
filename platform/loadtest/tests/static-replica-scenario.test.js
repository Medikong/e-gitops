import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import {
  loadRun,
  runSequentialPipeline,
  selectServices,
  workloadProfile,
} from '../scenarios/service-static-replica-capacity-load-test/execute.js';

const valuesRoot = resolve(new URL('..', import.meta.url).pathname, 'values');
const experiment = loadRun(resolve(valuesRoot, 'runs', 'local-smoke-replicas-1.yaml'));

function passingCapacity(rps) {
  const trial = { metrics: { target_rps: rps }, decision: { passed: true, conclusive: true, reasons: [] } };
  return { search: { last_pass_rps: rps, first_fail_rps: rps + 10 }, trials: [trial], confirmation: { stable_rps: rps, repetitions: [trial] }, status: 'passed' };
}

test('run이 시나리오, 환경, 데이터셋과 replica 수를 하나의 실행 계약으로 조합한다', () => {
  assert.equal(experiment.run.name, 'local-smoke-replicas-1');
  assert.equal(experiment.run.deployment.replicas, 1);
  assert.equal(experiment.environment.name, 'local');
  assert.equal(experiment.dataset.profile, 'smoke');
  assert.equal(experiment.dataset.profileDocument.name, 'smoke');
  assert.equal(experiment.dataset.profileDocument.days, 2);
  assert.equal(experiment.dataset.profileDocument.initial_users, 126);
  assert.equal(experiment.fixedComparisonConditions.loadSeed, experiment.dataset.seed);
  assert.equal(experiment.fixedComparisonConditions.datasetRevision, experiment.dataset.revision);
  assert.equal(experiment.environment.loadtestNamespace, 'dropmong-loadtest-local');
  assert.equal(experiment.environment.loadtestInputs['auth-service'].dataset.existingSecret, 'dropmong-loadtest-dataset-input');
  assert.equal(experiment.services['catalog-service'].namespace, 'dropmong-catalog');
  assert.equal(experiment.services['catalog-service'].baseUrl, 'http://istio-ingressgateway.istio-system.svc.cluster.local');
  assert.equal(experiment.sources.run.endsWith('/values/runs/local-smoke-replicas-1.yaml'), true);
  assert.equal(experiment.serviceOrder.length, 9);
  assert.equal('treatments' in experiment, false);
  const profile = workloadProfile(experiment, 'catalog-service');
  assert.equal(profile.endpointMix.length, 2);
  assert.equal(profile.observability.requireKafkaLag, false);
  assert.deepEqual(profile.observability.metricSpecs.map((spec) => spec.id), ['cpu_utilization', 'memory_utilization', 'pod_restarts']);
});

test('1 Pod와 2 Pod 실행은 별도 RUN 파일에서 replica 수만 다르게 지정한다', () => {
  const one = loadRun(resolve(valuesRoot, 'runs', 'local-smoke-replicas-1.yaml'));
  const two = loadRun(resolve(valuesRoot, 'runs', 'local-smoke-replicas-2.yaml'));
  assert.equal(one.run.deployment.replicas, 1);
  assert.equal(two.run.deployment.replicas, 2);
  assert.equal(one.scenario, two.scenario);
  assert.equal(one.dataset.revision, two.dataset.revision);
});

test('AWS 용량 실행은 같은 시나리오와 baseline dataset을 참조하고 원격 context는 기본 거부한다', () => {
  const aws = loadRun(resolve(valuesRoot, 'runs', 'aws-capacity-replicas-1.yaml'));
  assert.equal(aws.scenario, experiment.scenario);
  assert.equal(aws.run.deployment.replicas, 1);
  assert.equal(aws.environment.name, 'aws-dev');
  assert.equal(aws.environment.safety.remote, true);
  assert.deepEqual(aws.environment.loadtestInputs, {});
  assert.deepEqual(aws.environment.kubernetesContext.allowedNames, []);
  assert.equal(aws.dataset.profile, 'baseline-90days');
  assert.equal(aws.dataset.profileDocument.name, 'baseline-90days');
  assert.equal(aws.dataset.profileDocument.days, 90);
  assert.equal(aws.dataset.profileDocument.initial_users, 10_000);
  assert.equal(aws.run.cleanup, true);
  assert.equal('images' in aws.run, false);
});

test('지표 검증 RUN은 replica별로 분리하고 짧은 시간과 낮은 RPS로 제한한다', () => {
  const metricsOne = loadRun(resolve(valuesRoot, 'runs', 'local-metrics-smoke-replicas-1.yaml'));
  const metricsTwo = loadRun(resolve(valuesRoot, 'runs', 'local-metrics-smoke-replicas-2.yaml'));
  const profile = workloadProfile(metricsOne, 'catalog-service');
  assert.equal(metricsOne.run.verificationOnly, true);
  assert.equal(metricsOne.run.deployment.replicas, 1);
  assert.equal(metricsTwo.run.deployment.replicas, 2);
  assert.equal(metricsOne.dataset.profile, 'smoke');
  assert.equal(profile.adaptive.startRps, 1);
  assert.equal(profile.adaptive.maxRps, 2);
  assert.equal(profile.adaptive.trialWarmupSeconds, 10);
  assert.equal(profile.adaptive.trialMeasureSeconds, 30);
  assert.equal(profile.adaptive.confirmationMeasureSeconds, 15);
  assert.equal(profile.adaptive.repetitions, 1);
});

test('기본 순서와 SERVICE 필터를 보존한다', () => {
  assert.deepEqual(selectServices(experiment), experiment.serviceOrder);
  assert.deepEqual(selectServices(experiment, 'catalog-service'), ['catalog-service']);
  assert.throws(() => selectServices(experiment, 'reference-service'));
});

test('서비스는 replica 수로 한 번씩 순차 실행하고 한 서비스 실패도 다음 결과를 보존한다', async () => {
  const events = []; const persisted = [];
  const services = ['catalog-service', 'user-service'];
  const result = await runSequentialPipeline({ experiment, services, hooks: {
    checkReadiness: async (service) => events.push(`ready:${service}`),
    checkMigration: async (service) => events.push(`migration:${service}`),
    deployReplicas: async (service, replicas) => { events.push(`deploy:${service}:${replicas}`); if (service === 'catalog-service') throw new Error('failed'); },
    runCapacitySearch: async () => passingCapacity(10),
    waitForStability: async () => {},
    persistServiceResult: async (serviceResult) => persisted.push(serviceResult.service),
  } });
  assert.deepEqual(persisted, services);
  assert.match(events.join(','), /deploy:catalog-service:1.*ready:user-service.*deploy:user-service:1/);
  assert.ok(result[0].error);
  assert.equal(result[1].error, null);
  assert.equal(result[1].replicas, 1);
  assert.equal(result[1].capacity.status, 'passed');
});
