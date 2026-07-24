#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';

export const SCENARIO = 'service-static-replica-capacity-load-test';

export function finite(name, value, { minimum = 0, maximum = Number.POSITIVE_INFINITY } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new TypeError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return number;
}

export function requiredObject(name, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

const DATASET_PARAMETER_KEYS = [
  'version', 'as_of', 'days', 'initial_users', 'daily_new_users', 'daily_drops',
  'products_per_drop', 'raw_view_hours', 'active_inventory_per_product',
  'paymentReadyOrderCount', 'couponClaimHeadroom', 'couponCodeCount',
  'fixturePoolSize', 'fixtureTrialCount', 'tiers', 'daily_coupon_campaigns',
  'seasonal_coupon_campaigns', 'daily_coupon_issues', 'event_coupon_issues',
  'coupon_redemption_percent', 'notifications_per_order', 'agreements',
];

export function datasetWithProfileDocument(source) {
  const dataset = requiredObject('dataset', source);
  const parameters = requiredObject('dataset.parameters', dataset.parameters);
  const missing = DATASET_PARAMETER_KEYS.filter((key) => parameters[key] == null);
  if (missing.length) throw new TypeError(`dataset.parameters is missing: ${missing.join(', ')}`);
  return { ...dataset, profileDocument: { name: dataset.profile, ...parameters } };
}

export function readYaml(path) {
  return parse(readFileSync(path, 'utf8'), { merge: true });
}

export function loadReference(ownerPath, references, name, schemaVersion, rootKey) {
  const reference = references[name];
  if (typeof reference !== 'string' || !reference.trim()) throw new TypeError(`references.${name} is required`);
  const path = resolve(dirname(ownerPath), reference);
  const document = requiredObject(name, readYaml(path));
  if (document.schemaVersion !== schemaVersion) throw new TypeError(`unsupported ${name} schemaVersion`);
  return { path, value: document[rootKey] };
}

export function loadOptionalPreset(ownerPath, run, scenario) {
  if (run.preset == null || run.preset === '') return null;
  const source = loadReference(ownerPath, run, 'preset', 'dropmong.loadtest.preset/v1', 'preset');
  const preset = requiredObject('preset', source.value);
  if (preset.scenario !== scenario) throw new TypeError(`preset.scenario must be ${scenario}`);
  if (typeof preset.name !== 'string' || !preset.name) throw new TypeError('preset.name is required');
  return { ...source, value: preset };
}

function serviceValuesName(service) {
  return service === 'dropmong-web' ? service : service.replace(/-service$/, '');
}

function namedContainerPort(container, name) {
  if (Number.isFinite(Number(name))) return Number(name);
  if (container.port && name === 'http') return Number(container.port);
  return Number(container.ports?.find((port) => port.name === name)?.containerPort);
}

export function resolveServiceTarget(environmentPath, environment, service) {
  const directory = environment.gitops?.serviceValuesDirectory;
  if (typeof directory !== 'string' || !directory) throw new TypeError('environment.gitops.serviceValuesDirectory is required');
  const path = resolve(dirname(environmentPath), directory, `${serviceValuesName(service)}.yaml`);
  const values = requiredObject(`service values for ${service}`, readYaml(path));
  const name = values.app?.name;
  const namespace = values.app?.namespace;
  const port = Number(values.service?.port);
  const readiness = values.container?.readinessProbe?.httpGet;
  const readinessPort = namedContainerPort(values.container ?? {}, readiness?.port);
  const ingressBaseUrl = environment.ingress?.baseUrl;
  if (!name || !namespace || !Number.isFinite(port) || !readiness?.path || !Number.isFinite(readinessPort)) throw new TypeError(`incomplete Helm service target for ${service}`);
  if (typeof ingressBaseUrl !== 'string' || !/^https?:\/\/[^/]+\/?$/.test(ingressBaseUrl)) throw new TypeError('environment.ingress.baseUrl must be an HTTP(S) origin');
  return {
    namespace,
    // k6 measures the same Istio ingress path that clients use. Readiness is
    // intentionally service-local so routing errors and Pod health stay distinct.
    baseUrl: ingressBaseUrl.replace(/\/+$/, ''),
    readinessUrl: `http://${name}.${namespace}.svc.cluster.local:${readinessPort}${readiness.path}`,
  };
}

export function resolveEnvironment(environmentSource) {
  const environment = requiredObject('environment', environmentSource.value);
  const loadtestValuesReference = environment.helm?.loadtestValues;
  if (typeof loadtestValuesReference !== 'string' || !loadtestValuesReference) throw new TypeError('environment.helm.loadtestValues is required');
  const loadtestValuesPath = resolve(dirname(environmentSource.path), loadtestValuesReference);
  const environmentValuesReference = environment.gitops?.environmentValues;
  if (typeof environmentValuesReference !== 'string' || !environmentValuesReference) throw new TypeError('environment.gitops.environmentValues is required');
  const environmentValuesPath = resolve(dirname(environmentSource.path), environmentValuesReference);
  const environmentValues = requiredObject('GitOps environment values', readYaml(environmentValuesPath));
  if (environmentValues.environment !== environment.gitops.environment) throw new TypeError('GitOps environment values do not match the environment binding');
  const prometheus = requiredObject('environment.observability.prometheusService', environment.observability?.prometheusService);
  if (!prometheus.namespace || !prometheus.name || !Number.isFinite(Number(prometheus.port))) throw new TypeError('Prometheus service namespace, name, and port are required');
  const tempo = requiredObject('environment.observability.tempoService', environment.observability?.tempoService);
  if (!tempo.namespace || !tempo.name || !Number.isFinite(Number(tempo.port))) throw new TypeError('Tempo service namespace, name, and port are required');
  const loadtestInputs = environment.loadtestInputs ?? environment.loadtestFixtures ?? {};
  if (!loadtestInputs || typeof loadtestInputs !== 'object' || Array.isArray(loadtestInputs)) {
    throw new TypeError('environment.loadtestInputs must be an object when provided');
  }
  const port = Number(prometheus.port);
  const tempoPort = Number(tempo.port);
  return {
    ...environment,
    kubernetesContext: { allowedNames: environment.safety?.allowedKubernetesContexts ?? [] },
    gitops: { ...environment.gitops, environmentValuesPath },
    helm: { ...environment.helm, loadtestValuesPath },
    prometheusUrl: `http://${prometheus.name}.${prometheus.namespace}.svc.cluster.local:${port}`,
    prometheusKubernetesProxyPath: `/api/v1/namespaces/${prometheus.namespace}/services/http:${prometheus.name}:${port}/proxy`,
    tempoUrl: `http://${tempo.name}.${tempo.namespace}.svc.cluster.local:${tempoPort}`,
    // These are references to pre-existing Dataset/k6 inputs. The common
    // runner consumes references only; local Task preparation owns creation.
    loadtestInputs,
    // Compatibility for existing RUN/environment documents during migration.
    loadtestFixtures: loadtestInputs,
  };
}

export function cleanupPolicy(run) {
  const lifecycle = run.lifecycle;
  if (lifecycle == null) return true;
  if (!lifecycle || typeof lifecycle !== 'object' || Array.isArray(lifecycle)) throw new TypeError('run.lifecycle must be an object when provided');
  if (lifecycle.cleanup != null && typeof lifecycle.cleanup !== 'boolean') throw new TypeError('run.lifecycle.cleanup must be boolean');
  return lifecycle.cleanup ?? true;
}

const EXECUTION_OVERRIDE_KEYS = new Set(['warmupSeconds', 'measureSeconds', 'confirmationMeasureSeconds', 'cooldownSeconds', 'repetitions', 'searchTolerance', 'maxSearchTrials']);
const PRESET_EXECUTION_KEYS = new Set([...EXECUTION_OVERRIDE_KEYS, 'independentTrials', 'serviceConcurrency', 'backlogStability']);
const CAPACITY_OVERRIDE_KEYS = new Set(['startRps', 'maxRps']);

function onlyKeys(name, value, allowed) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new TypeError(`${name} contains unsupported fields: ${unknown.join(', ')}`);
}

