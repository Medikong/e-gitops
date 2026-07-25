#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { archiveEvidence } from '../service-static-replica-capacity-load-test/report.js';
import {
  finiteMetricValue,
  k6EndpointMetrics,
  k6TrialMetrics,
  observabilityMetric,
  safeDiagnosticSummary,
} from '../../lib/k6-metrics.js';
import { parseArgs, readJson, sanitize, writeJsonAtomic } from '../../scripts/lib/io.js';

const SERVICE_OBSERVABILITY_FIELDS = ['cpu_utilization', 'memory_utilization', 'pod_restarts'];

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
  return {
    status,
    reason: status === 'available' ? null : safeDiagnosticSummary(source?.reason ?? source?.error, 'observability snapshot is unavailable'),
    window: snapshotWindow(source, startedAt, finishedAt),
    service: {
      cpu_utilization: selected.cpu_utilization.value,
      memory_utilization: selected.memory_utilization.value,
      pod_restarts: selected.pod_restarts.value,
      metrics: selected,
    },
  };
}

export function buildApiResults(profile, rawK6Summary, durationSeconds, traces = {}) {
  const apis = {};
  for (const metric of k6EndpointMetrics(rawK6Summary, profile, { durationSeconds })) {
    if (!metric.route) throw new TypeError(`endpoint ${metric.endpoint} is missing the scenario route contract`);
    if (apis[metric.route]) throw new TypeError(`duplicate scenario route contract: ${metric.route}`);
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
      decision: {
        applied: false,
        passed: null,
        conclusive: null,
        reason: 'reference_ramp_has_no_fixed_slo',
      },
      traces: traces[metric.route] ?? { trace_status: 'unavailable', trace_samples: [], reason: 'Tempo trace summary was not collected' },
    };
    apis[metric.route] = api;
  }
  return apis;
}

function rampK6Decision(k6ExitCode, stoppedForBottleneck) {
  const reasons = [];
  let conclusive = true;
  if (k6ExitCode !== 0 && !(stoppedForBottleneck && [105, 130, 143].includes(k6ExitCode))) {
    conclusive = false;
    reasons.push({ code: 'k6_measurement_exit', category: 'execution', observed: k6ExitCode, limit: 0 });
  }
  return { passed: reasons.length === 0, conclusive, threshold_passed: reasons.length === 0, k6_exit_code: k6ExitCode, reasons };
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
  traces = {},
  replicas = null,
  stoppedForBottleneck = false,
} = {}) {
  if (!service) throw new TypeError('service is required');
  if (!profile) throw new TypeError('profile is required');
  const metrics = k6TrialMetrics(rawK6Summary, { targetRps, durationSeconds });
  const apis = buildApiResults(profile, rawK6Summary, durationSeconds, traces);
  const decision = rampK6Decision(k6ExitCode, stoppedForBottleneck);
  return {
    trial_id: trialId ?? rawK6Summary?.trial_id ?? null,
    service,
    replicas,
    phase: 'ramp',
    duration_seconds: finiteMetricValue(durationSeconds),
    started_at: startedAt,
    finished_at: finishedAt,
    metrics,
    apis,
    observability: scenarioObservability(observability, profile, { startedAt, finishedAt }),
    decision,
    error: decision.reasons.find((reason) => reason.category === 'execution')?.code ?? null,
  };
}

export function buildRampResult({ trial, ramp = {} } = {}) {
  if (!trial) throw new TypeError('trial is required');
  return {
    ...ramp,
    trial_id: ramp.trial_id ?? trial.trial_id,
    apis: ramp.apis ?? trial.apis,
    observability: ramp.observability ?? trial.observability,
    k6_exit_code: ramp.k6_exit_code ?? trial.decision?.k6_exit_code ?? null,
  };
}

