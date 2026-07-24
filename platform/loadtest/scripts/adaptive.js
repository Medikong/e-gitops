#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from './lib/io.js';

export const K6_PERFORMANCE_FAILURE_EXIT_CODES = new Set([99, 201]);
const KNOWN_OBSERVATIONS = new Set(['cpu_utilization', 'cpu_throttle_ratio', 'memory_utilization', 'memory_growth', 'pod_restarts', 'oom_killed', 'postgresql_pool_exhaustions', 'kafka_lag']);

function finite(name, value) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${name} must be finite`);
  return number;
}

function nonNegative(name, value) {
  const number = finite(name, value);
  if (number < 0) throw new RangeError(`${name} must be greater than or equal to 0`);
  return number;
}

function ratio(name, value) {
  const number = nonNegative(name, value);
  if (number > 1) throw new RangeError(`${name} must be between 0 and 1`);
  return number;
}

export function cpuSecondsPerSuccess(cpuCoreSeconds, successfulRequests) {
  const cpu = nonNegative('cpu_core_seconds', cpuCoreSeconds);
  if (cpu === 0 || successfulRequests <= 0) throw new RangeError('CPU and successful requests must be greater than 0');
  return cpu / successfulRequests;
}

export function initialRpsCandidate({ cpuCoreSeconds, successfulRequests, allocatedCpuCores, targetCpuUtilization, minimumRps = 1, maximumRps = null }) {
  const cost = cpuSecondsPerSuccess(cpuCoreSeconds, successfulRequests);
  const cores = nonNegative('allocated_cpu_cores', allocatedCpuCores);
  const target = ratio('target_cpu_utilization', targetCpuUtilization);
  const floor = nonNegative('minimum_rps', minimumRps);
  if (cores === 0 || target === 0 || floor === 0) throw new RangeError('cores, target utilization and minimum RPS must be greater than 0');
  if (maximumRps !== null && nonNegative('maximum_rps', maximumRps) < floor) throw new RangeError('maximum_rps must be greater than or equal to minimum_rps');
  const candidate = Math.max(floor, (cores * target) / cost);
  return maximumRps === null ? candidate : Math.min(candidate, maximumRps);
}

export function geometricMeanCandidate(lower, upper) {
  lower = nonNegative('lower_pass_rps', lower);
  upper = nonNegative('upper_fail_rps', upper);
  if (lower === 0 || upper <= lower) throw new RangeError('invalid pass/fail bracket');
  return Math.sqrt(lower * upper);
}

export function withinRpsTolerance(target, actual, tolerance = 0.05) {
  target = nonNegative('target_rps', target);
  actual = nonNegative('actual_rps', actual);
  tolerance = ratio('tolerance', tolerance);
  if (target === 0) throw new RangeError('target_rps must be greater than 0');
  return Math.abs(actual - target) / target <= tolerance + 1e-12;
}

export function searchShouldStop(lower, upper, tolerance = 0.1) {
  lower = nonNegative('lower_pass_rps', lower);
  upper = nonNegative('upper_fail_rps', upper);
  tolerance = ratio('tolerance', tolerance);
  if (lower === 0 || upper <= lower) throw new RangeError('invalid pass/fail bracket');
  return upper / lower - 1 <= tolerance + 1e-12;
}

export function evaluationPolicy(value = {}) {
  const policy = {
    rps_tolerance: 0.05, max_error_rate: 0.01, min_check_pass_rate: 1,
    max_dropped_iterations: 0, p95_slo_ms: null, p99_slo_ms: null,
    max_cpu_utilization: 0.9, max_cpu_throttle_ratio: 0.1, max_pod_restarts: 0,
    max_memory_utilization: 0.9, max_memory_growth_bytes: null,
    max_postgresql_pool_exhaustions: 0, max_kafka_lag_growth: 0,
    fail_on_oom_killed: true, fail_on_any_failed_check: true,
    required_observations: [], ...value,
  };
  ratio('rps_tolerance', policy.rps_tolerance);
  ratio('max_error_rate', policy.max_error_rate);
  ratio('min_check_pass_rate', policy.min_check_pass_rate);
  const unknown = policy.required_observations.filter((name) => !KNOWN_OBSERVATIONS.has(name));
  if (unknown.length) throw new TypeError(`unknown required observations: ${unknown.sort().join(', ')}`);
  return policy;
}

export function trialMetrics(value) {
  const metrics = { failed_checks: 0, successful_requests: 0, request_count: 0, ...value };
  if (nonNegative('target_rps', metrics.target_rps) === 0) throw new RangeError('target_rps must be greater than 0');
  nonNegative('actual_rps', metrics.actual_rps);
  ratio('error_rate', metrics.error_rate);
  ratio('check_pass_rate', metrics.check_pass_rate);
  metrics.kafka_lag_growth = metrics.kafka_lag_start == null || metrics.kafka_lag_end == null ? null : metrics.kafka_lag_end - metrics.kafka_lag_start;
  metrics.memory_growth_bytes = metrics.memory_start_bytes == null || metrics.memory_end_bytes == null ? null : metrics.memory_end_bytes - metrics.memory_start_bytes;
  return metrics;
}

function metric(summary, names, keys) {
  for (const name of names) {
    const values = summary.metrics?.[name]?.values;
    if (!values) continue;
    for (const key of keys) if (Number.isFinite(Number(values[key]))) return Number(values[key]);
  }
  return null;
}

function metricRate(summary, names, requestCount) {
  for (const name of names) {
    const item = summary.metrics?.[name];
    if (!item?.values) continue;
    if (item.type !== 'counter' && Number.isFinite(Number(item.values.rate))) return Number(item.values.rate);
    if (requestCount > 0 && Number.isFinite(Number(item.values.count))) return Number(item.values.count) / requestCount;
  }
  return null;
}

export function trialMetricsFromK6Summary(summary, { targetRps = null, durationSeconds = null, resourceObservations = {} } = {}) {
  if ('actual_rps' in summary && 'error_rate' in summary) {
    const target = targetRps ?? summary.target_rps;
    if (target == null) throw new TypeError('normalized k6 summary does not contain target_rps');
    const requestCount = Number(summary.request_count ?? 0);
    const failed = Number(summary.failed_requests ?? 0);
    return trialMetrics({
      target_rps: target, actual_rps: summary.actual_rps, error_rate: summary.error_rate,
      check_pass_rate: summary.check_pass_rate ?? 1, dropped_iterations: Number(summary.dropped_iterations ?? 0),
      failed_checks: Number(summary.failed_checks ?? 0), request_count: requestCount,
      successful_requests: Number(summary.successful_requests ?? Math.max(0, requestCount - failed)),
      p50_ms: summary.p50_ms ?? null, p95_ms: summary.p95_ms ?? null,
      p99_ms: summary.p99_ms ?? null, max_latency_ms: summary.max_latency_ms ?? null,
      ...resourceObservations,
    });
  }
  if (targetRps == null) throw new TypeError('targetRps is required for a native k6 summary');
  const requestCount = Number(metric(summary, ['loadtest_requests', 'http_reqs'], ['count']) ?? 0);
  let actualRps = metric(summary, ['loadtest_requests', 'http_reqs'], ['rate']);
  if (actualRps == null && durationSeconds) actualRps = requestCount / durationSeconds;
  let errorRate = metricRate(summary, ['loadtest_error_rate', 'loadtest_errors', 'http_req_failed'], requestCount);
  const successRate = metricRate(summary, ['loadtest_success', 'loadtest_successes'], requestCount);
  if (errorRate == null && successRate != null) errorRate = 1 - successRate;
  if (actualRps == null || errorRate == null) throw new TypeError('k6 summary does not contain required rate metrics');
  const successful = metric(summary, ['loadtest_success', 'loadtest_successes'], ['count', 'passes']);
  return trialMetrics({
    target_rps: targetRps, actual_rps: actualRps, error_rate: Math.max(0, Math.min(1, errorRate)),
    check_pass_rate: metric(summary, ['checks'], ['rate']) ?? 1,
    dropped_iterations: Number(metric(summary, ['dropped_iterations'], ['count']) ?? 0),
    failed_checks: Number(metric(summary, ['checks'], ['fails']) ?? 0), request_count: requestCount,
    successful_requests: Number(successful ?? Math.max(0, Math.round(requestCount * (1 - errorRate)))),
    p50_ms: metric(summary, ['loadtest_latency', 'http_req_duration'], ['med', 'p(50)']),
    p95_ms: metric(summary, ['loadtest_latency', 'http_req_duration'], ['p(95)']),
    p99_ms: metric(summary, ['loadtest_latency', 'http_req_duration'], ['p(99)']),
    max_latency_ms: metric(summary, ['loadtest_latency', 'http_req_duration'], ['max']), ...resourceObservations,
  });
}

function reason(code, category, message, observed = null, limit = null) { return { code, category, message, observed, limit }; }

export function evaluateTrial(rawMetrics, rawPolicy = {}, k6ExitCode = 0) {
  const metrics = trialMetrics(rawMetrics);
  const policy = evaluationPolicy(rawPolicy);
  const reasons = [];
  let conclusive = true;
  if (K6_PERFORMANCE_FAILURE_EXIT_CODES.has(k6ExitCode)) reasons.push(reason('k6_performance_threshold_exit', 'performance', 'k6가 성능 threshold 실패 종료 코드를 반환했습니다.', k6ExitCode, 0));
  else if (k6ExitCode !== 0) { conclusive = false; reasons.push(reason('k6_execution_exit', 'execution', 'k6 실행 자체가 비정상 종료되었습니다.', k6ExitCode, 0)); }
  if (!withinRpsTolerance(metrics.target_rps, metrics.actual_rps, policy.rps_tolerance)) reasons.push(reason('actual_rps_outside_tolerance', 'performance', '실제 처리 RPS가 목표 허용 범위를 벗어났습니다.', metrics.actual_rps, policy.rps_tolerance));
  if (metrics.error_rate > policy.max_error_rate) reasons.push(reason('error_rate_exceeded', 'api', 'API 오류율이 허용치를 넘었습니다.', metrics.error_rate, policy.max_error_rate));
  if (metrics.check_pass_rate < policy.min_check_pass_rate) reasons.push(reason('check_pass_rate_below_minimum', 'api', 'k6 check 통과율이 기준보다 낮습니다.', metrics.check_pass_rate, policy.min_check_pass_rate));
  if (policy.fail_on_any_failed_check && metrics.failed_checks > 0) reasons.push(reason('failed_checks_present', 'api', '실패한 endpoint check가 있습니다.', metrics.failed_checks, 0));
  if (metrics.dropped_iterations > policy.max_dropped_iterations) reasons.push(reason('dropped_iterations_exceeded', 'performance', 'dropped iteration이 발생했습니다.', metrics.dropped_iterations, policy.max_dropped_iterations));
  for (const [field, limit, code, label] of [['p95_ms', policy.p95_slo_ms, 'p95_slo_exceeded', 'p95'], ['p99_ms', policy.p99_slo_ms, 'p99_slo_exceeded', 'p99']]) {
    if (limit == null) continue;
    if (metrics[field] == null) { conclusive = false; reasons.push(reason(`${field}_unavailable`, 'observability', `${label} latency 표본이 없습니다.`, 'unavailable', limit)); }
    else if (metrics[field] > limit) reasons.push(reason(code, 'performance', `${label} latency가 로컬 benchmark SLO를 넘었습니다.`, metrics[field], limit));
  }
  const checks = [
    ['cpu_utilization', metrics.cpu_utilization, policy.max_cpu_utilization, 'cpu_saturation'],
    ['cpu_throttle_ratio', metrics.cpu_throttle_ratio, policy.max_cpu_throttle_ratio, 'cpu_throttling'],
    ['pod_restarts', metrics.pod_restarts, policy.max_pod_restarts, 'pod_restarts'],
    ['memory_utilization', metrics.memory_utilization, policy.max_memory_utilization, 'memory_pressure'],
    ['memory_growth', metrics.memory_growth_bytes, policy.max_memory_growth_bytes, 'memory_growth'],
    ['postgresql_pool_exhaustions', metrics.postgresql_pool_exhaustions, policy.max_postgresql_pool_exhaustions, 'postgresql_pool_exhaustion'],
    ['kafka_lag', metrics.kafka_lag_growth, policy.max_kafka_lag_growth, 'kafka_lag_growth'],
  ];
  for (const [field, observed, limit, code] of checks) {
    if (limit == null) continue;
    if (observed == null && policy.required_observations.includes(field)) { conclusive = false; reasons.push(reason(`${field}_unavailable`, 'observability', `필수 자원 지표 ${field}을 수집하지 못했습니다.`, 'unavailable', limit)); }
    else if (observed != null && observed > limit) reasons.push(reason(code, 'performance', `${field} 기준을 넘었습니다.`, observed, limit));
  }
  if (metrics.oom_killed == null && policy.required_observations.includes('oom_killed')) { conclusive = false; reasons.push(reason('oom_killed_unavailable', 'observability', 'OOMKilled 상태를 수집하지 못했습니다.', 'unavailable', false)); }
  else if (policy.fail_on_oom_killed && metrics.oom_killed) reasons.push(reason('oom_killed', 'performance', '시행 중 OOMKilled가 발생했습니다.', true, false));
  return { passed: reasons.length === 0, conclusive, threshold_passed: reasons.length === 0, k6_exit_code: k6ExitCode, reasons };
}

export function evaluateK6Summary(summary, policy, options = {}) {
  const metrics = trialMetricsFromK6Summary(summary, options);
  const decision = evaluateTrial(metrics, policy, options.k6ExitCode ?? 0);
  if (summary.thresholds_passed === false && !decision.reasons.some(({ code }) => code === 'k6_summary_threshold_failed')) {
    decision.passed = false; decision.threshold_passed = false;
    decision.reasons.push(reason('k6_summary_threshold_failed', 'performance', 'k6 summary에 실패한 threshold가 있습니다.', 'failed', 'passed'));
  }
  return { metrics, decision };
}

export function createSearchState(service, startRps, maxRps, { searchTolerance = 0.1, maxTrials = 12 } = {}) {
  if (startRps <= 0 || maxRps < startRps || maxTrials <= 0) throw new RangeError('invalid adaptive search range');
  return { service, start_rps: startRps, max_rps: maxRps, search_tolerance: searchTolerance, max_trials: maxTrials, last_pass_rps: null, first_fail_rps: null, status: 'searching', trials: [] };
}

export function nextSearchCandidate(state) {
  if (state.status !== 'searching') return null;
  if (state.last_pass_rps != null && state.first_fail_rps != null) return searchShouldStop(state.last_pass_rps, state.first_fail_rps, state.search_tolerance) ? null : geometricMeanCandidate(state.last_pass_rps, state.first_fail_rps);
  if (state.last_pass_rps != null) return state.last_pass_rps >= state.max_rps ? null : Math.min(state.max_rps, state.last_pass_rps * 2);
  if (state.first_fail_rps != null) { const candidate = Math.max(state.start_rps, state.first_fail_rps / 2); return candidate < state.first_fail_rps ? candidate : null; }
  return state.start_rps;
}

export function recordTrial(state, trial) {
  if (trial.service !== state.service) throw new TypeError('trial service does not match search service');
  const next = { ...state, trials: [...state.trials, trial] };
  let inconsistent = false;
  if (trial.decision.conclusive && trial.metrics) {
    const candidate = trial.metrics.target_rps;
    if (trial.decision.passed) { if (next.first_fail_rps != null && candidate >= next.first_fail_rps) inconsistent = true; next.last_pass_rps = next.last_pass_rps == null ? candidate : Math.max(next.last_pass_rps, candidate); }
    else if (next.last_pass_rps != null && candidate <= next.last_pass_rps) inconsistent = true;
    else if (next.last_pass_rps == null || candidate > next.last_pass_rps) next.first_fail_rps = next.first_fail_rps == null ? candidate : Math.min(next.first_fail_rps, candidate);
  }
  if (inconsistent || (next.last_pass_rps != null && next.first_fail_rps != null && next.first_fail_rps <= next.last_pass_rps)) next.status = 'inconsistent_trials';
  else if (next.last_pass_rps == null && next.first_fail_rps != null && next.first_fail_rps <= next.start_rps) next.status = 'start_rps_failed';
  else if (next.last_pass_rps != null && next.last_pass_rps >= next.max_rps) next.status = 'max_rps_passed';
  else if (next.last_pass_rps != null && next.first_fail_rps != null && searchShouldStop(next.last_pass_rps, next.first_fail_rps, next.search_tolerance)) next.status = 'converged';
  else if (next.trials.length >= next.max_trials) next.status = 'max_trials_reached';
  return next;
}

export function finalizeSearch(state) {
  return { service: state.service, status: state.status === 'searching' ? 'incomplete' : state.status, reliable_stable_rps: state.status === 'inconsistent_trials' ? null : state.last_pass_rps, last_pass_rps: state.last_pass_rps, first_fail_rps: state.first_fail_rps, trials: state.trials };
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { input: { default: null }, k6Summary: { default: null }, targetRps: { type: 'number', default: null }, durationSeconds: { type: 'number', default: null }, policy: { default: null }, k6ExitCode: { type: 'number', default: 0 } });
  const path = args.k6Summary ?? args.input;
  if (!path) throw new TypeError('--input or --k6-summary is required');
  const document = JSON.parse(path === '-' ? readFileSync(0, 'utf8') : readFileSync(path, 'utf8'));
  if (args.k6Summary) {
    const policy = args.policy ? JSON.parse(readFileSync(args.policy, 'utf8')) : null;
    const result = policy ? evaluateK6Summary(document, policy, args) : trialMetricsFromK6Summary(document, args);
    console.log(JSON.stringify(result));
    if (policy && !result.decision.passed) process.exitCode = 2;
  } else {
    const decision = evaluateTrial(document.metrics, document.policy, Number(document.k6_exit_code ?? 0));
    console.log(JSON.stringify(decision));
    if (!decision.passed) process.exitCode = 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