function capacityCondition(name, value) {
  const capacity = requiredObject(name, value);
  onlyKeys(name, capacity, CAPACITY_OVERRIDE_KEYS);
  const startRps = finite(`${name}.startRps`, capacity.startRps, { minimum: 1 });
  const maxRps = finite(`${name}.maxRps`, capacity.maxRps, { minimum: startRps });
  return { startRps, maxRps };
}

function staticPresetConditions(run, scenario, dataset, presetSource) {
  if (presetSource === null) {
    const legacy = requiredObject('scenario.legacyFallback', scenario.legacyFallback);
    const execution = requiredObject('scenario.legacyFallback.execution', legacy.execution);
    const capacity = requiredObject('scenario.legacyFallback.capacity', legacy.capacity);
    const defaultCapacity = capacityCondition('scenario.legacyFallback.capacity.default', capacity.default);
    const byService = capacity.services == null ? {} : requiredObject('scenario.legacyFallback.capacity.services', capacity.services);
    const services = Object.fromEntries((scenario.serviceOrder ?? []).map((service) => {
      const config = requiredObject(`scenario.services.${service}`, scenario.services?.[service]);
      const serviceCapacity = byService[service] == null
        ? defaultCapacity
        : { ...defaultCapacity, ...capacityCondition(`scenario.legacyFallback.capacity.services.${service}`, byService[service]) };
      return [service, { ...config, capacity: serviceCapacity }];
    }));
    return validatedOverrides(run, { ...scenario, execution, services });
  }
  const preset = presetSource.value;
  onlyKeys('preset', preset, new Set(['name', 'scenario', 'dataset', 'deployment', 'execution', 'capacity']));
  const datasetCondition = requiredObject('preset.dataset', preset.dataset);
  onlyKeys('preset.dataset', datasetCondition, new Set(['profile']));
  if (datasetCondition.profile !== dataset.profile) throw new TypeError('preset.dataset.profile must match run dataset.profile');
  const deployment = requiredObject('preset.deployment', preset.deployment);
  onlyKeys('preset.deployment', deployment, new Set(['replicas']));
  const replicas = finite('preset.deployment.replicas', deployment.replicas, { minimum: 1 });
  if (!Number.isInteger(replicas)) throw new TypeError('preset.deployment.replicas must be an integer');
  if (Number(run.deployment?.replicas) !== replicas) throw new TypeError('run.deployment.replicas must match preset.deployment.replicas');
  const execution = requiredObject('preset.execution', preset.execution);
  onlyKeys('preset.execution', execution, PRESET_EXECUTION_KEYS);
  for (const key of PRESET_EXECUTION_KEYS) {
    if (execution[key] == null) throw new TypeError(`preset.execution.${key} is required`);
  }
  const capacity = requiredObject('preset.capacity', preset.capacity);
  onlyKeys('preset.capacity', capacity, new Set(['default', 'services']));
  const defaultCapacity = capacityCondition('preset.capacity.default', capacity.default);
  const byService = capacity.services == null ? {} : requiredObject('preset.capacity.services', capacity.services);
  const unknownServices = Object.keys(byService).filter((service) => !(scenario.serviceOrder ?? []).includes(service));
  if (unknownServices.length) throw new TypeError(`preset.capacity.services contains unknown services: ${unknownServices.join(', ')}`);
  const services = Object.fromEntries((scenario.serviceOrder ?? []).map((service) => {
    const serviceCapacity = byService[service] == null
      ? defaultCapacity
      : { ...defaultCapacity, ...capacityCondition(`preset.capacity.services.${service}`, byService[service]) };
    const config = requiredObject(`scenario.services.${service}`, scenario.services?.[service]);
    return [service, { ...config, capacity: serviceCapacity }];
  }));
  return { ...scenario, execution: { ...execution }, services };
}

