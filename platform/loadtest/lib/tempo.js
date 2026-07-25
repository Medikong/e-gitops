import { Buffer } from 'node:buffer';

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-0[01]$/i;
const SENSITIVE = /(authorization|cookie|credential|password|secret|token|coupon|email|user[_-]?id)/i;

function safeReason(value, fallback = 'Tempo trace query failed') {
  const text = String(value ?? '').replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\b(authorization|cookie|credential|password|secret|token|coupon(?:[_ -]?code)?|email|user[_-]?id)\s*[:=]\s*[^\s,;&]+/gi, '$1=[redacted]')
    .replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 240) : fallback;
}

function attributeValue(value) {
  if (value == null || typeof value !== 'object') return value;
  for (const key of ['stringValue', 'intValue', 'doubleValue', 'boolValue']) if (value[key] !== undefined) return value[key];
  return null;
}

function attributes(entries = []) {
  return Object.fromEntries((entries ?? []).filter((entry) => entry?.key && !SENSITIVE.test(entry.key))
    .map((entry) => [entry.key, attributeValue(entry.value)]));
}

function id(value, bytes) {
  if (typeof value !== 'string' || !value) return null;
  const normalized = value.toLowerCase();
  if (new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(normalized)) return normalized;
  try {
    const decoded = Buffer.from(value, 'base64');
    return decoded.length === bytes ? decoded.toString('hex') : null;
  } catch {
    return null;
  }
}

function spanDurationMs(span) {
  const start = Number(span?.startTimeUnixNano);
  const end = Number(span?.endTimeUnixNano);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? Number(((end - start) / 1_000_000).toFixed(3)) : null;
}

function spanStartedAt(span) {
  const nanos = Number(span?.startTimeUnixNano);
  return Number.isFinite(nanos) ? new Date(Math.floor(nanos / 1_000_000)).toISOString() : null;
}

function allSpans(document) {
  const groups = document?.resourceSpans ?? document?.batches ?? [];
  return groups.flatMap((group) => {
    const service = attributes(group?.resource?.attributes)['service.name'] ?? null;
    const scopeSpans = group?.scopeSpans ?? group?.instrumentationLibrarySpans ?? [];
    return scopeSpans.flatMap((scope) => (scope?.spans ?? []).map((span) => ({ span, service })));
  });
}

function routeParts(route) {
  const matched = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(.+)$/.exec(String(route ?? ''));
  return matched ? { method: matched[1], path: matched[2] } : { method: null, path: String(route ?? '') };
}

export function parseTraceparent(value) {
  const match = TRACEPARENT.exec(String(value ?? ''));
  return match ? { trace_id: match[1].toLowerCase(), parent_span_id: match[2].toLowerCase() } : null;
}

export function unavailableTraceSummary(reason) {
  return { trace_status: 'unavailable', trace_samples: [], reason: safeReason(reason, 'Tempo trace is unavailable') };
}

export function summarizeTempoTrace(document, { traceparent, service, route, maxSamples = 2 } = {}) {
  const probe = parseTraceparent(traceparent);
  if (!probe) return unavailableTraceSummary('invalid loadtest traceparent');
  const expected = routeParts(route);
  const samples = allSpans(document).flatMap(({ span, service: spanService }) => {
    const attrs = attributes(span?.attributes);
    const method = attrs['http.request.method'] ?? attrs['http.method'];
    const path = attrs['http.route'];
    const parentSpanId = id(span?.parentSpanId, 8);
    const spanId = id(span?.spanId, 8);
    if (spanService !== service || path !== expected.path || (expected.method && method !== expected.method) || parentSpanId !== probe.parent_span_id || !spanId) return [];
    const status = Number(attrs['http.response.status_code'] ?? attrs['http.status_code']);
    return [{
      trace_id: probe.trace_id,
      span_id: spanId,
      service: spanService,
      route,
      http_status_code: Number.isFinite(status) ? status : null,
      duration_ms: spanDurationMs(span),
      started_at: spanStartedAt(span),
      tempo_reference: `/api/traces/${probe.trace_id}`,
    }];
  }).slice(0, Math.max(1, Math.min(Number(maxSamples) || 2, 5)));
  return samples.length
    ? { trace_status: 'available', trace_samples: samples, reason: null }
    : unavailableTraceSummary('no matching Tempo span with the injected traceparent was found in the run window');
}

export function summarizeTempoRoutes(document, { traceparent, service, routes, maxSamples = 2 } = {}) {
  return Object.fromEntries((routes ?? []).map((route) => [route, summarizeTempoTrace(document, { traceparent, service, route, maxSamples })]));
}
