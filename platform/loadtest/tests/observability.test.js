import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectObservabilitySnapshot,
  createPrometheusObservabilityAdapter,
  parsePrometheusMatrix,
} from '../lib/observability.js';

const input = {
  startedAt: '2026-07-24T00:00:00.000Z',
  finishedAt: '2026-07-24T00:01:00.000Z',
  service: 'catalog-service',
  namespace: 'dropmong-catalog',
  replicas: 1,
  runId: 'local-smoke',
  metricSpecs: [{
    id: 'service_cpu',
    query: 'sum(rate(container_cpu_usage_seconds_total[1m]))',
    unit: 'cores',
    required: false,
  }],
};

const success = {
  status: 'success',
  data: {
    resultType: 'matrix',
    result: [{
      metric: { namespace: 'dropmong-catalog', pod: 'catalog-1' },
      values: [[1721779200, '0.25'], [1721779215, '0.5']],
    }],
  },
};

test('adapter는 k6 종료 구간과 scenario metric spec으로 Prometheus query_range를 한 번 실행한다', async () => {
  const requests = [];
  const adapter = createPrometheusObservabilityAdapter({
    prometheusUrl: 'http://prometheus.monitoring.svc:9090',
    stepSeconds: 15,
    fetchImpl: async (url) => {
      requests.push(url);
      return { ok: true, json: async () => success };
    },
  });
  const snapshot = await adapter.snapshot(input);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].pathname, '/api/v1/query_range');
  assert.equal(requests[0].searchParams.get('query'), input.metricSpecs[0].query);
  assert.equal(requests[0].searchParams.get('start'), input.startedAt);
  assert.equal(requests[0].searchParams.get('end'), input.finishedAt);
  assert.equal(snapshot.status, 'available');
  assert.deepEqual(snapshot.window, { started_at: input.startedAt, finished_at: input.finishedAt });
  assert.equal(snapshot.service, input.service);
  assert.equal(snapshot.metrics.service_cpu.status, 'available');
  assert.deepEqual(snapshot.metrics.service_cpu.series[0].values, [[1721779200, 0.25], [1721779215, 0.5]]);
});

test('scenario query의 공통 placeholder는 PromQL에 단순 치환하고 snapshot에는 남기지 않는다', async () => {
  const queries = [];
  const snapshot = await collectObservabilitySnapshot({
    ...input,
    metricSpecs: [{
      ...input.metricSpecs[0],
      query: 'sum(metric{service_name="{{service}}",namespace="{{namespace}}",replicas="{{replicas}}",run_id="{{run_id}}"}[{{window}}])',
    }],
  }, {
    queryRange: async ({ query }) => {
      queries.push(query);
      return success;
    },
  });
  assert.equal(queries[0], 'sum(metric{service_name="catalog-service",namespace="dropmong-catalog",replicas="1",run_id="local-smoke"}[60s])');
  assert.doesNotMatch(JSON.stringify(snapshot), /\{\{service\}\}|\{\{namespace\}\}|\{\{replicas\}\}|\{\{run_id\}\}|\{\{window\}\}/);
  assert.doesNotMatch(JSON.stringify(snapshot), /sum\(metric/);
});

test('metric 부재는 0 대신 null과 unavailable로 기록한다', async () => {
  const snapshot = await collectObservabilitySnapshot(input, {
    queryRange: async () => ({ status: 'success', data: { resultType: 'matrix', result: [] } }),
  });
  assert.equal(snapshot.status, 'unavailable');
  assert.equal(snapshot.metrics.service_cpu.status, 'unavailable');
  assert.equal(snapshot.metrics.service_cpu.value, null);
  assert.equal(snapshot.metrics.service_cpu.reason, 'no samples in requested window');
  assert.deepEqual(snapshot.metrics.service_cpu.series, []);
});

test('query 오류는 비밀값 없이 unavailable snapshot으로 정제한다', async () => {
  const snapshot = await collectObservabilitySnapshot(input, {
    queryRange: async () => { throw new Error('Authorization: Bearer secret-value'); },
  });
  const metric = snapshot.metrics.service_cpu;
  assert.equal(metric.status, 'unavailable');
  assert.equal(metric.value, null);
  assert.equal(metric.reason, 'Prometheus query failed');
  assert.doesNotMatch(JSON.stringify(snapshot), /secret-value|Bearer|Authorization/);
});

test('raw series label에서 credential 성격의 label은 제거한다', () => {
  const [series] = parsePrometheusMatrix({
    status: 'success',
    data: {
      resultType: 'matrix',
      result: [{
        metric: { pod: 'catalog-1', authorization: 'Bearer secret-value', coupon_code: 'hidden' },
        values: [[1721779200, '1']],
      }],
    },
  });
  assert.deepEqual(series.labels, { pod: 'catalog-1' });
});
