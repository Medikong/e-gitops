#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  finiteMetricValue,
  k6EndpointMetrics,
  k6TrialMetrics,
  observabilityMetric,
  safeDiagnosticSummary,
} from '../../lib/k6-metrics.js';
import { parseArgs, readJson, sanitize, writeJsonAtomic } from '../../scripts/lib/io.js';

const PERFORMANCE_EXIT_CODES = new Set([99, 201]);
const SERVICE_OBSERVABILITY_FIELDS = ['cpu_utilization', 'memory_utilization', 'pod_restarts'];

export function percentile(values, percent) {
  const numbers = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!numbers.length) return null;
  const rank = (numbers.length - 1) * percent;
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  return lower === upper ? numbers[lower] : numbers[lower] + (numbers[upper] - numbers[lower]) * (rank - lower);
}

export function summarizeNumbers(values) {
  const numbers = values.filter(Number.isFinite);
  if (!numbers.length) {
    return {
      count: 0,
      average: null,
      p50: null,
      p95: null,
      p99: null,
      min: null,
      max: null,
      first: null,
      last: null,
      delta: null,
      coefficient_of_variation: null,
    };
  }
  const average = numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
  const variance = numbers.reduce((sum, value) => sum + (value - average) ** 2, 0) / numbers.length;
  return {
    count: numbers.length,
    average,
    p50: percentile(numbers, 0.5),
    p95: percentile(numbers, 0.95),
    p99: percentile(numbers, 0.99),
    min: Math.min(...numbers),
    max: Math.max(...numbers),
    first: numbers[0],
    last: numbers.at(-1),
    delta: numbers.at(-1) - numbers[0],
    coefficient_of_variation: average === 0 ? (variance === 0 ? 0 : null) : Math.sqrt(variance) / Math.abs(average),
  };
}

function finiteValues(values) {
  return values.map(finiteMetricValue).filter((value) => value !== null);
}

function maximum(values) {
  const numbers = finiteValues(values);
  return numbers.length ? Math.max(...numbers) : null;
}

function metricIdFor(profile, field) {
  const declared = profile?.observability?.metricSpecs;
  if (Array.isArray(declared)) {
    const metric = declared.find((item) => item?.id === field || item?.field === field || item?.name === field);
    if (metric?.id) return metric.id;
  }
  const configured = profile?.observability?.metricIds
    ?? profile?.observability?.metric_ids
    ?? profile?.observability?.metrics
    ?? {};
  const aliases = {
    cpu_utilization: ['cpu_utilization', 'cpuUtilization'],
    memory_utilization: ['memory_utilization', 'memoryUtilization'],
    pod_restarts: ['pod_restarts', 'podRestarts'],
  };
  if (Array.isArray(configured)) {
    const entry = configured.find((item) => item?.field === field || item?.name === field || item?.id === field);
    return entry?.id ?? field;
  }
  for (const alias of aliases[field] ?? [field]) {
    const value = configured?.[alias];
    if (typeof value === 'string' && value) return value;
    if (value?.id) return value.id;
  }
  return field;
}

function snapshotWindow(snapshot, startedAt, finishedAt) {
  const window = snapshot?.window ?? {};
  return {
    started_at: window.started_at ?? window.startedAt ?? snapshot?.started_at ?? snapshot?.startedAt ?? startedAt ?? null,
    finished_at: window.finished_at ?? window.finishedAt ?? snapshot?.finished_at ?? snapshot?.finishedAt ?? finishedAt ?? null,
  };
}

export function scenarioObservability(snapshot, profile, { startedAt = null, finishedAt = null } = {}) {
  const source = snapshot?.snapshot ?? snapshot ?? null;
  const selected = Object.fromEntries(SERVICE_OBSERVABILITY_FIELDS.map((field) => {
    const id = metricIdFor(profile, field);
    return [field, { metric_id: id, ...observabilityMetric(source, id) }];
  }));
  const available = Object.values(selected).filter((metric) => metric.status === 'available');
  const status = source?.status === 'unavailable' || available.length === 0 ? 'unavailable' : 'available';
  const reason = status === 'available'
    ? null
    : safeDiagnosticSummary(source?.reason ?? source?.error, 'observability snapshot is unavailable');
  return {
    status,
    reason,
    window: snapshotWindow(source, startedAt, finishedAt),
    service: {
      cpu_utilization: selected.cpu_utilization.value,
      memory_utilization: selected.memory_utilization.value,
      pod_restarts: selected.pod_restarts.value,
      metrics: selected,
    },
  };
}

