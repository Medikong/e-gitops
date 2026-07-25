#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  cleanupPolicy,
  datasetWithProfileDocument,
  finite,
  loadReference,
  loadOptionalPreset,
  readYaml,
  requiredObject,
  resolveEnvironment,
  resolveServiceTarget,
  validateMetricSpecs,
} from '../service-static-replica-capacity-load-test/execute.js';
import { buildRampSchedule } from '../../lib/ramp.js';

export const SCENARIO = 'service-bottleneck-ramp-load-test';

const REQUIRED_WINDOW_METRICS = [
  'targetRps', 'actualRps', 'requestCount', 'errorRate', 'checkPassRate',
  'droppedIterations', 'p50Ms', 'p95Ms', 'p99Ms', 'referenceRps', 'peakActualRps',
];
const REQUIRED_STOP_REASONS = [
  'actual_rps_stalled_against_reference', 'dropped_iterations_observed',
  'http_error_observed', 'check_failure_observed',
];

function validateRunRamp(run, serviceOrder) {
  const ramp = requiredObject('run.ramp', run.ramp);
  finite('run.ramp.increaseRpsPerSecond', ramp.increaseRpsPerSecond, { minimum: 0.001 });
  finite('run.ramp.evaluationWindowSeconds', ramp.evaluationWindowSeconds, { minimum: 1 });
  const minimumSamples = finite('run.ramp.minimumSamplesPerWindow', ramp.minimumSamplesPerWindow, { minimum: 1 });
  const consecutive = finite('run.ramp.consecutiveBreachWindows', ramp.consecutiveBreachWindows, { minimum: 1 });
  if (!Number.isInteger(minimumSamples) || !Number.isInteger(consecutive)) throw new TypeError('ramp sample and breach window fields must be integers');
  const services = requiredObject('run.ramp.services', ramp.services);
  const missing = serviceOrder.filter((service) => !services[service]);
  const unknown = Object.keys(services).filter((service) => !serviceOrder.includes(service));
  if (missing.length || unknown.length) throw new TypeError(`run.ramp.services mismatch: missing=${missing.join(',')} unknown=${unknown.join(',')}`);
  for (const service of serviceOrder) {
    const values = requiredObject(`run.ramp.services.${service}`, services[service]);
    const schedule = buildRampSchedule({ ...values, increaseRpsPerSecond: ramp.increaseRpsPerSecond });
    if (values.durationSeconds != null && finite(`run.ramp.services.${service}.durationSeconds`, values.durationSeconds, { minimum: 1 }) !== schedule.durationSeconds) {
      throw new TypeError(`${service} ramp durationSeconds must match the RPS schedule`);
    }
    if (schedule.durationSeconds < ramp.evaluationWindowSeconds * ramp.consecutiveBreachWindows) throw new TypeError(`${service} ramp duration must contain enough complete evaluation windows`);
  }
  return ramp;
}

function onlyKeys(name, value, allowed) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new TypeError(`${name} contains unsupported fields: ${unknown.join(', ')}`);
}

function rampPresetConditions(run, scenario, dataset, presetSource) {
  if (presetSource === null) return run.ramp;
  const preset = presetSource.value;
  onlyKeys('preset', preset, new Set(['name', 'scenario', 'dataset', 'deployment', 'ramp']));
  const datasetCondition = requiredObject('preset.dataset', preset.dataset);
  onlyKeys('preset.dataset', datasetCondition, new Set(['profile']));
  if (datasetCondition.profile !== dataset.profile) throw new TypeError('preset.dataset.profile must match run dataset.profile');
  const deployment = requiredObject('preset.deployment', preset.deployment);
  onlyKeys('preset.deployment', deployment, new Set(['replicas']));
  if (Number(deployment.replicas) !== Number(run.deployment?.replicas)) throw new TypeError('run.deployment.replicas must match preset.deployment.replicas');
  const ramp = requiredObject('preset.ramp', preset.ramp);
  onlyKeys('preset.ramp', ramp, new Set(['warmupSeconds', 'increaseRpsPerSecond', 'evaluationWindowSeconds', 'minimumSamplesPerWindow', 'consecutiveBreachWindows', 'workerLatencyHintMs', 'services']));
  finite('preset.ramp.warmupSeconds', ramp.warmupSeconds, { minimum: 0 });
  finite('preset.ramp.workerLatencyHintMs', ramp.workerLatencyHintMs, { minimum: 1 });
  const services = requiredObject('preset.ramp.services', ramp.services);
  for (const service of scenario.serviceOrder ?? []) {
    const values = requiredObject(`preset.ramp.services.${service}`, services[service]);
    onlyKeys(`preset.ramp.services.${service}`, values, new Set(['startRps', 'maxRps', 'durationSeconds']));
    if (values.durationSeconds == null) throw new TypeError(`preset.ramp.services.${service}.durationSeconds is required`);
  }
  return ramp;
}