function validatedOverrides(run, scenario) {
  const overrides = run.overrides ?? {};
  const unknownGroups = Object.keys(overrides).filter((key) => !['execution', 'capacity'].includes(key));
  if (unknownGroups.length) throw new TypeError(`unknown run override groups: ${unknownGroups.join(', ')}`);
  const executionOverrides = overrides.execution ?? {};
  const capacityOverrides = overrides.capacity ?? {};
  const unknownExecution = Object.keys(executionOverrides).filter((key) => !EXECUTION_OVERRIDE_KEYS.has(key));
  const unknownCapacity = Object.keys(capacityOverrides).filter((key) => !CAPACITY_OVERRIDE_KEYS.has(key));
  if (unknownExecution.length) throw new TypeError(`unknown execution overrides: ${unknownExecution.join(', ')}`);
  if (unknownCapacity.length) throw new TypeError(`unknown capacity overrides: ${unknownCapacity.join(', ')}`);
  const services = Object.fromEntries(Object.entries(scenario.services ?? {}).map(([service, config]) => [service, {
    ...config,
    capacity: { ...config.capacity, ...capacityOverrides },
  }]));
  return { ...scenario, execution: { ...scenario.execution, ...executionOverrides }, services };
}

export function validateExperiment(document) {
  requiredObject('experiment', document);
  if (document.schemaVersion !== 'dropmong.loadtest.experiment/v1') throw new TypeError('unsupported experiment schemaVersion');
  if (document.scenario !== SCENARIO) throw new TypeError(`scenario must be ${SCENARIO}`);
  const run = requiredObject('run', document.run);
  if (!run.name) throw new TypeError('run.name is required');
  if (typeof run.verificationOnly !== 'boolean') throw new TypeError('run.verificationOnly must be boolean');
  if (typeof run.cleanup !== 'boolean') throw new TypeError('run.cleanup must be boolean');
  const replicas = finite('run.deployment.replicas', run.deployment?.replicas, { minimum: 1 });
  if (!Number.isInteger(replicas)) throw new TypeError('run.deployment.replicas must be an integer');
  const environment = requiredObject('environment', document.environment);
  if (!environment.name || !environment.gitops?.serviceReleaseSuffix || !Array.isArray(environment.kubernetesContext?.allowedNames) || !environment.helm?.loadtestValuesPath) throw new TypeError('resolved environment contract is incomplete');
  requiredObject('dataset', document.dataset);
  if (!document.dataset.profile || !document.dataset.revision || document.dataset.seed == null) throw new TypeError('dataset profile, revision, and seed are required');
  const profileDocument = requiredObject('dataset.profileDocument', document.dataset.profileDocument);
  if (profileDocument.name !== document.dataset.profile) throw new TypeError('dataset profileDocument name must match dataset.profile');
  if (document.fixedComparisonConditions?.datasetRevision !== document.dataset.revision || String(document.fixedComparisonConditions?.loadSeed) !== String(document.dataset.seed)) throw new TypeError('fixed comparison dataset revision and seed must match the selected dataset');
  requiredObject('execution', document.execution);
  finite('execution.warmupSeconds', document.execution.warmupSeconds);
  finite('execution.measureSeconds', document.execution.measureSeconds, { minimum: 1 });
  finite('execution.cooldownSeconds', document.execution.cooldownSeconds);
  finite('execution.repetitions', document.execution.repetitions, { minimum: 1 });
  finite('execution.searchTolerance', document.execution.searchTolerance, { minimum: 0.001, maximum: 1 });
  if (typeof document.execution.independentTrials !== 'boolean') throw new TypeError('execution.independentTrials must be boolean');
  if (finite('execution.serviceConcurrency', document.execution.serviceConcurrency, { minimum: 1 }) !== 1) throw new TypeError('execution.serviceConcurrency must remain sequential');
  const backlogStability = requiredObject('execution.backlogStability', document.execution.backlogStability);
  finite('execution.backlogStability.consecutiveChecks', backlogStability.consecutiveChecks, { minimum: 1 });
  finite('execution.backlogStability.checkIntervalSeconds', backlogStability.checkIntervalSeconds, { minimum: 1 });
  finite('execution.backlogStability.timeoutSeconds', backlogStability.timeoutSeconds, { minimum: 1 });
  finite('execution.backlogStability.maxKafkaLagGrowth', backlogStability.maxKafkaLagGrowth, { minimum: 0 });
  if (typeof backlogStability.requireNoPendingPods !== 'boolean') throw new TypeError('execution.backlogStability.requireNoPendingPods must be boolean');
  validateMetricSpecs(document.observability?.metricSpecs);
  if (!Array.isArray(document.serviceOrder) || document.serviceOrder.length !== 9 || new Set(document.serviceOrder).size !== 9) throw new TypeError('serviceOrder must contain nine unique services');
  requiredObject('services', document.services);
  for (const service of document.serviceOrder) {
    const config = requiredObject(`services.${service}`, document.services[service]);
    if (config.service !== service || !['go', 'python', 'node'].includes(config.runtime) || !config.workload || !config.baseUrl || !config.readinessUrl || !config.authentication?.method) throw new TypeError(`invalid service contract: ${service}`);
    if (!Array.isArray(config.endpointMix) || !config.endpointMix.length) throw new TypeError(`${service} endpointMix is required`);
    const fixturePools = new Set(document.dataset.fixturePools?.[service] ?? []);
    const unknownFixturePools = config.endpointMix.map((endpoint) => endpoint.fixturePool).filter((pool) => pool && !fixturePools.has(pool));
    if (unknownFixturePools.length) throw new TypeError(`${service} dataset is missing fixture pools: ${[...new Set(unknownFixturePools)].join(', ')}`);
    if (config.dependencies?.requireKafkaLag && !config.dependencies.kafkaLagQuery) throw new TypeError(`${service} kafkaLagQuery is required when Kafka lag is required`);
    const weight = config.endpointMix.reduce((sum, endpoint) => sum + finite(`${service}.${endpoint.name}.weight`, endpoint.weight, { minimum: 1 }), 0);
    if (weight !== 100) throw new TypeError(`${service} endpoint weights must total 100`);
    finite(`${service}.capacity.startRps`, config.capacity?.startRps, { minimum: 1 });
    finite(`${service}.capacity.maxRps`, config.capacity?.maxRps, { minimum: config.capacity.startRps });
    finite(`${service}.slo.errorRate`, config.slo?.errorRate, { maximum: 1 });
    finite(`${service}.slo.actualRpsTolerance`, config.slo?.actualRpsTolerance, { maximum: 1 });
    finite(`${service}.slo.p95Ms`, config.slo?.p95Ms, { minimum: 1 });
    finite(`${service}.slo.p99Ms`, config.slo?.p99Ms, { minimum: config.slo.p95Ms });
    requiredObject(`${service}.podResources`, config.podResources);
  }
  return document;
}

