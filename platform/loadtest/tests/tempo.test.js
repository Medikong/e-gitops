import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTraceparent, summarizeTempoRoutes } from '../lib/tempo.js';
import { buildTrialResult } from '../scenarios/service-bottleneck-ramp-load-test/report.js';

const traceparent = '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01';
const tempoTrace = { resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'catalog-service' } }] }, scopeSpans: [{ spans: [{ traceId: '0123456789abcdef0123456789abcdef', spanId: '1111111111111111', parentSpanId: '0123456789abcdef', startTimeUnixNano: '1721779200000000000', endTimeUnixNano: '1721779200012300000', attributes: [{ key: 'http.route', value: { stringValue: '/drops' } }, { key: 'http.request.method', value: { stringValue: 'GET' } }, { key: 'http.response.status_code', value: { intValue: '200' } }, { key: 'authorization', value: { stringValue: 'must-not-appear' } }] }] }] }] };

test('Tempo adapter는 traceparent parent span과 service route가 모두 맞는 제한된 trace만 반환한다', () => {
  assert.deepEqual(parseTraceparent(traceparent), { trace_id: '0123456789abcdef0123456789abcdef', parent_span_id: '0123456789abcdef' });
  const trace = summarizeTempoRoutes(tempoTrace, { traceparent, service: 'catalog-service', routes: ['GET /drops'] })['GET /drops'];
  assert.equal(trace.trace_status, 'available');
  assert.equal(trace.trace_samples.length, 1);
  assert.deepEqual(trace.trace_samples[0], { trace_id: '0123456789abcdef0123456789abcdef', span_id: '1111111111111111', service: 'catalog-service', route: 'GET /drops', http_status_code: 200, duration_ms: 12.3, started_at: '2024-07-24T00:00:00.000Z', tempo_reference: '/api/traces/0123456789abcdef0123456789abcdef' });
  assert.doesNotMatch(JSON.stringify(trace), /must-not-appear|authorization/);
});

test('Tempo 부재와 parent span 불일치는 non-fatal unavailable로 정제한다', () => {
  const trace = summarizeTempoRoutes(tempoTrace, { traceparent: '00-0123456789abcdef0123456789abcdef-ffffffffffffffff-01', service: 'catalog-service', routes: ['GET /drops'] })['GET /drops'];
  assert.equal(trace.trace_status, 'unavailable');
  assert.deepEqual(trace.trace_samples, []);
  assert.doesNotMatch(JSON.stringify(trace), /must-not-appear|authorization/);
});

test('ramp report는 API 성능 수치와 trace summary를 서로 분리해 병합한다', () => {
  const traces = summarizeTempoRoutes(tempoTrace, { traceparent, service: 'catalog-service', routes: ['GET /drops'] });
  const trial = buildTrialResult({ service: 'catalog-service', profile: { endpointMix: [{ name: 'catalog.list', route: 'GET /drops', classification: 'read', weight: 100 }] }, durationSeconds: 10, rawK6Summary: { endpoints: [{ endpoint: 'catalog.list', requests: 10, actual_rps: 1, error_rate: 0, checks_rate: 1, p50_ms: 2, p95_ms: 4, p99_ms: 5 }] }, traces });
  assert.equal(trial.apis['GET /drops'].actual_rps, 1);
  assert.equal(trial.apis['GET /drops'].traces.trace_status, 'available');
});
