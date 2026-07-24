import { averageTargetRps, targetRpsAt } from '../../lib/ramp.js';

function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const rank = (sorted.length - 1) * fraction;
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  return lower === upper ? sorted[lower] : sorted[lower] + (sorted[upper] - sorted[lower]) * (rank - lower);
}

export function parseK6Points(text) {
  const points = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.type !== 'Point' || typeof row.metric !== 'string') continue;
    const timestamp = Date.parse(row.data?.time);
    const value = Number(row.data?.value);
    if (!Number.isFinite(timestamp) || !Number.isFinite(value)) continue;
    points.push({ metric: row.metric, timestamp, value, tags: row.data?.tags ?? {} });
  }
  return points.sort((left, right) => left.timestamp - right.timestamp);
}

function values(points, metric) {
  return points.filter((point) => point.metric === metric).map((point) => point.value);
}

function sum(numbers) {
  return numbers.reduce((total, value) => total + value, 0);
}

function average(numbers, fallback = null) {
  return numbers.length ? sum(numbers) / numbers.length : fallback;
}

function endpointWindow(points, endpoint, durationSeconds, slo) {
  const tagged = (metric) => points
    .filter((point) => point.metric === metric && point.tags?.endpoint === endpoint.name)
    .map((point) => point.value);
  const requestValues = tagged('loadtest_requests');
  const requests = sum(requestValues);
  const errors = tagged('loadtest_error_rate');
  const checks = tagged('checks');
  const latencies = tagged('loadtest_latency');
  const threshold = {
    error_rate: Number(slo.errorRate),
    checks_rate: Number(slo.checkPassRate),
    p95_ms: Number(endpoint.p95Ms ?? slo.p95Ms),
    p99_ms: Number(endpoint.p99Ms ?? slo.p99Ms),
  };
  const api = {
    requests,
    actual_rps: durationSeconds > 0 ? requests / durationSeconds : 0,
    error_rate: average(errors, requests > 0 ? 1 : null),
    checks_rate: average(checks, requests > 0 ? 0 : null),
    p50_ms: percentile(latencies, 0.5),
    p95_ms: percentile(latencies, 0.95),
    p99_ms: percentile(latencies, 0.99),
    threshold,
    status: requests > 0 ? 'healthy' : 'unavailable',
    reasons: [],
  };
  if (requests === 0) {
    api.reasons.push({ code: 'request_count_unavailable', observed: 0, limit: 1 });
    return api;
  }
  if (api.error_rate > threshold.error_rate) api.reasons.push({ code: 'error_rate_exceeded', observed: api.error_rate, limit: threshold.error_rate });
  if (api.checks_rate < threshold.checks_rate) api.reasons.push({ code: 'check_pass_rate_below_minimum', observed: api.checks_rate, limit: threshold.checks_rate });
  if (api.p95_ms == null || api.p95_ms > threshold.p95_ms) api.reasons.push({ code: 'p95_slo_exceeded', observed: api.p95_ms, limit: threshold.p95_ms });
  if (api.p99_ms == null || api.p99_ms > threshold.p99_ms) api.reasons.push({ code: 'p99_slo_exceeded', observed: api.p99_ms, limit: threshold.p99_ms });
  api.status = api.reasons.length ? 'breached' : 'healthy';
  return api;
}