function normalizeStoredTrial(state, trial) {
  if (trial?.apis && trial?.observability) return trial;
  const ramp = state.ramp ?? {};
  const rawK6Summary = trial?.raw_k6_summary ?? trial?.rawK6Summary ?? ramp.raw_k6_summary ?? ramp.rawK6Summary ?? null;
  const profile = trial?.profile ?? state.profile ?? null;
  if (!rawK6Summary || !profile) return trial ?? null;
  const schedule = ramp.schedule ?? profile.ramp?.schedule ?? {};
  return {
    ...(trial ?? {}),
    ...buildTrialResult({
      trialId: trial?.trial_id ?? ramp.trial_id,
      service: trial?.service ?? state.service,
      profile,
      rawK6Summary,
      targetRps: trial?.target_rps ?? schedule.maxRps ?? profile.ramp?.maxRps,
      durationSeconds: trial?.duration_seconds ?? schedule.durationSeconds,
      k6ExitCode: trial?.k6_exit_code ?? ramp.k6_exit_code ?? 0,
      startedAt: trial?.started_at ?? ramp.started_at,
      finishedAt: trial?.finished_at ?? ramp.terminated_at,
      observability: trial?.observability ?? ramp.observability,
      traces: trial?.traces ?? ramp.traces,
      replicas: trial?.replicas ?? state.replicas,
      stoppedForBottleneck: Boolean(ramp.stop_condition),
    }),
  };
}

