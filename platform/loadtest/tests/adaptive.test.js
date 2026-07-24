import test from 'node:test';
import assert from 'node:assert/strict';
import { createSearchState, evaluateK6Summary, evaluateTrial, finalizeSearch, geometricMeanCandidate, initialRpsCandidate, nextSearchCandidate, recordTrial, searchShouldStop, trialMetricsFromK6Summary, withinRpsTolerance } from '../scripts/adaptive.js';

const healthy = { target_rps: 100, actual_rps: 99, error_rate: 0.001, check_pass_rate: 1, failed_checks: 0, dropped_iterations: 0, request_count: 5940, successful_requests: 5934, p50_ms: 20, p95_ms: 80, p99_ms: 130, max_latency_ms: 250, cpu_utilization: 0.7, cpu_throttle_ratio: 0.02, pod_restarts: 0, memory_utilization: 0.6, memory_start_bytes: 100, memory_end_bytes: 100, oom_killed: false, postgresql_pool_exhaustions: 0, kafka_lag_start: 10, kafka_lag_end: 10 };
const policy = { p95_slo_ms: 100, p99_slo_ms: 150, required_observations: ['cpu_utilization', 'cpu_throttle_ratio', 'memory_utilization', 'pod_restarts', 'kafka_lag'] };

test('CPU 비용으로 초기 후보를 계산하고 범위를 제한한다', () => {
  assert.equal(initialRpsCandidate({ cpuCoreSeconds: 2, successfulRequests: 1000, allocatedCpuCores: 1, targetCpuUtilization: 0.8 }), 400);
  assert.equal(initialRpsCandidate({ cpuCoreSeconds: 1, successfulRequests: 1000, allocatedCpuCores: 2, targetCpuUtilization: 0.8, maximumRps: 500 }), 500);
});

test('기하 평균과 상대 허용 오차로 탐색 경계를 좁힌다', () => {
  assert.equal(geometricMeanCandidate(100, 400), 200);
  assert.equal(withinRpsTolerance(100, 95, 0.05), true);
  assert.equal(withinRpsTolerance(100, 105.1, 0.05), false);
  assert.equal(searchShouldStop(100, 110, 0.1), true);
});

test('성능, API, 관측성 실패를 구분하고 k6 threshold 종료를 숨기지 않는다', () => {
  assert.equal(evaluateTrial(healthy, policy).passed, true);
  const threshold = evaluateTrial(healthy, policy, 99);
  assert.equal(threshold.passed, false);
  assert.equal(threshold.conclusive, true);
  assert.ok(threshold.reasons.some((reason) => reason.code === 'k6_performance_threshold_exit'));
  const missing = evaluateTrial({ ...healthy, cpu_throttle_ratio: null }, policy);
  assert.equal(missing.conclusive, false);
  assert.ok(missing.reasons.some((reason) => reason.category === 'observability'));
});

test('정규화된 k6 summary와 threshold 상태를 보존한다', () => {
  const summary = { target_rps: 80, actual_rps: 79.5, request_count: 4770, successful_requests: 4760, failed_requests: 10, error_rate: 10 / 4770, check_pass_rate: 0.999, failed_checks: 5, dropped_iterations: 1, p50_ms: 12, p95_ms: 45, p99_ms: 70, max_latency_ms: 120, thresholds_passed: false };
  assert.equal(trialMetricsFromK6Summary(summary).p99_ms, 70);
  const result = evaluateK6Summary(summary, { p95_slo_ms: 100, p99_slo_ms: 200 });
  assert.equal(result.decision.passed, false);
  assert.ok(result.decision.reasons.some((reason) => reason.code === 'k6_summary_threshold_failed'));
});

test('독립 시행을 모두 보존하며 기하 이진 탐색을 수렴시킨다', () => {
  const trial = (id, target, passed) => ({ trial_id: id, service: 'catalog-service', phase: 'search', metrics: { target_rps: target }, decision: { passed, conclusive: true, reasons: [] } });
  let state = createSearchState('catalog-service', 100, 1000);
  state = recordTrial(state, trial('pass-100', 100, true));
  state = recordTrial(state, trial('fail-400', 400, false));
  assert.equal(nextSearchCandidate(state), 200);
  state = recordTrial(state, trial('pass-200', 200, true));
  state = recordTrial(state, trial('fail-210', 210, false));
  assert.equal(state.status, 'converged');
  assert.equal(finalizeSearch(state).reliable_stable_rps, 200);
  assert.equal(state.trials.length, 4);
});