export function summarizeWindow(points, { index, startTime, endTime, schedule, minimumSamplesPerWindow, slo, endpointMix = [] }) {
  const requestValues = values(points, 'loadtest_requests');
  const requests = sum(requestValues);
  const durationSeconds = (endTime - startTime) / 1000;
  const scheduleStart = (startTime - schedule.startedAt) / 1000;
  const scheduleEnd = (endTime - schedule.startedAt) / 1000;
  const targetRps = averageTargetRps(schedule, scheduleStart, scheduleEnd);
  const errorValues = values(points, 'loadtest_error_rate');
  const checkValues = values(points, 'checks');
  const latencyValues = values(points, 'loadtest_latency');
  const dropped = sum(values(points, 'dropped_iterations'));
  const window = {
    index,
    started_at: new Date(startTime).toISOString(),
    ended_at: new Date(endTime).toISOString(),
    target_rps_start: targetRpsAt(schedule, scheduleStart),
    target_rps_end: targetRpsAt(schedule, scheduleEnd),
    target_rps: targetRps,
    actual_rps: durationSeconds > 0 ? requests / durationSeconds : 0,
    request_count: requests,
    error_rate: average(errorValues, requests > 0 ? 1 : null),
    check_pass_rate: average(checkValues, requests > 0 ? 0 : null),
    check_sample_count: checkValues.length,
    dropped_iterations: dropped,
    p50_ms: percentile(latencyValues, 0.5),
    p95_ms: percentile(latencyValues, 0.95),
    p99_ms: percentile(latencyValues, 0.99),
    latency_sample_count: latencyValues.length,
    eligible: requests >= minimumSamplesPerWindow,
    breached: false,
    reasons: [],
    apis: Object.fromEntries(endpointMix.map((endpoint) => [endpoint.route, endpointWindow(points, endpoint, durationSeconds, slo)])),
  };
  if (!window.eligible) {
    window.status = 'insufficient_samples';
    return window;
  }
  const reasons = [];
  const minimumRps = targetRps * (1 - Number(slo.actualRpsTolerance));
  if (window.actual_rps < minimumRps) reasons.push({ code: 'actual_rps_below_tolerance', observed: window.actual_rps, limit: minimumRps });
  if (window.dropped_iterations > 0) reasons.push({ code: 'dropped_iterations', observed: window.dropped_iterations, limit: 0 });
  if (window.error_rate > Number(slo.errorRate)) reasons.push({ code: 'error_rate_exceeded', observed: window.error_rate, limit: Number(slo.errorRate) });
  if (window.check_pass_rate < Number(slo.checkPassRate)) reasons.push({ code: 'check_pass_rate_below_minimum', observed: window.check_pass_rate, limit: Number(slo.checkPassRate) });
  if (window.p95_ms == null || window.p95_ms > Number(slo.p95Ms)) reasons.push({ code: 'p95_slo_exceeded', observed: window.p95_ms, limit: Number(slo.p95Ms) });
  if (window.p99_ms == null || window.p99_ms > Number(slo.p99Ms)) reasons.push({ code: 'p99_slo_exceeded', observed: window.p99_ms, limit: Number(slo.p99Ms) });
  for (const [api, value] of Object.entries(window.apis)) {
    if (value.status !== 'breached') continue;
    for (const reason of value.reasons) reasons.push({ ...reason, code: `api_${reason.code}`, api });
  }
  window.reasons = reasons;
  window.breached = reasons.length > 0;
  window.status = window.breached ? 'breached' : 'healthy';
  return window;
}

export function evaluateCompletedWindows(points, { startedAt, now, schedule, evaluationWindowSeconds, minimumSamplesPerWindow, slo, endpointMix = [] }) {
  const started = Date.parse(startedAt);
  const current = Math.min(Date.parse(now), started + schedule.durationSeconds * 1000);
  if (!Number.isFinite(started) || !Number.isFinite(current)) throw new TypeError('window timestamps must be valid');
  const windowMs = Number(evaluationWindowSeconds) * 1000;
  const complete = Math.max(0, Math.floor((current - started) / windowMs));
  const withStart = { ...schedule, startedAt: started };
  const output = [];
  for (let index = 0; index < complete; index += 1) {
    const startTime = started + index * windowMs;
    const endTime = startTime + windowMs;
    const selected = points.filter((point) => point.timestamp >= startTime && point.timestamp < endTime);
    output.push(summarizeWindow(selected, {
      index: index + 1,
      startTime,
      endTime,
      schedule: withStart,
      minimumSamplesPerWindow,
      slo,
      endpointMix,
    }));
  }
  return output;
}

export function reduceWindowDecisions(windows, consecutiveBreachWindows) {
  let streak = [];
  let lastHealthyRps = null;
  let termination = null;
  for (const window of windows) {
    if (!window.eligible) continue;
    if (!window.breached) {
      streak = [];
      lastHealthyRps = window.target_rps;
      continue;
    }
    streak.push(window);
    if (streak.length >= consecutiveBreachWindows) {
      const confirmed = streak.slice(0, consecutiveBreachWindows);
      termination = {
        reason: 'consecutive_breach_windows',
        required_windows: consecutiveBreachWindows,
        first_window_index: confirmed[0].index,
        last_window_index: confirmed.at(-1).index,
        first_degraded_rps: confirmed[0].target_rps,
        detected_at: confirmed.at(-1).ended_at,
        reasons: [...new Set(confirmed.flatMap((item) => item.reasons.map((reason) => reason.code)))],
      };
      break;
    }
  }
  return {
    last_healthy_rps: lastHealthyRps,
    first_degraded_rps: termination?.first_degraded_rps ?? null,
    consecutive_breach_count: termination ? consecutiveBreachWindows : streak.length,
    termination,
  };
}

export function classifyBottleneck(window) {
  if (!window) return { candidate: 'not-observed', evidence: [] };
  const codes = window.reasons.map((reason) => reason.code);
  if (codes.some((code) => ['actual_rps_below_tolerance', 'dropped_iterations'].includes(code))) return { candidate: 'runner-or-service-capacity', evidence: window.reasons };
  if (codes.length) return { candidate: 'api-slo-or-error', evidence: window.reasons };
  return { candidate: 'unknown', evidence: [] };
}

export function rampExitIsExecutionFailure(code, stoppedForBottleneck) {
  const accepted = new Set(stoppedForBottleneck ? [0, 99, 105, 130, 143, 201] : [0, 99, 201]);
  return !accepted.has(Number(code));
}