export function buildLiveResult(execution, trials = [], previous = null) {
  const services = Object.fromEntries(Object.entries(execution.services ?? {}).map(([service, state]) => {
    const prior = previous?.services?.[service] ?? {};
    const serviceTrials = trials.filter((trial) => trial.service === service);
    const latest = serviceTrials.at(-1) ?? null;
    const ramp = state.ramp ?? prior.ramp ?? null;
    return [service, {
      status: state.status ?? 'pending',
      workload: state.workload ?? null,
      dependencies: state.dependencies ?? {},
      profile: state.profile ?? prior.profile ?? null,
      replicas: state.replicas ?? execution.replicas ?? null,
      conditions: state.conditions ?? prior.conditions ?? null,
      restoration: state.restoration ?? prior.restoration ?? null,
      ramp,
      trials: serviceTrials,
      apis: state.apis ?? ramp?.apis ?? latest?.apis ?? prior.apis ?? {},
      observability: state.observability ?? ramp?.observability ?? latest?.observability ?? prior.observability ?? null,
      failure_categories: prior.failure_categories ?? [],
    }];
  }));
  return {
    schema_version: 'dropmong.loadtest.bottleneck-ramp-result/v2',
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
    },
    configuration: {
      experiment: execution.experiment ?? {},
      dataset: execution.dataset ?? {},
      deployment: { replicas: execution.replicas ?? null },
      ramp: execution.ramp ?? {},
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

export function finalizeResult(result) {
  const services = Object.fromEntries(Object.entries(result.services ?? {}).map(([service, state]) => {
    const trials = (state.trials ?? []).map((trial) => normalizeStoredTrial({ ...state, service }, trial)).filter(Boolean);
    const trial = trials.at(-1) ?? normalizeStoredTrial({ ...state, service }, null);
    const ramp = buildRampResult({ trial: trial ?? { trial_id: state.ramp?.trial_id ?? null, apis: {}, observability: scenarioObservability(null, state.profile) }, ramp: state.ramp ?? {} });
    const reasons = ramp.execution_reasons ?? [];
    return [service, {
      ...state,
      ramp,
      trials,
      apis: ramp.apis ?? {},
      observability: ramp.observability ?? scenarioObservability(null, state.profile),
      failure_categories: [...new Set([...(state.failure_categories ?? []), ...(reasons.length ? ['performance'] : [])])],
    }];
  }));
  const completed = Object.values(services).every((service) => ['bottleneck_reached', 'max_rps_reached'].includes(service.status));
  const status = result.failures?.length || Object.values(services).some((service) => service.status === 'failed')
    ? 'fail'
    : completed ? 'pass' : result.run.status;
  return { ...result, run: { ...result.run, status }, services, report: { generated_at: new Date().toISOString(), service_count: Object.keys(services).length } };
}

function display(value, digits = 2) {
  if (value == null || value === '') return 'unavailable';
  return Number.isFinite(Number(value)) ? Number(Number(value).toFixed(digits)) : 'unavailable';
}

function terminationSummary(state, ramp) {
  const executionReasons = ramp.execution_reasons ?? [];
  if (state.status === 'failed' || ramp.status === 'failed') {
    const codes = [...new Set(executionReasons.map((reason) => reason.code).filter(Boolean))];
    return `실행 실패(${codes.join(', ') || 'execution_failure'})`;
  }
  const stop = ramp.stop_condition;
  if (stop) return `${stop.required_windows}개 연속 reference 저하(${stop.reasons.join(', ')})`;
  if (state.status === 'max_rps_reached' || ramp.status === 'max_rps_reached') return '설정한 최대 RPS 도달';
  return '종료 상태 unavailable';
}

export function renderAnalysis(result) {
  const lines = [
    `# DropMong 연속 ramp 병목 측정: ${result.run.id}`,
    '',
    `전체 상태: **${result.run.status}**`,
    `Replica 수: **${result.run.replicas}**`,
    '',
    '## 서비스별 결과',
    '',
    '| 서비스 | 상태 | peak 목표 RPS | peak 실측 RPS | 마지막 reference 실측 RPS | 최초 저하 실측 RPS | 관측 상태 |',
    '|---|---|---:|---:|---:|---:|---|',
  ];
  for (const [service, state] of Object.entries(result.services)) {
    const ramp = state.ramp ?? {};
    lines.push(`| ${service} | ${state.status} | ${display(ramp.reference?.peak_target_rps)} | ${display(ramp.reference?.peak_actual_rps)} | ${display(ramp.reference?.last_healthy_actual_rps)} | ${display(ramp.degradation?.first?.actual_rps)} | ${state.observability?.status ?? 'unavailable'} |`);
  }
  lines.push('', '## 판정 근거');
  for (const [service, state] of Object.entries(result.services)) {
    const ramp = state.ramp ?? {};
    const observation = state.observability ?? {};
    lines.push('', `### ${service}`, '');
    lines.push(`- 실행: ${display(ramp.schedule?.startRps)} RPS에서 ${display(ramp.schedule?.maxRps)} RPS까지 초당 ${display(ramp.schedule?.increaseRpsPerSecond)} RPS씩 증가했습니다.`);
    lines.push(`- window: ${display(ramp.evaluation_window_seconds)}초 단위 ${ramp.windows?.length ?? 0}개를 기록했습니다. 종료: ${terminationSummary(state, ramp)}.`);
    lines.push(`- RPS: peak 목표 ${display(ramp.reference?.peak_target_rps)}, peak 실측 ${display(ramp.reference?.peak_actual_rps)}, 마지막 정상 reference 실측 ${display(ramp.reference?.last_healthy_actual_rps)}, 최초 저하 목표/실측 ${display(ramp.degradation?.first?.target_rps)}/${display(ramp.degradation?.first?.actual_rps)}.`);
    if (ramp.execution_reasons?.length) lines.push(`- 실행 실패 근거: ${ramp.execution_reasons.map((reason) => safeDiagnosticSummary(reason.message ?? reason.code, 'unavailable')).join(' | ')}`);
    lines.push(`- API별 k6 결과는 services.${service}.apis에 route별로 보관하고, 서비스·Pod 관측성은 별도 필드에 둡니다.`);
    if (observation.status === 'unavailable') lines.push(`- 관측성 unavailable: ${sanitize(observation.reason ?? 'unavailable')}. k6 성공을 자동 실패로 바꾸지 않습니다.`);
  }
  lines.push('', '수집하지 못한 관측값은 0이 아니라 null과 unavailable으로 남깁니다. 이 결과는 선택한 환경의 실험 자료이며 운영 처리량 보장값이 아닙니다.', '');
  return lines.join('\n');
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
  for (const [service, state] of Object.entries(result.services)) {
    console.log(JSON.stringify({
      event: 'loadtest_bottleneck_ramp_result',
      run_id: result.run.id,
      scenario: result.run.scenario,
      service,
      replicas: state.replicas,
      status: state.status,
      peak_target_rps: state.ramp?.reference?.peak_target_rps,
      peak_actual_rps: state.ramp?.reference?.peak_actual_rps,
      reference_actual_rps: state.ramp?.reference?.last_healthy_actual_rps,
      first_degraded_actual_rps: state.ramp?.degradation?.first?.actual_rps,
      observability_status: state.observability?.status ?? 'unavailable',
    }));
  }
  process.exitCode = result.run.status === 'pass' ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`report generation failed: ${sanitize(error.message)}`);
    process.exitCode = 1;
  });
}