export function validateExperiment(document) {
  requiredObject('experiment', document);
  if (document.schemaVersion !== 'dropmong.loadtest.experiment/v1') throw new TypeError('unsupported experiment schemaVersion');
  if (document.scenario !== SCENARIO) throw new TypeError(`scenario must be ${SCENARIO}`);
  const run = requiredObject('run', document.run);
  if (!run.name) throw new TypeError('run.name is required');
  if (typeof run.verificationOnly !== 'boolean') throw new TypeError('run.verificationOnly must be boolean');
  if (typeof run.cleanup !== 'boolean') throw new TypeError('run.cleanup must be boolean');
  if (run.deployment?.replicas !== 1) throw new TypeError('bottleneck ramp requires exactly one replica');
  const environment = requiredObject('environment', document.environment);
  if (!environment.name || !environment.gitops?.serviceReleaseSuffix || !Array.isArray(environment.kubernetesContext?.allowedNames) || !environment.helm?.loadtestValuesPath) throw new TypeError('resolved environment contract is incomplete');
  requiredObject('dataset', document.dataset);
  const supportedProfiles = document.rampContract?.supportedDatasetProfiles;
  if (!Array.isArray(supportedProfiles) || !supportedProfiles.includes(document.dataset.profile) || document.dataset.profileDocument?.name !== document.dataset.profile) throw new TypeError('bottleneck ramp dataset profile is not supported by the scenario');
  if (!document.dataset.revision || document.dataset.seed == null) throw new TypeError('dataset revision and seed are required');
  if (!Array.isArray(document.serviceOrder) || document.serviceOrder.length !== 8 || new Set(document.serviceOrder).size !== 8) throw new TypeError('serviceOrder must contain eight unique services');
  const ramp = validateRunRamp(run, document.serviceOrder);
  const window = requiredObject('rollingWindow', document.rollingWindow);
  for (const metric of REQUIRED_WINDOW_METRICS) if (!window.metrics?.includes(metric)) throw new TypeError(`rollingWindow.metrics is missing ${metric}`);
  for (const reason of REQUIRED_STOP_REASONS) if (!window.stopReasons?.[reason]) throw new TypeError(`rollingWindow.stopReasons is missing ${reason}`);
  validateMetricSpecs(document.observability?.metricSpecs);
  requiredObject('services', document.services);
  for (const service of document.serviceOrder) {
    const config = requiredObject(`services.${service}`, document.services[service]);
    if (config.service !== service || !['go', 'python', 'node'].includes(config.runtime) || !config.workload || !config.baseUrl || !config.readinessUrl || !config.authentication?.method) throw new TypeError(`invalid service contract: ${service}`);
    if (!Array.isArray(config.endpointMix) || !config.endpointMix.length) throw new TypeError(`${service} endpointMix is required`);
    if (config.endpointMix.some((endpoint) => endpoint.addressPool && !endpoint.addressAccess)) throw new TypeError(`${service} endpoint address access is required`);
    const weight = config.endpointMix.reduce((sum, endpoint) => sum + finite(`${service}.${endpoint.name}.weight`, endpoint.weight, { minimum: 1 }), 0);
    if (weight !== 100) throw new TypeError(`${service} endpoint weights must total 100`);
    requiredObject(`${service}.podResources`, config.podResources);
    buildRampSchedule({ ...ramp.services[service], increaseRpsPerSecond: ramp.increaseRpsPerSecond });
  }
  return document;
}

