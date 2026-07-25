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

function endpointWindow(points, endpoint, durationSeconds) {
  const tagged = (metric) => points
    .filter((point) => point.metric === metric && point.tags?.endpoint === endpoint.name)
    .map((point) => point.value);
  const requestValues = tagged('loadtest_requests');
  const requests = sum(requestValues);
  const errors = tagged('loadtest_error_rate');
  const checks = tagged('checks');
  const latencies = tagged('loadtest_latency');
  return {
    requests,
    actual_rps: durationSeconds > 0 ? requests / durationSeconds : 0,
    error_rate: average(errors, requests > 0 ? 1 : null),
    checks_rate: average(checks, requests > 0 ? 0 : null),
    p50_ms: percentile(latencies, 0.5),
    p95_ms: percentile(latencies, 0.95),
    p99_ms: percentile(latencies, 0.99),
    status: requests > 0 ? 'observed' : 'unavailable',
  };
}

export function summarizeWindow(points, { index, startTime, endTime, schedule, minimumSamplesPerWindow, endpointMix = [] }) {
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
    reference_window_index: null,
    reference_target_rps: null,
    reference_actual_rps: null,
    actual_rps_delta_from_reference: null,
    p95_ms_delta_from_reference: null,
    p99_ms_delta_from_reference: null,
    eligible: requests >= minimumSamplesPerWindow,
    breached: false,
    reasons: [],
    apis: Object.fromEntries(endpointMix.map((endpoint) => [endpoint.route, endpointWindow(points, endpoint, durationSeconds)])),
  };
  if (!window.eligible) {
    window.status = 'insufficient_samples';
    return window;
  }
  window.status = 'pending_reference';
  return window;
}

function annotateReferenceWindows(windows) {
  let reference = null;
  for (const window of windows) {
    if (!window.eligible) continue;
    if (!reference) {
      window.status = 'reference';
      reference = window;
      continue;
    }
    window.reference_window_index = reference.index;
    window.reference_target_rps = reference.target_rps;
    window.reference_actual_rps = reference.actual_rps;
    window.actual_rps_delta_from_reference = window.actual_rps - reference.actual_rps;
    window.p95_ms_delta_from_reference = window.p95_ms == null || reference.p95_ms == null ? null : window.p95_ms - reference.p95_ms;
    window.p99_ms_delta_from_reference = window.p99_ms == null || reference.p99_ms == null ? null : window.p99_ms - reference.p99_ms;
    const reasons = [];
    if (window.target_rps > reference.target_rps && window.actual_rps <= reference.actual_rps) {
      reasons.push({ code: 'actual_rps_stalled_against_reference', observed: window.actual_rps, limit: reference.actual_rps });
    }
    if (window.dropped_iterations > 0) reasons.push({ code: 'dropped_iterations_observed', observed: window.dropped_iterations, limit: 0 });
    if (window.error_rate > 0) reasons.push({ code: 'http_error_observed', observed: window.error_rate, limit: 0 });
    if (window.check_pass_rate < 1) reasons.push({ code: 'check_failure_observed', observed: window.check_pass_rate, limit: 1 });
    window.reasons = reasons;
    window.breached = reasons.length > 0;
    window.status = window.breached ? 'degraded' : 'healthy';
    if (!window.breached) reference = window;
  }
  return windows;
}

export function evaluateCompletedWindows(points, { startedAt, now, schedule, evaluationWindowSeconds, minimumSamplesPerWindow, endpointMix = [] }) {
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
      endpointMix,
    }));
  }
  return annotateReferenceWindows(output);
}

export function reduceWindowDecisions(windows, consecutiveBreachWindows) {
  let streak = [];
  let lastHealthy = null;
  let termination = null;
  for (const window of windows) {
    if (!window.eligible) continue;
    if (!window.breached) {
      streak = [];
      lastHealthy = window;
      continue;
    }
    streak.push(window);
    if (streak.length >= consecutiveBreachWindows) {
      const confirmed = streak.slice(0, consecutiveBreachWindows);
      termination = {
        reason: 'consecutive_reference_degradation_windows',
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
  const eligible = windows.filter((window) => window.eligible);
  const peak = (field) => eligible.reduce((maximum, window) => Math.max(maximum, Number(window[field]) || 0), 0);
  const firstDegraded = termination ? windows.find((window) => window.index === termination.first_window_index) : null;
  return {
    // Legacy fields remain target-RPS values. New fields below make target,
    // reference and actual throughput unambiguous for exploratory analysis.
    last_healthy_rps: lastHealthy?.target_rps ?? null,
    first_degraded_rps: termination?.first_degraded_rps ?? null,
    consecutive_breach_count: termination ? consecutiveBreachWindows : streak.length,
    termination,
    reference: {
      last_healthy_window_index: lastHealthy?.index ?? null,
      last_healthy_target_rps: lastHealthy?.target_rps ?? null,
      last_healthy_actual_rps: lastHealthy?.actual_rps ?? null,
      peak_target_rps: eligible.length ? peak('target_rps') : null,
      peak_actual_rps: eligible.length ? peak('actual_rps') : null,
    },
    degradation: firstDegraded ? {
      first: {
        window_index: firstDegraded.index,
        target_rps: firstDegraded.target_rps,
        actual_rps: firstDegraded.actual_rps,
        reference_target_rps: firstDegraded.reference_target_rps,
        reference_actual_rps: firstDegraded.reference_actual_rps,
      },
    } : { first: null },
  };
}

export function classifyBottleneck(window) {
  if (!window) return { candidate: 'not-observed', evidence: [] };
  const codes = window.reasons.map((reason) => reason.code);
  if (codes.some((code) => ['actual_rps_stalled_against_reference', 'dropped_iterations_observed'].includes(code))) return { candidate: 'service-capacity-growth-stalled', evidence: window.reasons };
  if (codes.length) return { candidate: 'http-or-check-regression', evidence: window.reasons };
  return { candidate: 'unknown', evidence: [] };
}

export function rampExitIsExecutionFailure(code, stoppedForBottleneck) {
  // Reference ramps no longer use k6 performance thresholds. A threshold exit
  // therefore means that even the minimal measurement contract was not met.
  const accepted = new Set(stoppedForBottleneck ? [0, 105, 130, 143] : [0]);
  return !accepted.has(Number(code));
}
