#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { datasetCacheKey, validateCacheFiles } from '../datasets/cache.js';
import { writeCapacities } from '../lib/deterministic-data.js';
import {
  buildLiveResult as buildStaticLiveResult,
  buildRunReport as buildStaticRunReport,
} from '../scenarios/service-static-replica-capacity-load-test/report.js';
import {
  buildLiveResult as buildRampLiveResult,
  buildRunReport as buildRampRunReport,
} from '../scenarios/service-bottleneck-ramp-load-test/report.js';
import { executeService as executeStaticCapacity } from '../scenarios/service-static-replica-capacity-load-test/runner.js';
import { executeService as executeBottleneckRamp } from '../scenarios/service-bottleneck-ramp-load-test/runner.js';
import { collectObservabilitySnapshot } from '../lib/observability.js';
import { parseTraceparent, summarizeTempoRoutes, unavailableTraceSummary } from '../lib/tempo.js';
import {
  devReleaseContract,
  replicaApplyArgs,
  replicaRestoreArgs,
} from '../lib/dev-rollout.js';
import {
  loadExperiment,
  selectServices,
  workloadProfile,
} from '../scenarios/registry.js';
import { SCENARIO as STATIC_SCENARIO } from '../scenarios/service-static-replica-capacity-load-test/execute.js';
import { SCENARIO as RAMP_SCENARIO } from '../scenarios/service-bottleneck-ramp-load-test/execute.js';
import { commandExists, LoadtestError, parseArgs, readJson, run, sanitize, utcNow, writeJsonAtomic } from './lib/io.js';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
const GITOPS_ROOT = resolve(ROOT, '..', '..');
const SERVICE_ROOT = resolve(GITOPS_ROOT, '..', 'service');
export const SERVICES = ['auth-service', 'user-service', 'catalog-service', 'coupon-service', 'interest-service', 'order-service', 'payment-service', 'notification-service', 'dropmong-web'];
export const TEST_SCENARIOS = {
  [STATIC_SCENARIO]: { mode: 'static-replica-capacity', confirmation: true },
  [RAMP_SCENARIO]: { mode: 'bottleneck-ramp', confirmation: false },
};

const SCENARIO_HANDLERS = {
  [STATIC_SCENARIO]: {
    executeService: executeStaticCapacity,
    reporter: { buildLiveResult: buildStaticLiveResult, buildRunReport: buildStaticRunReport },
  },
  [RAMP_SCENARIO]: {
    executeService: executeBottleneckRamp,
    reporter: { buildLiveResult: buildRampLiveResult, buildRunReport: buildRampRunReport },
  },
};

const SERVICE_KEYS = Object.fromEntries(SERVICES.map((service) => [service, service.replace(/-service$/, '')]));
const LOCAL_CONTEXT = /(docker-desktop|kind|k3d|minikube|rancher-desktop|colima)/i;
const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

function recursiveFiles(directory, predicate = () => true) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? recursiveFiles(path, predicate) : predicate(path) ? [path] : [];
  });
}

function contentRevision(root, files) {
  const digest = createHash('sha256');
  for (const path of [...files].sort()) digest.update(relative(root, path)).update('\0').update(readFileSync(path)).update('\0');
  return digest.digest('hex');
}

export function datasetGeneratorRevision(root = ROOT) {
  const files = [
    ...recursiveFiles(join(root, 'datasets'), (path) => path.endsWith('.js') || path.endsWith('Dockerfile')),
    join(root, 'lib', 'deterministic-data.js'),
    join(root, 'package-lock.json'),
  ].filter(existsSync);
  return contentRevision(root, files);
}