function thresholdValue(value) {
  return finiteMetricValue(value);
}

function apiThresholds(profile, endpoint) {
  const thresholds = profile?.thresholds ?? profile?.slo ?? {};
  return {
    requests_min: 1,
    error_rate_max: thresholdValue(endpoint?.errorRate ?? thresholds.errorRate),
    checks_rate_min: thresholdValue(endpoint?.checkPassRate ?? thresholds.checkPassRate),
    p95_ms_max: thresholdValue(endpoint?.p95Ms ?? thresholds.p95Ms),
    p99_ms_max: thresholdValue(endpoint?.p99Ms ?? thresholds.p99Ms),
  };
}

function apiReason(code, observed, limit = null) {
  return { code, category: 'api', observed, limit };
}

export function evaluateApiResult(api, threshold) {
  const reasons = [];
  let conclusive = true;
  if (api.requests === null) {
    conclusive = false;
    reasons.push(apiReason('requests_unavailable', null, threshold.requests_min));
  } else if (api.requests < threshold.requests_min) {
    reasons.push(apiReason('requests_below_minimum', api.requests, threshold.requests_min));
  }
  for (const [field, limit, code] of [
    ['error_rate', threshold.error_rate_max, 'error_rate_exceeded'],
    ['checks_rate', threshold.checks_rate_min, 'checks_rate_below_minimum'],
    ['p95_ms', threshold.p95_ms_max, 'p95_slo_exceeded'],
    ['p99_ms', threshold.p99_ms_max, 'p99_slo_exceeded'],
  ]) {
    if (limit === null) continue;
    const observed = api[field];
    if (observed === null) {
      conclusive = false;
      reasons.push(apiReason(`${field}_unavailable`, null, limit));
    } else if ((field === 'checks_rate' && observed < limit) || (field !== 'checks_rate' && observed > limit)) {
      reasons.push(apiReason(code, observed, limit));
    }
  }
  return { passed: reasons.length === 0, conclusive, reasons };
}

export function buildApiResults(profile, rawK6Summary, durationSeconds) {
  const apis = {};
  for (const metric of k6EndpointMetrics(rawK6Summary, profile, { durationSeconds })) {
    if (!metric.route) throw new TypeError(`endpoint ${metric.endpoint} is missing the scenario route contract`);
    if (apis[metric.route]) throw new TypeError(`duplicate scenario route contract: ${metric.route}`);
    const threshold = apiThresholds(profile, profile.endpointMix.find((endpoint) => endpoint.name === metric.endpoint));
    const api = {
      endpoint: metric.endpoint,
      classification: metric.classification,
      requests: metric.requests,
      actual_rps: metric.actual_rps,
      error_rate: metric.error_rate,
      checks_rate: metric.checks_rate,
      p50_ms: metric.p50_ms,
      p95_ms: metric.p95_ms,
      p99_ms: metric.p99_ms,
      threshold,
    };
    apis[metric.route] = { ...api, decision: evaluateApiResult(api, threshold) };
  }
  return apis;
}

function decisionReason(code, category, observed = null, limit = null) {
  return { code, category, observed, limit };
}