export function loadRun(path) {
  const runPath = resolve(path);
  const runDocument = requiredObject('run', readYaml(runPath));
  if (runDocument.schemaVersion !== 'dropmong.loadtest.run/v1') throw new TypeError('unsupported run schemaVersion');
  const run = requiredObject('run', runDocument.run);
  if (typeof run.verification_only !== 'boolean') throw new TypeError('run.verification_only must be boolean');
  const scenarioSource = loadReference(runPath, run, 'scenario', 'dropmong.loadtest.scenario/v1', 'scenario');
  const environmentSource = loadReference(runPath, run, 'environment', 'dropmong.loadtest.environment/v1', 'environment');
  const datasetSource = loadReference(runPath, run, 'dataset', 'dropmong.loadtest.dataset/v1', 'dataset');
  const scenario = requiredObject('scenario document', readYaml(scenarioSource.path));
  if (scenario.schemaVersion !== 'dropmong.loadtest.scenario/v1' || scenario.scenario !== SCENARIO) throw new TypeError(`scenario must be ${SCENARIO}`);
  const environment = resolveEnvironment(environmentSource);
  const dataset = datasetWithProfileDocument(datasetSource.value);
  const presetSource = loadOptionalPreset(runPath, run, SCENARIO);
  const ramp = rampPresetConditions(run, scenario, dataset, presetSource);
  const cleanup = cleanupPolicy(run);
  const services = Object.fromEntries((scenario.serviceOrder ?? []).map((service) => [service, {
    ...requiredObject(`scenario.services.${service}`, scenario.services?.[service]),
    ...resolveServiceTarget(environmentSource.path, environment, service),
  }]));
  return validateExperiment({
    ...scenario,
    schemaVersion: 'dropmong.loadtest.experiment/v1',
    run: {
      name: run.name,
      verificationOnly: run.verification_only,
      deployment: requiredObject('run.deployment', run.deployment),
      cleanup,
      lifecycle: { cleanup },
      preset: presetSource?.value.name ?? null,
      ramp: requiredObject('run.ramp', ramp),
    },
    services,
    environment,
    dataset,
    sources: {
      run: runPath,
      scenario: scenarioSource.path,
      preset: presetSource?.path ?? null,
      environment: environmentSource.path,
      dataset: datasetSource.path,
      loadtestHelmValues: environment.helm.loadtestValuesPath,
    },
  });
}

export const loadExperiment = loadRun;

export function selectServices(experiment, service = 'all') {
  if (!service || service === 'all') return [...experiment.serviceOrder];
  const requested = String(service).split(',').map((item) => item.trim()).filter(Boolean);
  const unknown = requested.filter((item) => !experiment.serviceOrder.includes(item));
  if (unknown.length) throw new TypeError(`unknown services: ${unknown.join(', ')}`);
  const selected = new Set(requested);
  return experiment.serviceOrder.filter((item) => selected.has(item));
}

export function workloadProfile(experiment, service) {
  const config = experiment.services[service];
  if (!config) throw new TypeError(`unknown service: ${service}`);
  const ramp = experiment.run.ramp;
  const { metricSpecs: _ignoredServiceMetricSpecs, ...serviceObservability } = config.observability ?? {};
  return {
    service: config.service,
    runtime: config.runtime,
    workload: config.workload,
    baseUrl: config.baseUrl,
    readinessUrl: config.readinessUrl,
    authentication: config.authentication,
    dependencies: config.dependencies,
    endpointMix: config.endpointMix,
    dataset: {
      profile: experiment.dataset.profile,
      seed: String(experiment.dataset.seed),
      parameters: experiment.dataset.profileDocument,
    },
    ramp: {
      ...ramp.services[service],
      warmupSeconds: ramp.warmupSeconds,
      increaseRpsPerSecond: ramp.increaseRpsPerSecond,
      evaluationWindowSeconds: ramp.evaluationWindowSeconds,
      minimumSamplesPerWindow: ramp.minimumSamplesPerWindow,
      consecutiveBreachWindows: ramp.consecutiveBreachWindows,
      workerLatencyHintMs: ramp.workerLatencyHintMs,
      schedule: buildRampSchedule({ ...ramp.services[service], increaseRpsPerSecond: ramp.increaseRpsPerSecond }),
    },
    observability: {
      ...(experiment.observability ?? {}),
      ...serviceObservability,
      metricSpecs: experiment.observability?.metricSpecs ?? [],
    },
    rollingWindow: experiment.rollingWindow,
  };
}

export async function runSequentialPipeline({ experiment, services, hooks }) {
  const results = [];
  for (const service of services) {
    let ramp = null;
    let error = null;
    try {
      await hooks.checkReadiness(service);
      await hooks.checkMigration(service);
      await hooks.deployReplicas(service, 1);
      await hooks.prepareDataset(service);
      ramp = await hooks.runRamp(service);
    } catch (caught) { error = caught; }
    results.push({ service, replicas: 1, ramp, error });
    await hooks.persistServiceResult(results.at(-1));
  }
  return results;
}

async function main() {
  const root = resolve(dirname(new URL(import.meta.url).pathname), '..', '..');
  const path = process.argv[2] ?? resolve(root, 'values', 'runs', 'local-bottleneck-ramp-replicas-1.yaml');
  const experiment = loadExperiment(path);
  process.stdout.write(`${JSON.stringify({ scenario: experiment.scenario, services: selectServices(experiment, process.argv[3] ?? 'all') })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
