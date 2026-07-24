import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'yaml';
import { loadExperiment, resolveRunReferences } from '../scenarios/registry.js';

const root = resolve(new URL('..', import.meta.url).pathname);
const values = join(root, 'values');

function readYaml(path) {
  return parse(readFileSync(path, 'utf8'));
}

function tempRun(document) {
  const directory = mkdtempSync(join(tmpdir(), 'dropmong-loadtest-run-'));
  const path = join(directory, 'run.yaml');
  writeFileSync(path, JSON.stringify(document));
  return { directory, path };
}

function baseStaticRun() {
  return {
    schemaVersion: 'dropmong.loadtest.run/v1',
    run: {
      name: 'resolver-fixture',
      verification_only: true,
      scenario: join(values, 'scenarios', 'service-static-replica-capacity-load-test.yaml'),
      environment: join(values, 'environments', 'local.yaml'),
      dataset: join(values, 'datasets', 'smoke.yaml'),
      deployment: { replicas: 1 },
    },
  };
}

test('모든 RUN은 scenario, preset, dataset, environment, replica를 조합한다', () => {
  const files = readdirSync(join(values, 'runs')).filter((name) => name.endsWith('.yaml')).sort();
  assert.ok(files.length >= 10);
  for (const file of files) {
    const path = join(values, 'runs', file);
    const document = readYaml(path);
    const run = document.run;
    assert.equal(typeof run.scenario, 'string', `${file} scenario`);
    assert.equal(typeof run.preset, 'string', `${file} preset`);
    assert.equal(typeof run.dataset, 'string', `${file} dataset`);
    assert.equal(typeof run.environment, 'string', `${file} environment`);
    assert.equal(Number.isInteger(run.deployment?.replicas), true, `${file} replicas`);

    const references = resolveRunReferences(path);
    const experiment = loadExperiment(path);
    assert.ok(references.presetPath.endsWith('.yaml'));
    assert.equal(experiment.sources.preset, references.presetPath);
    assert.equal(experiment.run.preset.length > 0, true);
    assert.equal(experiment.run.deployment.replicas, run.deployment.replicas);
    assert.equal(experiment.dataset.profile, readYaml(references.datasetPath).dataset.profile);
  }
});

test('preset은 기존 RUN overrides보다 먼저 적용된다', () => {
  const document = baseStaticRun();
  document.run.preset = join(values, 'presets', 'service-static-replica-capacity-load-test', 'local-metrics-smoke-replicas-1.yaml');
  document.run.overrides = {
    execution: { warmupSeconds: 99, measureSeconds: 99 },
    capacity: { startRps: 99, maxRps: 100 },
  };
  const fixture = tempRun(document);
  try {
    const experiment = loadExperiment(fixture.path);
    assert.equal(experiment.run.preset, 'local-metrics-smoke-replicas-1');
    assert.equal(experiment.execution.warmupSeconds, 10);
    assert.equal(experiment.services['catalog-service'].capacity.startRps, 1);
    assert.equal(experiment.services['catalog-service'].capacity.maxRps, 2);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('preset이 없는 이전 static RUN은 legacyFallback과 overrides를 사용한다', () => {
  const document = baseStaticRun();
  document.run.overrides = {
    execution: { warmupSeconds: 5, measureSeconds: 8, confirmationMeasureSeconds: 4, cooldownSeconds: 1, repetitions: 1, searchTolerance: 0.5, maxSearchTrials: 1 },
    capacity: { startRps: 1, maxRps: 2 },
  };
  const fixture = tempRun(document);
  try {
    const experiment = loadExperiment(fixture.path);
    assert.equal(experiment.run.preset, null);
    assert.equal(experiment.execution.warmupSeconds, 5);
    assert.equal(experiment.services['catalog-service'].capacity.maxRps, 2);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('이전 prepareCluster와 buildImages 설정은 실행 계약에 넣지 않고 cleanup만 보존한다', () => {
  const document = baseStaticRun();
  document.run.lifecycle = { prepareCluster: true, buildImages: true, cleanup: false };
  document.run.images = { tag: 'legacy-tag' };
  const fixture = tempRun(document);
  try {
    const experiment = loadExperiment(fixture.path);
    assert.equal(experiment.run.cleanup, false);
    assert.deepEqual(experiment.run.lifecycle, { cleanup: false });
    assert.equal('images' in experiment.run, false);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('scenario는 CPU, memory, restart observability metric spec을 직접 소유한다', () => {
  for (const file of ['service-static-replica-capacity-load-test.yaml', 'service-bottleneck-ramp-load-test.yaml']) {
    const metricSpecs = readYaml(join(values, 'scenarios', file)).observability.metricSpecs;
    assert.deepEqual(metricSpecs.map((spec) => spec.id), ['cpu_utilization', 'memory_utilization', 'pod_restarts']);
    for (const spec of metricSpecs) {
      assert.match(spec.query, /\{\{namespace\}\}/);
      assert.match(spec.query, /\{\{service\}\}/);
      assert.equal(typeof spec.unit, 'string');
      assert.equal(typeof spec.required, 'boolean');
    }
  }
});