function staticPerformanceDecision(profile, metrics, apis, k6ExitCode) {
  const thresholds = profile?.thresholds ?? profile?.slo ?? {};
  const reasons = [];
  let conclusive = true;
  if (PERFORMANCE_EXIT_CODES.has(k6ExitCode)) {
    reasons.push(decisionReason('k6_performance_threshold_exit', 'performance', k6ExitCode, 0));
  } else if (k6ExitCode !== 0) {
    conclusive = false;
    reasons.push(decisionReason('k6_execution_exit', 'execution', k6ExitCode, 0));
  }

  const targetRps = metrics.target_rps;
  const rpsTolerance = thresholdValue(profile?.adaptive?.rpsTolerance ?? thresholds.actualRpsTolerance);
  if (targetRps === null || metrics.actual_rps === null) {
    conclusive = false;
    reasons.push(decisionReason('actual_rps_unavailable', 'performance', metrics.actual_rps, targetRps));
  } else if (rpsTolerance !== null && Math.abs(metrics.actual_rps - targetRps) / targetRps > rpsTolerance + 1e-12) {
    reasons.push(decisionReason('actual_rps_outside_tolerance', 'performance', metrics.actual_rps, rpsTolerance));
  }

  for (const [field, limit, code, category, compare] of [
    ['error_rate', thresholdValue(thresholds.errorRate), 'error_rate_exceeded', 'api', (value, max) => value > max],
    ['check_pass_rate', thresholdValue(thresholds.checkPassRate), 'check_pass_rate_below_minimum', 'api', (value, min) => value < min],
    ['p95_ms', thresholdValue(thresholds.p95Ms), 'p95_slo_exceeded', 'performance', (value, max) => value > max],
    ['p99_ms', thresholdValue(thresholds.p99Ms), 'p99_slo_exceeded', 'performance', (value, max) => value > max],
  ]) {
    if (limit === null) continue;
    if (metrics[field] === null) {
      conclusive = false;
      reasons.push(decisionReason(`${field}_unavailable`, category, null, limit));
    } else if (compare(metrics[field], limit)) {
      reasons.push(decisionReason(code, category, metrics[field], limit));
    }
  }
  if (metrics.failed_checks !== null && metrics.failed_checks > 0) {
    reasons.push(decisionReason('failed_checks_present', 'api', metrics.failed_checks, 0));
  }
  if (metrics.dropped_iterations !== null && metrics.dropped_iterations > 0) {
    reasons.push(decisionReason('dropped_iterations_exceeded', 'performance', metrics.dropped_iterations, 0));
  }
  if (metrics.thresholds_passed === false) {
    reasons.push(decisionReason('k6_summary_threshold_failed', 'performance', 'failed', 'passed'));
  }
  for (const [route, api] of Object.entries(apis)) {
    if (api.decision.passed) continue;
    conclusive = conclusive && api.decision.conclusive;
    reasons.push(decisionReason('api_threshold_failed', 'api', route, api.decision.reasons.map((reason) => reason.code)));
  }
  return {
    passed: reasons.length === 0,
    conclusive,
    threshold_passed: reasons.length === 0,
    k6_exit_code: k6ExitCode,
    reasons,
  };
}

function verificationDecision(performanceDecision) {
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

function legacyEndpoints(apis) {
  return Object.values(apis).map((api) => ({
    endpoint: api.endpoint,
    classification: api.classification,
    route: Object.entries(apis).find(([, value]) => value === api)?.[0] ?? null,
    p50_ms: api.p50_ms,
    p95_ms: api.p95_ms,
    p99_ms: api.p99_ms,
    max_ms: null,
    sample_count: api.requests,
    requests: api.requests,
    actual_rps: api.actual_rps,
    error_rate: api.error_rate,
    checks_rate: api.checks_rate,
  }));
}

export function buildTrialResult({
  trialId = null,
  service,
  profile,
  rawK6Summary = {},
  targetRps = null,
  durationSeconds = null,
  k6ExitCode = 0,
  startedAt = null,
  finishedAt = null,
  observability = null,
  phase = 'trial',
  replicas = null,
  verificationOnly = false,
} = {}) {
  if (!service) throw new TypeError('service is required');
  if (!profile) throw new TypeError('profile is required');
  const metrics = k6TrialMetrics(rawK6Summary, { targetRps, durationSeconds });
  const apis = buildApiResults(profile, rawK6Summary, durationSeconds);
  const performanceDecision = staticPerformanceDecision(profile, metrics, apis, k6ExitCode);
  const decision = verificationOnly ? verificationDecision(performanceDecision) : performanceDecision;
  return {
    trial_id: trialId ?? rawK6Summary?.trial_id ?? null,
    service,
    replicas,
    phase,
    duration_seconds: finiteMetricValue(durationSeconds),
    started_at: startedAt,
    finished_at: finishedAt,
    metrics: { ...metrics, endpoints: legacyEndpoints(apis) },
    apis,
    observability: scenarioObservability(observability, profile, { startedAt, finishedAt }),
    decision,
    error: decision.reasons.find((reason) => reason.category === 'execution')?.code ?? null,
  };
}

function apiEntries(trial) {
  if (trial?.apis && typeof trial.apis === 'object') {
    return Object.entries(trial.apis).map(([route, api]) => ({ route, api }));
  }
  return (trial?.metrics?.endpoints ?? []).filter((endpoint) => endpoint.route).map((endpoint) => ({
    route: endpoint.route,
    api: {
      endpoint: endpoint.endpoint,
      classification: endpoint.classification ?? null,
      requests: finiteMetricValue(endpoint.requests ?? endpoint.sample_count),
      actual_rps: finiteMetricValue(endpoint.actual_rps),
      error_rate: finiteMetricValue(endpoint.error_rate),
      checks_rate: finiteMetricValue(endpoint.checks_rate),
      p50_ms: finiteMetricValue(endpoint.p50_ms),
      p95_ms: finiteMetricValue(endpoint.p95_ms),
      p99_ms: finiteMetricValue(endpoint.p99_ms),
      threshold: null,
      decision: null,
    },
  }));
}

function sumKnown(values) {
  const numbers = finiteValues(values);
  return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) : null;
}