export function datasetSchemaIdentifiers(serviceRoot = SERVICE_ROOT) {
  const result = {};
  for (const service of SERVICES.filter((value) => value.endsWith('-service'))) {
    const directory = join(serviceRoot, 'services', service);
    const files = recursiveFiles(directory, (path) => {
      if (!/\.(?:sql|py|go|ts|js)$/.test(path)) return false;
      if (/(?:migration|migrations|schema)/i.test(relative(directory, path))) return true;
      return /(?:CREATE|ALTER)\s+TABLE|__tablename__|create_all\s*\(/i.test(readFileSync(path, 'utf8'));
    });
    if (!files.length) throw new LoadtestError('configuration', `${service} schema/migration source를 찾지 못했습니다`);
    result[service] = contentRevision(directory, files);
  }
  return result;
}

export function datasetRestoreServices(service) {
  if (service === 'dropmong-web') return ['catalog-service'];
  if (service === 'order-service') return ['auth-service', 'order-service', 'payment-service'];
  // Bearer-token workloads authenticate with the deterministic users generated
  // by the auth dataset. Seed that dependency in the same Dataset Job so the
  // runtime password and user IDs always match the target dataset.
  if (['user-service', 'coupon-service', 'interest-service', 'payment-service', 'notification-service'].includes(service)) {
    return ['auth-service', service];
  }
  return service.endsWith('-service') ? [service] : [];
}

export function formatProgress(event, details = {}, timestamp = utcNow()) {
  const safeDetails = sanitize(details);
  const fields = Object.entries(safeDetails)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`);
  return `[loadtest ${timestamp}] ${event}${fields.length ? ` ${fields.join(' ')}` : ''}`;
}

export function formatFailureSummary(execution, outputDirectory) {
  const failures = Array.isArray(execution.failures) ? execution.failures : [];
  const lines = ['[loadtest] 실행 실패 요약'];
  if (failures.length) {
    for (const failure of failures) {
      const category = sanitize(failure.category ?? 'unexpected');
      const service = failure.service ? ` ${sanitize(failure.service)}:` : ':';
      lines.push(`- [${category}]${service} ${sanitize(failure.message ?? '상세 원인이 기록되지 않았습니다')}`);
    }
  } else lines.push(`- [${sanitize(execution.status ?? 'unknown')}] 상세 원인은 result.json을 확인하세요.`);
  lines.push(`- result: ${join(outputDirectory, 'result.json')}`);
  lines.push(`- analysis: ${join(outputDirectory, 'analysis.md')}`);
  return lines.join('\n');
}

export function diagnosticTail(value, maxLines = 8) {
  const lines = String(sanitize(value ?? '')).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const errors = lines.filter((line) => /(error|failed|fatal|panic|exception|reason)/i.test(line));
  return (errors.length ? errors : lines).slice(-maxLines).join(' | ').slice(-2000);
}

export function validateServices(raw) {
  const requested = String(raw ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  if (!requested.length || requested[0] === 'all') return [...SERVICES];
  const unknown = requested.filter((service) => !SERVICES.includes(service));
  if (unknown.length) throw new LoadtestError('configuration', `unknown services: ${unknown.join(', ')}`);
  return [...new Set(requested)];
}

export function safeRunId(value = null) {
  const source = value ?? `run-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'z')}`;
  const normalized = source.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^[-.]|[-.]$/g, '').slice(0, 48);
  if (!/^[a-z0-9][a-z0-9.-]{0,62}$/.test(normalized)) throw new LoadtestError('configuration', `invalid run id: ${value}`);
  return normalized;
}

export function traceProbeFor(runId, service, trialId) {
  const source = `${runId}|${service}|${trialId}`;
  const traceId = createHash('sha256').update(`trace|${source}`).digest('hex').slice(0, 32);
  const parentSpanId = createHash('sha256').update(`parent|${source}`).digest('hex').slice(0, 16);
  return { trace_id: traceId, parent_span_id: parentSpanId, traceparent: `00-${traceId}-${parentSpanId}-01` };
}

export function boundedResourceName(prefix, runId, maxLength) {
  const full = `${prefix}${runId}`;
  if (full.length <= maxLength) return full;
  const suffix = createHash('sha256').update(runId).digest('hex').slice(0, 8);
  return `${full.slice(0, maxLength - suffix.length - 1).replace(/[-.]$/, '')}-${suffix}`;
}

export function helmOverrideArgs(key, value) {
  if (typeof value === 'boolean' || typeof value === 'number') return ['--set', `${key}=${value}`];
  const escaped = String(value).replaceAll('\\', '\\\\').replaceAll(',', '\\,');
  return ['--set-string', `${key}=${escaped}`];
}

export function splitContainerImage(reference) {
  const slash = reference.lastIndexOf('/');
  const colon = reference.lastIndexOf(':');
  if (slash <= 0 || colon <= slash + 1 || colon === reference.length - 1) throw new LoadtestError('configuration', `image reference must include registry, repository, and tag: ${reference}`);
  return { registry: reference.slice(0, slash), repository: reference.slice(slash + 1, colon), tag: reference.slice(colon + 1) };
}

export function releaseRevisionFromStatus(document) {
  const revision = Number(document?.version);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new LoadtestError('replica_deploy', 'Helm release revision을 확인하지 못했습니다');
  return revision;
}

export function currentRevisionReadyPods(deployment, replicaSets, pods) {
  const revision = deployment?.metadata?.annotations?.['deployment.kubernetes.io/revision'];
  const deploymentUid = deployment?.metadata?.uid;
  const current = replicaSets.find((replicaSet) => replicaSet.metadata?.annotations?.['deployment.kubernetes.io/revision'] === revision
    && replicaSet.metadata?.ownerReferences?.some((owner) => owner.uid === deploymentUid));
  if (!current?.metadata?.uid) return [];
  return pods.filter((pod) => !pod.metadata?.deletionTimestamp
    && pod.metadata?.ownerReferences?.some((owner) => owner.uid === current.metadata.uid)
    && pod.status?.conditions?.some((condition) => condition.type === 'Ready' && condition.status === 'True'));
}

export function warmupExitAction(code) {
  if (code === 0) return 'success';
  return [99, 201].includes(code) ? 'continue_after_threshold_failure' : 'script_failure';
}

// Stateful deterministic ranges are consumed by every k6 trial for one service. The
// allocator deliberately has no time-derived reset, so warmup cannot reuse a
// completed payment or another one-shot business resource during measurement.
export function planWriteAllocations(profile, datasetProfile, offsets, targetRps, durationSeconds) {
  const endpoints = profile.endpointMix ?? [];
  const totalWeight = endpoints.reduce((sum, endpoint) => sum + Number(endpoint.weight ?? 0), 0);
  if (!Number.isFinite(totalWeight) || totalWeight <= 0) throw new LoadtestError('runtime_addressing', 'endpoint mix weight is invalid');
  const pools = new Map();
  for (const endpoint of endpoints) {
    if (endpoint.addressAccess !== 'write' || !endpoint.addressPool) continue;
    const weight = Number(endpoint.weight ?? 0);
    if (!Number.isFinite(weight) || weight <= 0) continue;
    pools.set(endpoint.addressPool, (pools.get(endpoint.addressPool) ?? 0) + weight);
  }
  const capacities = writeCapacities(datasetProfile);
  const allocations = {};
  for (const [pool, weight] of pools) {
    const size = Math.max(1, Math.ceil(Number(targetRps) * Number(durationSeconds) * weight / totalWeight) + 2);
    const start = Number(offsets[pool] ?? 0);
    if (!Number.isSafeInteger(start) || start < 0) throw new LoadtestError('runtime_addressing', `runtime address range ${pool} offset is invalid`);
    const capacity = capacities[pool];
    if (!Number.isSafeInteger(capacity) || capacity <= 0 || start + size > capacity) {
      throw new LoadtestError('runtime_addressing', `runtime address range ${pool} exhausted: required end ${start + size}, capacity ${capacity ?? 'unknown'}`);
    }
    allocations[pool] = { start, size };
    offsets[pool] = start + size;
  }
  return allocations;
}

// Kept as a public helper for verification-only static smoke tests. It only
// distinguishes k6 execution failures from scenario performance evaluation.
export function verificationDecision(performanceDecision) {
  const executionReasons = performanceDecision.reasons.filter((reason) => reason.category === 'execution');
  return {
    passed: executionReasons.length === 0,
    conclusive: executionReasons.length === 0,
    threshold_passed: null,
    k6_exit_code: performanceDecision.k6_exit_code,
    criteria: 'execution_only',
    reasons: executionReasons,
    performance_evaluation: {
      applied: false,
      passed: performanceDecision.passed,
      conclusive: performanceDecision.conclusive,
      threshold_passed: performanceDecision.threshold_passed,
      reasons: performanceDecision.reasons,
    },
  };
}

export function contextApproved(context, allowedContexts = null) {
  return Array.isArray(allowedContexts) ? allowedContexts.includes(context) : LOCAL_CONTEXT.test(context);
}

export function integerCandidate(value, state) {
  let candidate = Math.max(Math.round(value), Math.ceil(state.start_rps));
  candidate = Math.min(candidate, Math.floor(state.max_rps));
  if (state.last_pass_rps != null) candidate = Math.max(candidate, Math.floor(state.last_pass_rps) + 1);
  if (state.first_fail_rps != null) candidate = Math.min(candidate, Math.ceil(state.first_fail_rps) - 1);
  const attempted = new Set(state.trials.filter((trial) => trial.metrics).map((trial) => Math.trunc(trial.metrics.target_rps)));
  return candidate < state.start_rps || candidate > state.max_rps || attempted.has(candidate) ? null : candidate;
}

function gitState(repository) {
  return {
    sha: run('git', ['rev-parse', 'HEAD'], { cwd: repository }).stdout.trim(),
    dirty: Boolean(run('git', ['status', '--short', '--untracked-files=normal'], { cwd: repository }).stdout.trim()),
  };
}

function toolVersions() {
  const commands = {
    docker: ['docker', ['version', '--format', '{{.Client.Version}}']],
    kubectl: ['kubectl', ['version', '--client', '-o', 'json']],
    helm: ['helm', ['version', '--short']],
    task: ['task', ['--version']],
    k6: ['k6', ['version']],
    node: ['node', ['--version']],
  };
  const versions = {};
  for (const [name, [command, args]] of Object.entries(commands)) {
    if (!commandExists(command)) throw new LoadtestError('environment', `required tool is unavailable: ${command}`);
    versions[name] = run(command, args).stdout.trim().slice(0, 500);
  }
  return versions;
}

export function preflight({ allowedContexts = null } = {}) {
  const tools = toolVersions();
  const context = run('kubectl', ['config', 'current-context']).stdout.trim();
  if (!contextApproved(context, allowedContexts)) {
    throw new LoadtestError('environment', `Kubernetes context is not approved by the selected environment: ${context}`);
  }
  const nodes = JSON.parse(run('kubectl', ['get', 'nodes', '-o', 'json']).stdout).items ?? [];
  const nodeRows = nodes.map((node) => ({
    name: node.metadata.name,
    cpu: node.status?.capacity?.cpu,
    memory: node.status?.capacity?.memory,
    ready: node.status?.conditions?.some((condition) => condition.type === 'Ready' && condition.status === 'True') ?? false,
  }));
  if (!nodeRows.length || nodeRows.some((node) => !node.ready)) throw new LoadtestError('environment', 'local Kubernetes nodes are not all Ready');
  return { checked_at: utcNow(), kubernetes_context: context, nodes: nodeRows, tools };
}

function unavailableSnapshot({ startedAt, finishedAt, service, namespace, replicas, runId, reason }) {
  return {
    schema_version: 'dropmong.loadtest.observability-snapshot/v1',
    status: 'unavailable',
    window: { started_at: startedAt, finished_at: finishedAt },
    run_id: runId,
    service,
    namespace,
    replicas,
    metrics: {},
    reason: sanitize(reason).slice(0, 300),
  };
}

export class Orchestrator {
  constructor(options) {
    this.options = options;
    this.namespace = options.experiment.environment.loadtestNamespace
      ?? boundedResourceName('dropmong-loadtest-', options.runId, 63);
    this.persistentNamespace = Boolean(options.experiment.environment.loadtestNamespace);
    this.release = boundedResourceName('dm-load-', options.runId, 53);
    this.localRunDir = join(options.localOutput, options.runId);
    this.experiment = options.experiment;
    this.handler = SCENARIO_HANDLERS[options.scenario];
    if (!this.handler) throw new LoadtestError('configuration', `unknown test scenario: ${options.scenario}`);
    this.profiles = Object.fromEntries(options.services.map((service) => [service, workloadProfile(this.experiment, service)]));
    this.trials = [];
    this.artifactPod = null;
    this.images = {};
    this.serviceReleaseSnapshots = new Map();
    this.writeAddressOffsets = new Map();
    this.datasetCacheStaged = false;
    this.datasetGeneratorRevision = datasetGeneratorRevision();
    this.datasetSchemaIdentifiers = datasetSchemaIdentifiers();
    this.datasetCacheIdentity = {
      dataset: {
        profile: this.experiment.dataset.profile,
        parameters: this.experiment.dataset.profileDocument,
        runtimeAddressing: this.experiment.dataset.runtimeAddressing,
      },
      seed: this.experiment.dataset.seed,
      revision: this.experiment.dataset.revision,
      generatorRevision: this.datasetGeneratorRevision,
      schemaIdentifiers: this.datasetSchemaIdentifiers,
      credentialFingerprint: null,
    };
    this.datasetCacheKey = datasetCacheKey(this.datasetCacheIdentity);
    this.datasetCacheRoot = join(ROOT, 'tmp', 'datasets');
    this.datasetCacheDirectory = join(this.datasetCacheRoot, this.datasetCacheKey);
    this.execution = {
      schema_version: 'dropmong.loadtest.execution/v3',
      run_id: options.runId,
      run_definition: this.experiment.run.name,
      preset: this.experiment.run.preset ?? null,
      verification_only: this.experiment.run.verificationOnly,
      scenario: options.scenario,
      mode: options.mode,
      replicas: this.experiment.run.deployment.replicas,
      status: 'initializing',
      started_at: utcNow(),
      finished_at: null,
      namespace: this.namespace,
      release: this.release,
      experiment: {
        path: relative(GITOPS_ROOT, this.experiment.sources.run),
        schema_version: this.experiment.schemaVersion,
        sources: Object.fromEntries(Object.entries(this.experiment.sources).map(([name, path]) => [name, relative(GITOPS_ROOT, path)])),
      },
      services: Object.fromEntries(options.services.map((service) => [service, {
        status: 'pending',
        workload: this.profiles[service].workload,
        dependencies: this.profiles[service].dependencies ?? {},
        replicas: this.experiment.run.deployment.replicas,
        conditions: null,
        capacity: null,
        ramp: null,
      }])),
      dataset: {
        profile: this.experiment.dataset.profile,
        seed: String(this.experiment.dataset.seed),
        revision: this.experiment.dataset.revision,
        runtime_addressing_strategy: this.experiment.dataset.runtimeAddressing.strategy,
        cache: {
          key: this.datasetCacheKey,
          local_directory: relative(ROOT, this.datasetCacheDirectory),
          candidate: existsSync(join(this.datasetCacheDirectory, 'manifest.json')),
          status: 'pending',
          service_status: {},
          events: [],
          totals: { generation_seconds: 0, copy_seconds: 0, snapshot_seconds: 0, restore_seconds: 0, analyze_seconds: 0, rows: 0, snapshot_bytes: 0 },
        },
      },
      fixed_comparison_conditions: this.experiment.fixedComparisonConditions,
      git: { gitops: gitState(GITOPS_ROOT), service: gitState(SERVICE_ROOT) },
      images: {},
      failures: [],
    };
  }

  progress(event, details = {}) {
    console.log(formatProgress(event, { run: this.options.runId, ...details }));
  }

  writeState() {
    const resultPath = join(this.localRunDir, 'result.json');
    const previous = existsSync(resultPath) ? readJson(resultPath) : null;
    writeJsonAtomic(resultPath, this.handler.reporter.buildLiveResult(this.execution, this.trials, previous));
  }

  syncState() {
    this.writeState();
    if (this.artifactPod) this.artifactCopyFromLocal(join(this.localRunDir, 'result.json'), 'result.json');
  }

  fail(category, message, service = null) {
    this.execution.failures.push({
      timestamp: utcNow(),
      category,
      message: sanitize(message).slice(0, 1500),
      ...(service ? { service } : {}),
    });
    if (service) this.execution.services[service].status = 'failed';
  }

  serviceNamespace(service) {
    const namespace = this.experiment.services[service]?.namespace;
    if (!namespace) throw new LoadtestError('configuration', `service namespace is unavailable: ${service}`);
    return namespace;
  }

  serviceRelease(service) {
    return `${SERVICE_KEYS[service]}-${this.experiment.environment.gitops.serviceReleaseSuffix}`;
  }

  configureImages() {
    const configured = this.experiment.environment.loadtestImages;
    if (!configured || !['k6', 'seeder', 'tools'].every((name) => typeof configured[name] === 'string' && configured[name])) {
      throw new LoadtestError('configuration', 'prebuilt k6, seeder, and tools image references are required');
    }
    this.images = { ...configured };
    for (const [name, reference] of Object.entries(this.images)) {
      this.execution.images[name] = { reference, identity: 'configured-not-inspected' };
    }
  }

  waitServiceReadiness(service) {
    const timeoutSeconds = Number(this.experiment.environment?.gitops?.rolloutTimeoutSeconds ?? 300);
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0) {
      throw new LoadtestError('configuration', 'gitops.rolloutTimeoutSeconds must be a positive integer');
    }
    run('kubectl', ['rollout', 'status', `deployment/${service}`, '-n', this.serviceNamespace(service), `--timeout=${timeoutSeconds}s`], { category: 'readiness' });
  }

  checkMigration(service) {
    if (service === 'dropmong-web') return;
    const namespace = this.serviceNamespace(service);
    const result = run('kubectl', ['get', 'jobs', '-n', namespace, '-o', 'json'], { category: 'migration' });
    const jobs = (JSON.parse(result.stdout).items ?? []).filter((job) => /migration/i.test(job.metadata?.name ?? ''));
    const failed = jobs.filter((job) => Number(job.status?.failed ?? 0) > 0 && Number(job.status?.succeeded ?? 0) === 0);
    if (failed.length) throw new LoadtestError('migration', `${service} migration Job failed: ${failed.map((job) => job.metadata.name).join(', ')}`);
  }

  snapshotServiceRelease(service) {
    if (this.serviceReleaseSnapshots.has(service)) return this.serviceReleaseSnapshots.get(service);
    const contract = devReleaseContract(this.experiment, service);
    const snapshot = {
      release: contract.release,
      namespace: contract.namespace,
      contract,
      restoration_method: 'reapply-layered-dev-values',
    };
    this.serviceReleaseSnapshots.set(service, snapshot);
    this.execution.services[service].restoration = {
      release: snapshot.release,
      namespace: snapshot.namespace,
      method: snapshot.restoration_method,
      status: 'pending',
    };
    return snapshot;
  }

  restoreServiceReleases() {
    const failures = [];
    const snapshots = [...this.serviceReleaseSnapshots.entries()].reverse();
    this.serviceReleaseSnapshots.clear();
    for (const [service, snapshot] of snapshots) {
      try {
        run('helm', replicaRestoreArgs(snapshot.contract), { category: 'service_restore' });
        this.waitServiceReadiness(service);
        this.execution.services[service].restoration = { ...snapshot, status: 'restored', restored_at: utcNow() };
      } catch (error) {
        const message = sanitize(error.message).slice(0, 1500);
        this.execution.services[service].restoration = { ...snapshot, status: 'failed', error: message };
        failures.push({ service, message });
      }
    }
    return failures;
  }

  async deployReplicas(service) {
    const replicas = this.experiment.run.deployment.replicas;
    const namespace = this.serviceNamespace(service);
    const snapshot = this.snapshotServiceRelease(service);
    run('helm', replicaApplyArgs(snapshot.contract, replicas), { category: 'replica_deploy' });
    this.waitServiceReadiness(service);
    const hpa = run('kubectl', ['get', 'hpa', '-n', namespace, '-o', 'json'], { check: false });
    const hpaPresent = hpa.code === 0 && (JSON.parse(hpa.stdout).items ?? []).some((item) => item.spec?.scaleTargetRef?.name === service);
    if (hpaPresent) throw new LoadtestError('replica_deploy', `${service} HPA가 남아 있습니다; dev 설정에 최소 autoscaler override를 명시해야 합니다`);
    const scaled = run('kubectl', ['get', 'scaledobject.keda.sh', '-n', namespace, '-o', 'json'], { check: false });
    const kedaPresent = scaled.code === 0 && (JSON.parse(scaled.stdout).items ?? []).some((item) => item.spec?.scaleTargetRef?.name === service);
    if (kedaPresent) throw new LoadtestError('replica_deploy', `${service} KEDA ScaledObject가 남아 있습니다; dev 설정에 최소 autoscaler override를 명시해야 합니다`);
    const deployment = JSON.parse(run('kubectl', ['get', 'deployment', service, '-n', namespace, '-o', 'json']).stdout);
    const selector = Object.entries(deployment.spec?.selector?.matchLabels ?? {}).map(([key, value]) => `${key}=${value}`).join(',');
    if (!selector) throw new LoadtestError('replica_deploy', `${service} Deployment selector를 확인하지 못했습니다`);
    const replicaSets = JSON.parse(run('kubectl', ['get', 'replicasets', '-n', namespace, '-l', selector, '-o', 'json']).stdout).items ?? [];
    const pods = JSON.parse(run('kubectl', ['get', 'pods', '-n', namespace, '-l', selector, '-o', 'json']).stdout).items ?? [];
    const ready = currentRevisionReadyPods(deployment, replicaSets, pods);
    const imageIds = [...new Set(ready.flatMap((pod) => pod.status?.containerStatuses ?? []).map((status) => status.imageID).filter(Boolean))];
    if (Number(deployment.spec?.replicas) !== replicas || Number(deployment.status?.updatedReplicas ?? 0) !== replicas || ready.length !== replicas) {
      throw new LoadtestError('replica_deploy', `${service} 현재 revision의 desired/updated/ready replica 조건이 일치하지 않습니다`);
    }
    if (imageIds.length !== 1) throw new LoadtestError('replica_deploy', `${service} 단일 이미지 ID를 확인하지 못했습니다`);
    const condition = {
      replicas,
      hpa_enabled: false,
      keda_enabled: false,
      service_image_id: imageIds[0],
      layered_values: snapshot.contract.files.map((file) => relative(GITOPS_ROOT, file)),
      verified_at: utcNow(),
    };
    this.execution.services[service].conditions = condition;
    this.execution.images[service] = {
      reference: deployment.spec?.template?.spec?.containers?.[0]?.image ?? null,
      identity: imageIds[0],
    };
    this.syncState();
    return condition;
  }

  writeAllocations(service, targetRps, durationSeconds) {
    const offsets = this.writeAddressOffsets.get(service) ?? {};
    this.writeAddressOffsets.set(service, offsets);
    return planWriteAllocations(this.profiles[service], this.experiment.dataset.profileDocument, offsets, targetRps, durationSeconds);
  }

  async stabilize(service) {
    const seconds = Number(this.experiment.execution?.cooldownSeconds ?? 0);
    if (seconds > 0) await sleep(seconds * 1000);
    // Scenario-owned performance rules decide whether a metric matters. The
    // common runner only verifies that the target Deployment still has no
    // Pending Pods before the next sequential trial.
    const pending = JSON.parse(run('kubectl', ['get', 'pods', '-n', this.serviceNamespace(service), '-o', 'json']).stdout).items
      ?.filter((pod) => pod.status?.phase === 'Pending') ?? [];
    if (pending.length) throw new LoadtestError('stabilization', `${service} cooldown 이후 Pending Pod가 남아 있습니다`);
  }

  helmArgs({ service, trialId, phase, targetRps = 1, measureSeconds = 1, warmupSeconds = 0, writeAllocations = {}, iterationBudget = null, dataset = false, k6 = false, eventProducer = false }) {
    const profile = this.profiles[service] ?? this.profiles[this.options.services[0]];
    const maximumRps = profile.ramp?.maxRps ?? profile.adaptive?.maxRps ?? targetRps;
    const rpsTolerance = profile.ramp ? 0 : profile.adaptive.rpsTolerance;
    const budget = iterationBudget ?? Math.max(1, Math.ceil(targetRps * measureSeconds));
    const traceProbe = traceProbeFor(this.options.runId, service, trialId);
    const values = {
      'namespace.name': this.namespace,
      // Local input preparation owns the stable namespace. Ephemeral runs keep
      // the chart-created namespace and are removed with the run.
      'namespace.create': !this.persistentNamespace,
      'namespace.keep': true,
      'run.id': this.options.runId,
      'run.service': service,
      'run.trialId': trialId,
      'run.scenario': this.options.scenario,
      'run.replicas': this.experiment.run.deployment.replicas,
      'run.workload': profile.workload ?? 'dataset',
      'run.mode': this.options.mode,
      'run.loadSeed': String(this.experiment.dataset.seed),
      'run.kubernetesContext': this.execution.environment?.kubernetes_context ?? 'unverified',
      'run.serviceGitSha': this.execution.git.service.sha,
      'run.serviceGitDirty': this.execution.git.service.dirty,
      'run.gitopsGitSha': this.execution.git.gitops.sha,
      'run.gitopsGitDirty': this.execution.git.gitops.dirty,
      'run.k6ImageId': this.execution.images.k6?.identity ?? 'configured-not-inspected',
      'run.seederImageId': this.execution.images.seeder?.identity ?? 'configured-not-inspected',
      'run.traceparent': traceProbe.traceparent,
      'dataset.profile': this.experiment.dataset.profile,
      'dataset.seed': String(this.experiment.dataset.seed),
      'dataset.revision': this.experiment.dataset.revision,
      'dataset.services': datasetRestoreServices(service).join(','),
      'dataset.cacheKey': this.datasetCacheKey,
      'dataset.cacheMode': 'snapshot',
      'dataset.generatorRevision': this.datasetGeneratorRevision,
      'adaptive.phase': phase,
      'adaptive.startRps': targetRps,
      'adaptive.maxRps': maximumRps,
      'adaptive.rpsTolerance': rpsTolerance,
      'adaptive.searchTolerance': profile.adaptive?.searchTolerance ?? 0.1,
      'adaptive.warmupSeconds': warmupSeconds,
      'adaptive.measureSeconds': measureSeconds,
      'adaptive.writeSliceStart': 0,
      'adaptive.writeSliceSize': budget,
      'datasetJob.enabled': dataset,
      'k6Job.enabled': k6,
      'eventProducerJob.enabled': eventProducer,
      'eventProducerJob.start': 0,
      'eventProducerJob.count': budget,
      'artifactPod.enabled': true,
    };
    const args = ['upgrade', '--install', this.release, ROOT, '--namespace', this.namespace, '--create-namespace', '-f', this.experiment.environment.helm.loadtestValuesPath];
    for (const [key, value] of Object.entries(values)) args.push(...helmOverrideArgs(key, value));
    args.push('--set-json', `run.profile=${JSON.stringify(profile)}`);
    args.push('--set-json', `dataset.profileDocument=${JSON.stringify(this.experiment.dataset.profileDocument)}`);
    args.push('--set-json', `dataset.schemaHashes=${JSON.stringify(this.datasetSchemaIdentifiers)}`);
    args.push('--set-json', `adaptive.writeAllocations=${JSON.stringify(writeAllocations)}`);
    for (const [key, name] of [['k6Job', 'k6'], ['datasetJob', 'seeder'], ['eventProducerJob', 'tools']]) {
      const image = splitContainerImage(this.images[name]);
      args.push('--set-string', `${key}.image.registry=${image.registry}`, '--set-string', `${key}.image.repository=${image.repository}`, '--set-string', `${key}.image.tag=${image.tag}`);
    }
    return args;
  }

  async helmApply(config) {
    run('helm', this.helmArgs(config));
    const selector = `loadtest.dropmong.io/run-id=${this.options.runId},loadtest.dropmong.io/trial-id=${config.trialId},loadtest.dropmong.io/role=artifact-export`;
    for (let count = 0; count < 90; count += 1) {
      const result = run('kubectl', ['get', 'pods', '-n', this.namespace, '-l', selector, '-o', 'json'], { check: false });
      const pod = result.code === 0
        ? JSON.parse(result.stdout).items?.find((item) => item.status?.conditions?.some((condition) => condition.type === 'Ready' && condition.status === 'True'))
        : null;
      if (pod) {
        this.artifactPod = pod.metadata.name;
        return;
      }
      await sleep(2000);
    }
    throw new LoadtestError('environment', 'artifact export Pod did not become Ready');
  }

  async waitJob(role, trialId, timeoutSeconds) {
    const selector = `loadtest.dropmong.io/run-id=${this.options.runId},loadtest.dropmong.io/trial-id=${trialId},loadtest.dropmong.io/role=${role}`;
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (Date.now() < deadline) {
      const result = run('kubectl', ['get', 'jobs', '-n', this.namespace, '-l', selector, '-o', 'json'], { check: false });
      const job = result.code === 0 ? JSON.parse(result.stdout).items?.[0] : null;
      if (job?.status?.conditions?.some((condition) => ['Complete', 'Failed'].includes(condition.type) && condition.status === 'True')) {
        const pods = JSON.parse(run('kubectl', ['get', 'pods', '-n', this.namespace, '-l', selector, '-o', 'json']).stdout).items ?? [];
        return Math.max(0, ...pods.flatMap((pod) => pod.status?.containerStatuses ?? []).map((status) => Number(status.state?.terminated?.exitCode ?? 255)));
      }
      await sleep(2000);
    }
    throw new LoadtestError('environment', `timed out waiting for ${role} Job trial=${trialId}`);
  }

  artifactRead(path) {
    if (!this.artifactPod || path.startsWith('/') || path.split('/').includes('..')) throw new LoadtestError('artifact', `unsafe or unavailable artifact path: ${path}`);
    return run('kubectl', ['exec', '-n', this.namespace, this.artifactPod, '--', 'cat', `/loadtest/reports/${this.options.runId}/${path}`]).stdout;
  }

  artifactTryRead(path) {
    if (!this.artifactPod || path.startsWith('/') || path.split('/').includes('..')) return null;
    const source = `/loadtest/reports/${this.options.runId}/${path}`;
    const result = run('kubectl', ['exec', '-n', this.namespace, this.artifactPod, '--', 'sh', '-c', `test -f '${source}' && cat '${source}'`], { check: false });
    return result.code === 0 ? result.stdout : null;
  }

  artifactReadIncremental(path, offset) {
    if (!this.artifactPod || path.startsWith('/') || path.split('/').includes('..') || !Number.isSafeInteger(offset) || offset < 0) {
      throw new LoadtestError('artifact', `unsafe incremental artifact read: ${path}`);
    }
    const source = `/loadtest/reports/${this.options.runId}/${path}`;
    const result = run('kubectl', ['exec', '-n', this.namespace, this.artifactPod, '--', 'sh', '-c', `test -f '${source}' && tail -c +${offset + 1} '${source}'`], { check: false });
    if (result.code !== 0) return { text: '', nextOffset: offset };
    return { text: result.stdout, nextOffset: offset + Buffer.byteLength(result.stdout) };
  }

  artifactCopyFromLocal(source, path) {
    if (!this.artifactPod || path.startsWith('/') || path.split('/').includes('..')) throw new LoadtestError('artifact', `unsafe or unavailable artifact path: ${path}`);
    const destination = `/loadtest/reports/${this.options.runId}/${path}`;
    const temporary = `${destination}.tmp`;
    run('kubectl', ['exec', '-n', this.namespace, this.artifactPod, '--', 'mkdir', '-p', dirname(destination)]);
    run('kubectl', ['cp', '-n', this.namespace, source, `${this.artifactPod}:${temporary}`]);
    run('kubectl', ['exec', '-n', this.namespace, this.artifactPod, '--', 'mv', temporary, destination]);
  }

  artifactCopy(source, destination) {
    if (!this.artifactPod || [source, destination].some((path) => path.startsWith('/') || path.split('/').includes('..'))) {
      throw new LoadtestError('artifact', 'unsafe or unavailable artifact copy');
    }
    const root = `/loadtest/reports/${this.options.runId}`;
    run('kubectl', ['exec', '-n', this.namespace, this.artifactPod, '--', 'sh', '-ec', `mkdir -p '${root}/${dirname(destination)}' && test -s '${root}/${source}' && cp '${root}/${source}' '${root}/${destination}'`]);
  }

  async prepareDataset(service, trialId) {
    this.stageDatasetCache();
    await this.helmApply({ service, trialId, phase: 'dataset', dataset: true });
    const code = await this.waitJob('dataset', trialId, 1900);
    if (code !== 0) throw new LoadtestError('dataset', `Dataset Job failed with exit code ${code}`);
    const datasetExecution = JSON.parse(this.artifactRead(`raw/dataset/${this.options.runId}/execution.json`));
    if (datasetExecution.status !== 'success') throw new LoadtestError('dataset', `Dataset execution status is ${datasetExecution.status}`);
    this.writeAddressOffsets.set(service, {});
    this.syncDatasetCacheFromPod();
    const cache = datasetExecution.cache ?? {};
    this.execution.dataset.cache.status = cache.status ?? 'unknown';
    Object.assign(this.execution.dataset.cache.service_status, cache.services ?? {});
    this.execution.dataset.cache.events.push({ trial_id: trialId, status: cache.status ?? 'unknown', services: cache.services ?? {} });
    for (const metric of Object.values(cache.services ?? {})) {
      for (const key of ['generation_seconds', 'copy_seconds', 'snapshot_seconds', 'restore_seconds', 'analyze_seconds']) this.execution.dataset.cache.totals[key] += Number(metric[key] ?? 0);
      this.execution.dataset.cache.totals.rows += Number(metric.rows ?? 0);
      this.execution.dataset.cache.totals.snapshot_bytes += Number(metric.snapshot_bytes ?? 0);
    }
    this.execution.dataset.status = 'success';
    this.syncState();
  }

  stageDatasetCache() {
    if (this.datasetCacheStaged) return;
    if (!this.artifactPod) throw new LoadtestError('dataset_cache', 'artifact Pod가 준비되지 않아 로컬 캐시를 동기화할 수 없습니다');
    mkdirSync(this.datasetCacheRoot, { recursive: true });
    const remote = `/loadtest/reports/${this.options.runId}/dataset-cache/${this.datasetCacheKey}`;
    run('kubectl', ['exec', '-n', this.namespace, this.artifactPod, '--', 'sh', '-ec', `rm -rf '${remote}' && mkdir -p '${remote}'`]);
    if (existsSync(join(this.datasetCacheDirectory, 'manifest.json'))) {
      try {
        validateCacheFiles(this.datasetCacheDirectory, { hash: this.datasetCacheKey, generatorRevision: this.datasetGeneratorRevision });
        run('kubectl', ['cp', '-n', this.namespace, `${this.datasetCacheDirectory}/.`, `${this.artifactPod}:${remote}`]);
      } catch (error) {
        this.execution.dataset.cache.candidate = false;
        this.execution.dataset.cache.candidate_rejection = sanitize(error.message);
      }
    }
    this.datasetCacheStaged = true;
  }

  syncDatasetCacheFromPod() {
    const remote = `/loadtest/reports/${this.options.runId}/dataset-cache/${this.datasetCacheKey}`;
    const incoming = mkdtempSync(join(this.datasetCacheRoot, '.incoming-'));
    try {
      run('kubectl', ['cp', '-n', this.namespace, `${this.artifactPod}:${remote}/.`, incoming]);
      validateCacheFiles(incoming, { hash: this.datasetCacheKey, generatorRevision: this.datasetGeneratorRevision });
      const backup = `${this.datasetCacheDirectory}.previous`;
      rmSync(backup, { recursive: true, force: true });
      const backedUp = existsSync(this.datasetCacheDirectory);
      if (backedUp) renameSync(this.datasetCacheDirectory, backup);
      try {
        renameSync(incoming, this.datasetCacheDirectory);
      } catch (error) {
        if (backedUp && !existsSync(this.datasetCacheDirectory)) renameSync(backup, this.datasetCacheDirectory);
        throw error;
      }
      rmSync(backup, { recursive: true, force: true });
    } catch (error) {
      rmSync(incoming, { recursive: true, force: true });
      throw error;
    }
  }

  async beginK6(config) {
    await this.helmApply({ ...config, k6: true });
    let done = false;
    let code = null;
    const completion = this.waitJob('k6', config.trialId, Number(config.measureSeconds) + 300)
      .then((result) => {
        code = result;
        done = true;
        return result;
      });
    return { completion, isDone: () => done, exitCode: () => code };
  }

  readK6Summary(service, trialId, { allowMissing = false } = {}) {
    try {
      return JSON.parse(this.artifactRead(`raw/k6/${service}/${trialId}.summary.json`));
    } catch (error) {
      if (allowMissing) return null;
      throw new LoadtestError('k6_script', `k6 summary를 읽지 못했습니다: ${diagnosticTail(error.message)}`);
    }
  }

  async runK6(config) {
    const startedAt = utcNow();
    const handle = await this.beginK6(config);
    const k6ExitCode = await handle.completion;
    const finishedAt = this.artifactTryRead(`control/${config.service}/${config.trialId}.finished`)?.trim() ?? utcNow();
    const summary = this.readK6Summary(config.service, config.trialId, { allowMissing: true });
    const observability = await this.snapshotObservability({
      service: config.service,
      profile: this.profiles[config.service],
      startedAt,
      finishedAt,
    });
    return { startedAt, finishedAt, k6ExitCode, summary, observability };
  }

  stopK6(trialId) {
    const selector = `loadtest.dropmong.io/run-id=${this.options.runId},loadtest.dropmong.io/trial-id=${trialId},loadtest.dropmong.io/role=k6`;
    const result = run('kubectl', ['get', 'pods', '-n', this.namespace, '-l', selector, '-o', 'json'], { check: false });
    const pod = result.code === 0 ? JSON.parse(result.stdout).items?.find((item) => item.status?.phase === 'Running') : null;
    if (!pod) throw new LoadtestError('kubernetes', `실행 중인 k6 Pod를 찾지 못했습니다: ${trialId}`);
    const signal = run('kubectl', ['exec', '-n', this.namespace, pod.metadata.name, '-c', 'k6', '--', 'sh', '-c', 'pid="$(pidof k6)"; test -n "$pid"; kill -INT "$pid"'], { check: false });
    if (signal.code !== 0) throw new LoadtestError('kubernetes', `k6 정상 중단 신호 전송 실패: ${diagnosticTail(signal.stderr || signal.stdout)}`);
  }

  async prometheusQueryRange({ query, startedAt, finishedAt }) {
    const proxy = this.experiment.environment.prometheusKubernetesProxyPath;
    if (!proxy) {
      const error = new Error('Prometheus proxy path is not configured');
      error.code = 'prometheus_url_missing';
      throw error;
    }
    const path = `${proxy}/api/v1/query_range?query=${encodeURIComponent(query)}&start=${encodeURIComponent(startedAt)}&end=${encodeURIComponent(finishedAt)}&step=15`;
    const result = run('kubectl', ['get', '--raw', path], { check: false });
    if (result.code !== 0) {
      const error = new Error('Prometheus range query failed');
      error.status = 502;
      throw error;
    }
    return JSON.parse(result.stdout);
  }

  async snapshotObservability({ service, profile, startedAt, finishedAt }) {
    const namespace = this.serviceNamespace(service);
    const input = {
      startedAt,
      finishedAt,
      service,
      namespace,
      replicas: this.experiment.run.deployment.replicas,
      runId: this.options.runId,
      metricSpecs: profile.observability?.metricSpecs ?? this.experiment.observability?.metricSpecs ?? [],
    };
    if (!input.metricSpecs.length) {
      return unavailableSnapshot({ ...input, reason: 'scenario does not declare observability metric specifications' });
    }
    try {
      return await collectObservabilitySnapshot(input, {
        queryRange: (request) => this.prometheusQueryRange(request),
      });
    } catch (error) {
      return unavailableSnapshot({ ...input, reason: error.message });
    }
  }

  async snapshotTempoTraces({ service, profile, traceProbe }) {
    const routes = (profile.endpointMix ?? []).map((endpoint) => endpoint.route).filter(Boolean);
    const unavailable = (reason) => Object.fromEntries(routes.map((route) => [route, unavailableTraceSummary(reason)]));
    if (!routes.length) return unavailable('scenario does not declare API routes for Tempo lookup');
    const probe = parseTraceparent(traceProbe?.traceparent);
    if (!probe) return unavailable('invalid loadtest traceparent');
    const tempo = this.experiment.environment.observability?.tempoService;
    if (!tempo?.namespace || !tempo?.name || !Number.isFinite(Number(tempo.port))) return unavailable('Tempo service is not configured');
    // The local Collector batches spans for up to five seconds. Wait once after
    // k6 exits, then perform exactly one read-only Tempo lookup without polling.
    await sleep(6_000);
    const proxy = `/api/v1/namespaces/${tempo.namespace}/services/http:${tempo.name}:${Number(tempo.port)}/proxy`;
    const result = run('kubectl', ['get', '--raw', `${proxy}/api/traces/${probe.trace_id}`], { check: false });
    if (result.code !== 0) return unavailable('Tempo trace query failed');
    try {
      return summarizeTempoRoutes(JSON.parse(result.stdout), { traceparent: traceProbe.traceparent, service, routes });
    } catch (error) {
      return unavailable(error.message);
    }
  }

  recordTrial(record) {
    const profile = this.profiles[record.service];
    // Reports need the scenario-owned endpoint and threshold contract, but no
    // authentication or database connector material belongs in a result artifact.
    this.trials.push({
      ...record,
      profile: profile ? {
        endpointMix: profile.endpointMix,
        thresholds: profile.thresholds,
        slo: profile.slo,
        adaptive: profile.adaptive,
        ramp: profile.ramp,
        observability: profile.observability,
      } : null,
    });
    this.syncState();
  }

  scenarioContext() {
    return {
      options: this.options,
      experiment: this.experiment,
      execution: this.execution,
      profiles: this.profiles,
      now: utcNow,
      sleep,
      executionError: (category, message) => new LoadtestError(category, message),
      prepareDataset: (service, trialId) => this.prepareDataset(service, trialId),
      beginK6: (config) => this.beginK6(config),
      runK6: (config) => this.runK6(config),
      readK6Summary: (service, trialId, options) => this.readK6Summary(service, trialId, options),
      stopK6: (trialId) => this.stopK6(trialId),
      snapshotObservability: (input) => this.snapshotObservability(input),
      snapshotTempoTraces: (input) => this.snapshotTempoTraces(input),
      traceProbeFor: (service, trialId) => traceProbeFor(this.options.runId, service, trialId),
      artifactTryRead: (path) => this.artifactTryRead(path),
      artifactReadIncremental: (path, offset) => this.artifactReadIncremental(path, offset),
      writeAllocations: (service, targetRps, seconds) => this.writeAllocations(service, targetRps, seconds),
      stabilize: (service) => this.stabilize(service),
      recordTrial: (record) => this.recordTrial(record),
      persist: () => this.syncState(),
    };
  }

  async runService(service) {
    this.execution.services[service].status = 'running';
    this.checkMigration(service);
    await this.deployReplicas(service);
    const complete = await this.handler.executeService(this.scenarioContext(), service);
    this.syncState();
    return complete;
  }

  async execute() {
    let runnableServices = [...this.options.services];
    try {
      this.execution.environment = {
        name: this.experiment.environment.name,
        gitops_environment: this.experiment.environment.gitops.environment,
        ...preflight({ allowedContexts: this.experiment.environment.kubernetesContext.allowedNames }),
      };
      this.configureImages();
      await this.helmApply({ service: this.options.services[0], trialId: 'bootstrap', phase: 'bootstrap' });
      this.syncState();
      const results = [];
      for (const service of this.options.services) {
        if (!runnableServices.includes(service)) {
          results.push(false);
          continue;
        }
        try {
          results.push(await this.runService(service));
        } catch (error) {
          this.fail(error.category ?? 'unexpected', `${error.name}: ${error.message}`, service);
          results.push(false);
          this.syncState();
        }
      }
      this.execution.status = results.every(Boolean) ? 'pass' : Object.values(this.execution.services).some((service) => service.status === 'incomplete') ? 'incomplete' : 'fail';
    } catch (error) {
      this.fail(error.category ?? 'unexpected', `${error.name}: ${error.message}`);
      this.execution.status = 'fail';
    } finally {
      for (const failure of this.restoreServiceReleases()) {
        this.fail('service_restore', failure.message, failure.service);
        this.execution.status = 'fail';
      }
      this.execution.finished_at = utcNow();
      this.syncState();
      let exported = false;
      if (this.artifactPod) {
        const result = run('kubectl', ['cp', '-n', this.namespace, `${this.artifactPod}:/loadtest/reports/${this.options.runId}/.`, this.localRunDir], { check: false });
        exported = result.code === 0;
        if (!exported) {
          this.fail('artifact', `PVC export failed: ${sanitize(result.stderr)}`);
          this.execution.status = 'fail';
          this.writeState();
        }
      }
      try {
        this.handler.reporter.buildRunReport(this.localRunDir);
      } catch (error) {
        this.fail('report', error.message);
        this.execution.status = 'fail';
        this.writeState();
      }
      if (this.options.cleanup) {
        // Cross-namespace policies cannot be protected by the ephemeral namespace.
        // Delete only the policies labelled with this exact run id before removing
        // the release namespace, even when artifact export failed.
        const policies = run('kubectl', ['get', 'networkpolicy', '-A', '-l', `loadtest.dropmong.io/run-id=${this.options.runId}`, '-o', 'json'], { check: false });
        if (policies.code === 0) {
          for (const policy of JSON.parse(policies.stdout).items ?? []) {
            if (policy.metadata?.labels?.['loadtest.dropmong.io/run-id'] === this.options.runId) {
              run('kubectl', ['delete', 'networkpolicy', '-n', policy.metadata.namespace, policy.metadata.name, '--ignore-not-found'], { check: false });
            }
          }
        } else {
          this.fail('cleanup', `network policy cleanup failed: ${sanitize(policies.stderr)}`);
          this.execution.status = 'fail';
        }
        if (this.persistentNamespace) {
          run('helm', ['uninstall', this.release, '-n', this.namespace], { check: false });
          this.execution.cleanup = 'release-cleaned';
          this.writeState();
        } else {
          const namespace = JSON.parse(run('kubectl', ['get', 'namespace', this.namespace, '-o', 'json']).stdout);
          if (namespace.metadata?.labels?.['loadtest.dropmong.io/run-id'] !== this.options.runId) {
            this.fail('cleanup', 'namespace ownership label does not match; cleanup refused');
            this.execution.status = 'fail';
          } else {
            run('helm', ['uninstall', this.release, '-n', this.namespace], { check: false });
            run('kubectl', ['delete', 'namespace', this.namespace, '--wait=true', '--timeout=180s']);
            this.execution.cleanup = 'completed';
          }
        }
        this.writeState();
      }
    }
    if (this.execution.status !== 'pass') console.error(formatFailureSummary(this.execution, this.localRunDir));
    return this.execution.status === 'pass' ? 0 : 1;
  }
}

export function optionsFromArgs(argv) {
  const args = parseArgs(argv, {
    services: { default: 'all' },
    run: { default: join(ROOT, 'values', 'runs', 'local-smoke-replicas-1.yaml') },
    runId: { default: null },
    cleanup: { type: 'boolean', default: null },
    localOutput: { default: join(ROOT, 'reports', 'local') },
  });
  args.experiment = loadExperiment(resolve(args.run));
  args.scenario = args.experiment.scenario;
  const scenario = TEST_SCENARIOS[args.scenario];
  if (!scenario) throw new LoadtestError('configuration', `unknown test scenario: ${args.scenario}`);
  args.services = selectServices(args.experiment, args.services);
  args.runId = safeRunId(args.runId);
  args.mode = scenario.mode;
  args.confirmation = scenario.confirmation;
  args.replicas = args.experiment.run.deployment.replicas;
  args.cleanup ??= args.experiment.run.lifecycle.cleanup;
  args.localOutput = resolve(args.localOutput);
  return args;
}

async function main() {
  const options = optionsFromArgs(process.argv.slice(2));
  const orchestrator = new Orchestrator(options);
  let handlingSignal = false;
  const handleSignal = (signal) => {
    if (handlingSignal) return;
    handlingSignal = true;
    const failures = orchestrator.restoreServiceReleases();
    for (const failure of failures) orchestrator.fail('service_restore', failure.message, failure.service);
    orchestrator.fail('interrupted', `received ${signal}`);
    orchestrator.execution.status = 'fail';
    orchestrator.execution.finished_at = utcNow();
    try { orchestrator.writeState(); }
    catch (error) { console.error(`interrupted result persistence failed: ${sanitize(error.message)}`); }
    process.exit(failures.length ? 1 : signal === 'SIGINT' ? 130 : 143);
  };
  const handleSigint = () => handleSignal('SIGINT');
  const handleSigterm = () => handleSignal('SIGTERM');
  process.once('SIGINT', handleSigint);
  process.once('SIGTERM', handleSigterm);
  try { process.exitCode = await orchestrator.execute(); }
  finally {
    process.removeListener('SIGINT', handleSigint);
    process.removeListener('SIGTERM', handleSigterm);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`${error.category ?? 'unexpected'}: ${sanitize(error.message)}`);
    process.exitCode = 2;
  });
}
