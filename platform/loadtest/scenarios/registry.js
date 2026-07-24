import { dirname, resolve } from 'node:path';
import * as bottleneckRamp from './service-bottleneck-ramp-load-test/execute.js';
import * as staticCapacity from './service-static-replica-capacity-load-test/execute.js';

const CONTRACTS = new Map([
  [staticCapacity.SCENARIO, staticCapacity],
  [bottleneckRamp.SCENARIO, bottleneckRamp],
]);

export function resolveRunReferences(path) {
  const runPath = resolve(path);
  const document = staticCapacity.requiredObject('run', staticCapacity.readYaml(runPath));
  if (document.schemaVersion !== 'dropmong.loadtest.run/v1') throw new TypeError('unsupported run schemaVersion');
  const run = staticCapacity.requiredObject('run.run', document.run);
  if (typeof run.scenario !== 'string' || !run.scenario.trim()) throw new TypeError('references.scenario is required');
  const scenarioPath = resolve(dirname(runPath), run.scenario);
  const scenario = staticCapacity.requiredObject('scenario', staticCapacity.readYaml(scenarioPath));
  if (scenario.schemaVersion !== 'dropmong.loadtest.scenario/v1') throw new TypeError('unsupported scenario schemaVersion');
  if (typeof scenario.scenario !== 'string' || !scenario.scenario) throw new TypeError('scenario.scenario is required');
  const presetSource = staticCapacity.loadOptionalPreset(runPath, run, scenario.scenario);
  const datasetSource = staticCapacity.loadReference(runPath, run, 'dataset', 'dropmong.loadtest.dataset/v1', 'dataset');
  const environmentSource = staticCapacity.loadReference(runPath, run, 'environment', 'dropmong.loadtest.environment/v1', 'environment');
  return {
    runPath,
    run,
    scenario: scenario.scenario,
    scenarioPath,
    presetPath: presetSource?.path ?? null,
    datasetPath: datasetSource.path,
    environmentPath: environmentSource.path,
  };
}

function contractForRun(path) {
  const references = resolveRunReferences(path);
  const contract = CONTRACTS.get(references.scenario);
  if (!contract) throw new TypeError(`unknown test scenario: ${references.scenario}`);
  return contract;
}

export function loadExperiment(path) {
  return contractForRun(path).loadExperiment(path);
}

export function selectServices(experiment, service = 'all') {
  const contract = CONTRACTS.get(experiment.scenario);
  if (!contract) throw new TypeError(`unknown test scenario: ${experiment.scenario}`);
  return contract.selectServices(experiment, service);
}

export function workloadProfile(experiment, service) {
  const contract = CONTRACTS.get(experiment.scenario);
  if (!contract) throw new TypeError(`unknown test scenario: ${experiment.scenario}`);
  return contract.workloadProfile(experiment, service);
}