function weightedRate(samples, field) {
  const weighted = samples.filter((sample) => sample[field] !== null && sample.requests !== null && sample.requests > 0);
  if (weighted.length) {
    const requests = weighted.reduce((sum, sample) => sum + sample.requests, 0);
    return weighted.reduce((sum, sample) => sum + sample[field] * sample.requests, 0) / requests;
  }
  return percentile(finiteValues(samples.map((sample) => sample[field])), 0.5);
}

export function aggregateApiResults(trials) {
  const groups = new Map();
  for (const trial of trials) {
    for (const { route, api } of apiEntries(trial)) {
      const group = groups.get(route) ?? { route, samples: [], durations: [] };
      group.samples.push(api);
      group.durations.push(finiteMetricValue(trial.duration_seconds));
      groups.set(route, group);
    }
  }
  return Object.fromEntries([...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([route, group]) => {
    const first = group.samples[0];
    const requests = sumKnown(group.samples.map((sample) => sample.requests));
    const duration = sumKnown(group.durations);
    const api = {
      endpoint: first.endpoint,
      classification: first.classification,
      requests,
      actual_rps: requests !== null && duration !== null && duration > 0 ? requests / duration : percentile(finiteValues(group.samples.map((sample) => sample.actual_rps)), 0.5),
      error_rate: weightedRate(group.samples, 'error_rate'),
      checks_rate: weightedRate(group.samples, 'checks_rate'),
      p50_ms: percentile(finiteValues(group.samples.map((sample) => sample.p50_ms)), 0.5),
      p95_ms: percentile(finiteValues(group.samples.map((sample) => sample.p95_ms)), 0.5),
      p99_ms: percentile(finiteValues(group.samples.map((sample) => sample.p99_ms)), 0.5),
      threshold: first.threshold,
      trial_count: group.samples.length,
    };
    return [route, { ...api, decision: api.threshold ? evaluateApiResult(api, api.threshold) : first.decision }];
  }));
}

function aggregateMetrics(trials) {
  const metrics = trials.map((trial) => trial.metrics).filter(Boolean);
  const values = (field) => finiteValues(metrics.map((metric) => metric[field]));
  const median = (field) => percentile(values(field), 0.5);
  return {
    trial_count: metrics.length,
    conclusive_trial_count: trials.filter((trial) => trial.decision?.conclusive).length,
    passed_trial_count: trials.filter((trial) => trial.decision?.passed).length,
    failed_trial_count: trials.filter((trial) => trial.decision && !trial.decision.passed).length,
    target_rps: median('target_rps'),
    actual_rps: median('actual_rps'),
    p50_ms: median('p50_ms'),
    p95_ms: median('p95_ms'),
    p99_ms: median('p99_ms'),
    max_latency_ms: maximum(values('max_latency_ms')),
    error_rate: median('error_rate'),
    check_pass_rate: median('check_pass_rate'),
    request_count: sumKnown(metrics.map((metric) => metric.request_count)),
    successful_requests: sumKnown(metrics.map((metric) => metric.successful_requests)),
    failed_requests: sumKnown(metrics.map((metric) => metric.failed_requests)),
    failed_checks: sumKnown(metrics.map((metric) => metric.failed_checks)),
    dropped_iterations: sumKnown(metrics.map((metric) => metric.dropped_iterations)),
  };
}

