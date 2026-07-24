import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

function requireFile(path, label, exists = existsSync) {
  if (!exists(path)) throw new TypeError(`${label} is unavailable: ${path}`);
  return path;
}

function setString(key, value) {
  return ['--set-string', `${key}=${value}`];
}

/**
 * The load-test runner must apply exactly the same file layering as `task dev`.
 * Baseline dev Helm settings are applied for both apply and restore; the replica
 * value is the only measurement-specific change.
 */
export function devReleaseContract(experiment, service, { exists = existsSync } = {}) {
  const gitops = experiment.environment?.gitops ?? {};
  const environmentSource = experiment.sources?.environment;
  if (!environmentSource) throw new TypeError('environment source is unavailable');
  const root = dirname(environmentSource);
  const serviceKey = service.replace(/-service$/, '');
  const serviceValuesDirectory = resolve(root, gitops.serviceValuesDirectory ?? '');
  const files = [
    requireFile(resolve(root, gitops.baseValues ?? ''), 'base values', exists),
    requireFile(resolve(root, gitops.environmentValues ?? ''), 'environment values', exists),
    requireFile(join(serviceValuesDirectory, `${serviceKey}.yaml`), 'service values', exists),
  ];
  const serviceEnvironmentDirectory = gitops.serviceEnvironmentValuesDirectory
    ? resolve(root, gitops.serviceEnvironmentValuesDirectory)
    : null;
  const overrideDirectory = gitops.serviceOverrideValuesDirectory
    ? resolve(root, gitops.serviceOverrideValuesDirectory)
    : null;
  for (const optional of [
    serviceEnvironmentDirectory && join(serviceEnvironmentDirectory, `${serviceKey}.yaml`),
    overrideDirectory && join(overrideDirectory, `${serviceKey}.yaml`),
  ]) {
    if (optional && exists(optional)) files.push(optional);
  }
  if (!gitops.chart || !gitops.serviceReleaseSuffix) throw new TypeError('dev Helm chart or release suffix is unavailable');
  return {
    chart: requireFile(resolve(root, gitops.chart), 'service chart', exists),
    files,
    namespace: experiment.services?.[service]?.namespace,
    release: `${serviceKey}-${gitops.serviceReleaseSuffix}`,
    autoscaler: experiment.services?.[service]?.autoscaler ?? {},
    baseHelmSet: gitops.devHelmSet ?? {},
  };
}

export function helmSetArgs(values) {
  const args = [];
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'boolean' || typeof value === 'number') args.push('--set', `${key}=${value}`);
    else if (value && typeof value === 'object') args.push('--set-json', `${key}=${JSON.stringify(value)}`);
    else args.push(...setString(key, String(value)));
  }
  return args;
}

export function autoscalerOverrideSets(autoscaler = {}) {
  const overrides = {};
  if (autoscaler.hpa?.enabled === true) overrides['hpa.enabled'] = false;
  if (autoscaler.keda?.enabled === true) overrides['keda.enabled'] = false;
  return overrides;
}

export function replicaApplyArgs(contract, replicas) {
  if (!contract.namespace) throw new TypeError('service namespace is unavailable');
  if (!Number.isSafeInteger(replicas) || replicas < 1) throw new TypeError('replicas must be a positive integer');
  return [
    'upgrade', '--install', contract.release, contract.chart,
    '--namespace', contract.namespace, '--create-namespace',
    // `task dev` owns schema migration. Measuring replicas must not create a
    // migration hook Job or turn a deployment prerequisite into test traffic.
    '--no-hooks',
    ...contract.files.flatMap((file) => ['-f', file]),
    ...helmSetArgs(contract.baseHelmSet ?? {}),
    ...helmSetArgs(autoscalerOverrideSets(contract.autoscaler)),
    '--set', `deployment.replicas=${replicas}`,
  ];
}

export function replicaRestoreArgs(contract) {
  if (!contract.namespace) throw new TypeError('service namespace is unavailable');
  return [
    'upgrade', '--install', contract.release, contract.chart,
    '--namespace', contract.namespace, '--create-namespace',
    '--no-hooks',
    ...contract.files.flatMap((file) => ['-f', file]),
    ...helmSetArgs(contract.baseHelmSet ?? {}),
    // An autoscaler override is only a temporary measurement aid and must not
    // survive the restore operation.
  ];
}

export function fixtureConfigurationFailures(experiment, services) {
  const fixtures = experiment.environment?.loadtestInputs ?? experiment.environment?.loadtestFixtures;
  const failures = [];
  for (const service of services) {
    const needsDataset = service === 'dropmong-web' ? 'catalog-service' : service;
    const entry = fixtures?.[needsDataset];
    if (!entry?.dataset?.existingSecret) {
      failures.push({ service, category: 'configuration', message: `${needsDataset} dataset fixture reference is unavailable` });
      continue;
    }
    if (['auth-service', 'coupon-service'].includes(service) && !entry.k6?.existingSecret) {
      failures.push({ service, category: 'configuration', message: `${service} k6 fixture reference is unavailable` });
    }
    if (service === 'coupon-service' && !entry.coupon?.existingSecret) {
      failures.push({ service, category: 'configuration', message: 'coupon-service coupon fixture reference is unavailable' });
    }
  }
  return failures;
}