export function validateMetricSpecs(metricSpecs) {
  if (!Array.isArray(metricSpecs) || metricSpecs.length !== 3) throw new TypeError('observability.metricSpecs must contain CPU, memory, and restart metrics');
  const expected = new Set(['cpu_utilization', 'memory_utilization', 'pod_restarts']);
  const seen = new Set();
  for (const spec of metricSpecs) {
    const metric = requiredObject('observability.metricSpec', spec);
    if (typeof metric.id !== 'string' || !expected.has(metric.id) || seen.has(metric.id)) throw new TypeError('observability.metricSpecs has invalid ids');
    if (typeof metric.query !== 'string' || !metric.query.includes('{{namespace}}') || !metric.query.includes('{{service}}')) throw new TypeError(`observability.metricSpecs.${metric.id} requires namespace and service query templates`);
    if (typeof metric.unit !== 'string' || !metric.unit) throw new TypeError(`observability.metricSpecs.${metric.id}.unit is required`);
    if (typeof metric.required !== 'boolean') throw new TypeError(`observability.metricSpecs.${metric.id}.required must be boolean`);
    seen.add(metric.id);
  }
  if (seen.size !== expected.size) throw new TypeError('observability.metricSpecs is incomplete');
  return metricSpecs;
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
  const dataset = datasetWithProfileDocument(datasetSource.value);
  const scenarioPath = scenarioSource.path;
  const rawScenario = requiredObject('scenario document', readYaml(scenarioPath));
  const presetSource = loadOptionalPreset(runPath, run, SCENARIO);
  const scenarioDocument = staticPresetConditions(run, rawScenario, dataset, presetSource);
  if (scenarioDocument.schemaVersion !== 'dropmong.loadtest.scenario/v1') throw new TypeError('unsupported scenario schemaVersion');
  if (scenarioDocument.scenario !== SCENARIO) throw new TypeError(`scenario must be ${SCENARIO}`);
  const environment = resolveEnvironment(environmentSource);
  const cleanup = cleanupPolicy(run);
  const services = Object.fromEntries((scenarioDocument.serviceOrder ?? []).map((service) => [service, {
    ...requiredObject(`scenario.services.${service}`, scenarioDocument.services?.[service]),
    ...resolveServiceTarget(environmentSource.path, environment, service),
  }]));
  return validateExperiment({
    ...scenarioDocument,
    schemaVersion: 'dropmong.loadtest.experiment/v1',
    run: {
      name: run.name,
      verificationOnly: run.verification_only,
      deployment: requiredObject('run.deployment', run.deployment),
      cleanup,
      // Keep the cleanup shape temporarily for older callers; image build and
      // deployment-preparation flags are deliberately ignored.
      lifecycle: { cleanup },
      preset: presetSource?.value.name ?? null,
      overrides: presetSource === null ? run.overrides ?? {} : {},
    },
    services,
    environment,
    dataset,
    fixedComparisonConditions: {
      ...scenarioDocument.fixedComparisonConditions,
      datasetRevision: dataset.revision,
      loadSeed: dataset.seed,
    },
    sources: {
      run: runPath,
      scenario: scenarioPath,
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
  return experiment.serviceOrder.filter((item) => new Set(requested).has(item));
}

export function workloadProfile(experiment, service) {
  const config = experiment.services[service];
  if (!config) throw new TypeError(`unknown service: ${service}`);
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
    adaptive: {
      startRps: config.capacity.startRps,
      maxRps: config.capacity.maxRps,
      rpsTolerance: config.slo.actualRpsTolerance,
      trialWarmupSeconds: experiment.execution.warmupSeconds,
      trialMeasureSeconds: experiment.execution.measureSeconds,
      cooldownSeconds: experiment.execution.cooldownSeconds,
      searchTolerance: experiment.execution.searchTolerance,
      maxTrials: experiment.execution.maxSearchTrials,
      confirmationMeasureSeconds: experiment.execution.confirmationMeasureSeconds,
      repetitions: experiment.execution.repetitions,
    },
    thresholds: {
      errorRate: config.slo.errorRate,
      checkPassRate: config.slo.checkPassRate,
      p95Ms: config.slo.p95Ms,
      p99Ms: config.slo.p99Ms,
      maxCpuUtilization: config.slo.maxCpuUtilization,
      maxCpuThrottleRatio: config.slo.maxCpuThrottleRatio,
      maxMemoryUtilization: config.slo.maxMemoryUtilization,
      maxPostgresqlPoolExhaustions: config.slo.maxPostgresqlPoolExhaustions,
      maxKafkaLagGrowth: config.slo.maxKafkaLagGrowth,
    },
    observability: {
      ...(experiment.observability ?? {}),
      ...serviceObservability,
      metricSpecs: experiment.observability?.metricSpecs ?? [],
    },
  };
}

export function confirmedCapacity(capacityResult) {
  const confirmations = capacityResult?.confirmation?.repetitions ?? [];
  if (!confirmations.length || !confirmations.every((trial) => trial.decision?.passed && trial.decision?.conclusive)) return null;
  const rps = confirmations.map((trial) => Number(trial.metrics?.target_rps));
  return rps.every(Number.isFinite) && new Set(rps).size === 1 ? rps[0] : null;
}

export async function runSequentialPipeline({ experiment, services, hooks }) {
  const results = [];
  for (const service of services) {
    let capacity = null;
    let error = null;
    try {
      await hooks.checkReadiness(service);
      await hooks.checkMigration(service);
      await hooks.deployReplicas(service, experiment.run.deployment.replicas);
      capacity = await hooks.runCapacitySearch(service, experiment.run.deployment.replicas);
      await hooks.waitForStability(service, experiment.run.deployment.replicas);
    } catch (caught) { error = caught; }
    results.push({ service, replicas: experiment.run.deployment.replicas, capacity, error });
    await hooks.persistServiceResult(results.at(-1));
  }
  return results;
}

async function main() {
  const root = resolve(dirname(new URL(import.meta.url).pathname), '..', '..');
  const path = process.argv[2] ?? resolve(root, 'values', 'runs', 'local-smoke-replicas-1.yaml');
  const experiment = loadExperiment(path);
  const service = process.argv[3] ?? 'all';
  process.stdout.write(`${JSON.stringify({ scenario: experiment.scenario, services: selectServices(experiment, service) })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