export function firstBottleneckCandidate(capacityResult) {
  const trials = capacityResult?.trials ?? [];
  const failures = trials
    .filter((trial) => trial.metrics && trial.decision?.conclusive && !trial.decision?.passed)
    .sort((left, right) => left.metrics.target_rps - right.metrics.target_rps);
  if (!failures.length) return { candidate: 'not-observed', evidence: [] };
  const trial = failures[0];
  const codes = trial.decision.reasons.map((reason) => reason.code);
  const pick = [
    ['runner-capacity', ['dropped_iterations_exceeded', 'actual_rps_outside_tolerance']],
    ['api-slo-or-error', ['api_threshold_failed', 'error_rate_exceeded', 'check_pass_rate_below_minimum', 'failed_checks_present', 'p95_slo_exceeded', 'p99_slo_exceeded']],
  ].find(([, matches]) => matches.some((code) => codes.includes(code)));
  return { candidate: pick?.[0] ?? 'unknown', first_failed_rps: trial.metrics.target_rps, evidence: trial.decision.reasons };
}

function compactCapacity(state = {}, trials = [], previous = {}) {
  const source = state ?? {};
  const previousCapacity = previous ?? {};
  const { trials: _trials, confirmation: sourceConfirmation = {}, ...rest } = source;
  void _trials;
  return {
    ...rest,
    confirmation: {
      stable_rps: sourceConfirmation.stable_rps ?? null,
      trial_ids: trials.filter((trial) => trial.phase === 'confirmation').map((trial) => trial.trial_id),
    },
    measurements: previousCapacity.measurements ?? null,
    trials,
  };
}

export function buildLiveResult(execution, trials = [], previous = null) {
  const services = Object.fromEntries(Object.entries(execution.services ?? {}).map(([service, state]) => {
    const previousService = previous?.services?.[service] ?? {};
    const serviceTrials = trials.filter((trial) => trial.service === service);
    return [service, {
      status: state.status ?? 'pending',
      workload: state.workload ?? null,
      dependencies: state.dependencies ?? {},
      profile: state.profile ?? previousService.profile ?? null,
      replicas: state.replicas ?? execution.replicas ?? null,
      conditions: state.conditions ?? previousService.conditions ?? null,
      restoration: state.restoration ?? previousService.restoration ?? null,
      capacity: compactCapacity(state.capacity, serviceTrials, previousService.capacity),
      apis: previousService.apis ?? {},
      observability: previousService.observability ?? null,
      failure_categories: previousService.failure_categories ?? [],
    }];
  }));
  return {
    schema_version: 'dropmong.loadtest.result/v2',
    run: {
      id: execution.run_id,
      definition: execution.run_definition ?? null,
      scenario: execution.scenario ?? null,
      preset: execution.preset ?? execution.run_preset ?? null,
      mode: execution.mode ?? null,
      replicas: execution.replicas ?? null,
      status: execution.status ?? 'initializing',
      started_at: execution.started_at ?? null,
      finished_at: execution.finished_at ?? null,
      namespace: execution.namespace ?? null,
      release: execution.release ?? null,
      verification_only: Boolean(execution.verification_only),
    },
    configuration: {
      experiment: execution.experiment ?? {},
      dataset: execution.dataset ?? {},
      deployment: { replicas: execution.replicas ?? null },
      fixed_comparison_conditions: execution.fixed_comparison_conditions ?? {},
      git: execution.git ?? {},
      images: execution.images ?? {},
      environment: execution.environment ?? {},
    },
    services,
    failures: execution.failures ?? [],
    artifacts: previous?.artifacts ?? { analysis: 'analysis.md', evidence_archive: 'evidence.tar.gz', evidence_status: 'pending', evidence_sha256: null, evidence_bytes: null },
    report: previous?.report ?? null,
  };
}

function normalizeStoredTrial(state, trial, verificationOnly) {
  if (trial.apis && trial.observability) return trial;
  const rawK6Summary = trial.raw_k6_summary ?? trial.rawK6Summary ?? null;
  const profile = trial.profile ?? state.profile ?? null;
  if (!rawK6Summary || !profile) return trial;
  return {
    ...trial,
    ...buildTrialResult({
      trialId: trial.trial_id,
      service: trial.service,
      profile,
      rawK6Summary,
      targetRps: trial.target_rps ?? trial.metrics?.target_rps ?? rawK6Summary.target_rps,
      durationSeconds: trial.duration_seconds ?? trial.metrics?.duration_seconds,
      k6ExitCode: trial.k6_exit_code ?? trial.decision?.k6_exit_code ?? 0,
      startedAt: trial.started_at,
      finishedAt: trial.finished_at,
      observability: trial.observability,
      phase: trial.phase,
      replicas: trial.replicas,
      verificationOnly,
    }),
  };
}

function normalizedTrials(state, verificationOnly) {
  return (state.capacity?.trials ?? []).map((trial) => normalizeStoredTrial(state, trial, verificationOnly));
}

function selectedTrials(trials) {
  const confirmations = trials.filter((trial) => trial.phase === 'confirmation');
  return confirmations.length ? confirmations : trials.filter((trial) => !String(trial.phase).includes('warmup'));
}

function latestObservability(trials, fallback = null) {
  const snapshots = trials.map((trial) => trial.observability).filter(Boolean);
  return snapshots.at(-1) ?? fallback ?? scenarioObservability(null, null);
}

export function finalizeResult(result) {
  const services = Object.fromEntries(Object.entries(result.services ?? {}).map(([service, state]) => {
    const allTrials = normalizedTrials(state, result.run.verification_only);
    const official = selectedTrials(allTrials);
    const request = aggregateMetrics(official);
    const apis = aggregateApiResults(official);
    const observability = latestObservability(official, state.observability ?? state.capacity?.measurements?.observability ?? null);
    const capacity = {
      ...(state.capacity ?? {}),
      trials: allTrials,
      first_bottleneck_candidate: result.run.verification_only ? null : firstBottleneckCandidate({ ...(state.capacity ?? {}), trials: allTrials }),
      measurements: { request, apis, observability },
    };
    const reasons = allTrials.flatMap((trial) => trial.decision?.reasons ?? []);
    return [service, {
      ...state,
      capacity,
      apis,
      observability,
      measurements: {
        official_percentiles: allTrials.some((trial) => trial.phase === 'confirmation'),
        request,
        apis,
        observability,
      },
      failure_categories: [...new Set([...(state.failure_categories ?? []), ...reasons.map((reason) => reason.category).filter(Boolean)])],
    }];
  }));
  const states = Object.values(services).map((service) => service.status);
  const successfulState = result.run.verification_only ? 'completed' : 'passed';
  const status = result.run.status === 'fail' || states.includes('failed')
    ? 'fail'
    : states.length && states.every((state) => state === successfulState) ? 'pass' : 'incomplete';
  return {
    ...result,
    run: { ...result.run, status },
    services,
    report: { generated_at: new Date().toISOString(), service_count: states.length },
  };
}

export function renderAnalysis(result) {
  const value = (item) => item ?? 'unavailable';
  const number = (item, digits = 3) => item == null ? 'unavailable' : Number.isFinite(Number(item)) ? Number(Number(item).toFixed(digits)) : 'unavailable';
  const lines = [
    `# DropMong 정적 replica 용량 측정: ${result.run.id}`,
    '',
    `전체 상태: **${result.run.status}**`,
    `Replica 수: **${value(result.run.replicas)}**`,
    '',
    '## 서비스별 결과',
    '',
    '| 서비스 | 상태 | 안정 RPS | p50 ms | p95 ms | p99 ms | 오류율 | 관측 상태 |',
    '|---|---|---:|---:|---:|---:|---:|---|',
  ];
  for (const [service, document] of Object.entries(result.services)) {
    const capacity = document.capacity ?? {};
    const request = capacity.measurements?.request ?? {};
    lines.push(`| ${service} | ${document.status} | ${value(capacity.confirmation?.stable_rps)} | ${number(request.p50_ms)} | ${number(request.p95_ms)} | ${number(request.p99_ms)} | ${number(request.error_rate)} | ${document.observability?.status ?? 'unavailable'} |`);
  }
  lines.push('', '## 측정 해석');
  for (const [service, document] of Object.entries(result.services)) {
    const observation = document.observability ?? {};
    const serviceObservation = observation.service ?? {};
    lines.push('', `### ${service}`, '');
    lines.push(`- API별 결과는 services.${service}.apis에서 scenario route별로 유지하며 서비스 전체 평균 하나로 바꾸지 않습니다.`);
    lines.push(`- 관측성: ${observation.status ?? 'unavailable'}, CPU ${number(serviceObservation.cpu_utilization)}, 메모리 ${number(serviceObservation.memory_utilization)}, 재시작 ${number(serviceObservation.pod_restarts, 0)}.`);
    if (observation.status === 'unavailable') lines.push(`- 관측성 사유: ${sanitize(observation.reason ?? 'unavailable')}. k6 성능 판정은 바꾸지 않습니다.`);
  }
  lines.push('', '수집하지 못한 관측값은 0이 아니라 null과 unavailable으로 기록합니다. 이 결과는 선택한 환경의 실험 자료이며 운영 처리량 보장값이 아닙니다.', '');
  return lines.join('\n');
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function archiveEvidence(runDir, outputDir = runDir) {
  mkdirSync(outputDir, { recursive: true });
  const archive = join(outputDir, 'evidence.tar.gz');
  const entries = ['raw', 'fixture-manifest.json'].filter((entry) => existsSync(join(runDir, entry)));
  if (entries.length) {
    const temporary = `${archive}.tmp`;
    const result = spawnSync('tar', ['-czf', temporary, '-C', runDir, ...entries], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`evidence archive failed: ${sanitize(result.stderr || result.error?.message || 'tar failed')}`);
    renameSync(temporary, archive);
    for (const entry of entries) rmSync(join(runDir, entry), { recursive: true, force: true });
  }
  if (!existsSync(archive)) return { evidence_archive: 'evidence.tar.gz', evidence_status: 'unavailable', evidence_sha256: null, evidence_bytes: null };
  return { evidence_archive: 'evidence.tar.gz', evidence_status: 'archived', evidence_sha256: sha256(archive), evidence_bytes: statSync(archive).size };
}

export function buildRunReport(runDir, outputDir = runDir) {
  const finalized = finalizeResult(readJson(join(runDir, 'result.json')));
  finalized.artifacts = { ...finalized.artifacts, ...archiveEvidence(runDir, outputDir), analysis: 'analysis.md' };
  writeJsonAtomic(join(outputDir, 'result.json'), finalized);
  writeFileSync(join(outputDir, 'analysis.md'), renderAnalysis(finalized), 'utf8');
  return finalized;
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { runDir: {}, outputDir: { default: null } });
  const result = buildRunReport(args.runDir, args.outputDir ?? args.runDir);
  for (const [service, document] of Object.entries(result.services)) {
    const capacity = document.capacity ?? {};
    console.log(JSON.stringify({
      event: 'loadtest_replica_capacity_result',
      run_id: result.run.id,
      scenario: result.run.scenario,
      service,
      replicas: document.replicas,
      status: document.status,
      stable_rps: capacity.confirmation?.stable_rps,
      last_pass_rps: capacity.search?.last_pass_rps,
      first_fail_rps: capacity.search?.first_fail_rps,
      observability_status: document.observability?.status ?? 'unavailable',
    }));
  }
  console.log(JSON.stringify({ event: 'loadtest_summary', run_id: result.run.id, status: result.run.status, service_count: result.report.service_count }));
  process.exitCode = result.run.status === 'pass' ? 0 : result.run.status === 'fail' ? 2 : 3;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`report generation failed: ${sanitize(error.message)}`);
    process.exitCode = 1;
  });
}
