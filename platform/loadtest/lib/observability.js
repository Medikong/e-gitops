const SENSITIVE_LABEL = /(authorization|cookie|credential|password|secret|token|coupon)/i;
const SNAPSHOT_SCHEMA_VERSION = 'dropmong.loadtest.observability-snapshot/v1';

function nonEmptyString(name, value) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be a non-empty string`);
  return value.trim();
}

function positiveInteger(name, value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new TypeError(`${name} must be a positive integer`);
  return number;
}

function timestamp(name, value) {
  const normalized = nonEmptyString(name, value);
  if (!Number.isFinite(Date.parse(normalized))) throw new TypeError(`${name} must be an ISO-8601 timestamp`);
  return normalized;
}

function safeReason(error) {
  if (error?.code === 'prometheus_url_missing') return 'Prometheus URL is not configured';
  if (error?.code === 'prometheus_timeout') return 'Prometheus query timed out';
  if (Number.isInteger(error?.status)) return `Prometheus returned HTTP ${error.status}`;
  if (error?.code === 'prometheus_response_invalid') return 'Prometheus returned an invalid range response';
  return 'Prometheus query failed';
}

function sanitizedLabels(labels) {
  if (!labels || typeof labels !== 'object' || Array.isArray(labels)) return {};
  return Object.fromEntries(Object.entries(labels)
    .filter(([key]) => !SENSITIVE_LABEL.test(key))
    .map(([key, value]) => [String(key), String(value).slice(0, 512)]));
}

function promqlStringValue(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

export function renderMetricQuery(query, { service, namespace, replicas, runId, window = '1s' }) {
  return query
    .replaceAll('{{service}}', promqlStringValue(service))
    .replaceAll('{{namespace}}', promqlStringValue(namespace))
    .replaceAll('{{replicas}}', String(replicas))
    .replaceAll('{{run_id}}', promqlStringValue(runId))
    .replaceAll('{{window}}', String(window));
}

export function parsePrometheusMatrix(document) {
  if (document?.status !== 'success' || document.data?.resultType !== 'matrix' || !Array.isArray(document.data.result)) {
    const error = new TypeError('Prometheus range response is invalid');
    error.code = 'prometheus_response_invalid';
    throw error;
  }
  return document.data.result
    .map((item) => ({
      labels: sanitizedLabels(item.metric),
      values: (item.values ?? [])
        .map(([at, value]) => [Number(at), Number(value)])
        .filter(([at, value]) => Number.isFinite(at) && Number.isFinite(value)),
    }))
    .filter((series) => series.values.length > 0);
}

export function normalizeMetricSpecs(metricSpecs) {
  if (!Array.isArray(metricSpecs) || metricSpecs.length === 0) throw new TypeError('metricSpecs must contain at least one metric');
  const ids = new Set();
  return metricSpecs.map((specification, index) => {
    if (!specification || typeof specification !== 'object' || Array.isArray(specification)) throw new TypeError(`metricSpecs[${index}] must be an object`);
    const id = nonEmptyString(`metricSpecs[${index}].id`, specification.id);
    if (ids.has(id)) throw new TypeError(`metricSpecs contains duplicate id: ${id}`);
    ids.add(id);
    return {
      id,
      query: nonEmptyString(`metricSpecs[${index}].query`, specification.query),
      unit: specification.unit == null ? null : nonEmptyString(`metricSpecs[${index}].unit`, specification.unit),
      required: Boolean(specification.required),
    };
  });
}

function normalizeSnapshotInput(input) {
  const startedAt = timestamp('startedAt', input?.startedAt);
  const finishedAt = timestamp('finishedAt', input?.finishedAt);
  if (Date.parse(finishedAt) < Date.parse(startedAt)) throw new TypeError('finishedAt must not precede startedAt');
  const windowSeconds = Math.max(1, Math.ceil((Date.parse(finishedAt) - Date.parse(startedAt)) / 1000));
  return {
    startedAt,
    finishedAt,
    service: nonEmptyString('service', input?.service),
    namespace: nonEmptyString('namespace', input?.namespace),
    replicas: positiveInteger('replicas', input?.replicas),
    runId: nonEmptyString('runId', input?.runId),
    // Scenario PromQL may need a range selector. It is derived only from the
    // read-only snapshot interval, so the common adapter never owns a metric.
    window: `${windowSeconds}s`,
    metricSpecs: normalizeMetricSpecs(input?.metricSpecs),
  };
}

function unavailableMetric(specification, reason) {
  return {
    status: 'unavailable',
    value: null,
    unit: specification.unit,
    required: specification.required,
    reason,
    series: [],
  };
}

function availableMetric(specification, series) {
  return {
    status: 'available',
    unit: specification.unit,
    required: specification.required,
    reason: null,
    series,
  };
}

export async function collectObservabilitySnapshot(input, { queryRange } = {}) {
  const context = normalizeSnapshotInput(input);
  if (typeof queryRange !== 'function') throw new TypeError('queryRange must be a function');
  const entries = await Promise.all(context.metricSpecs.map(async (specification) => {
    try {
      const query = renderMetricQuery(specification.query, context);
      const document = await queryRange({
        query,
        startedAt: context.startedAt,
        finishedAt: context.finishedAt,
        metric: specification.id,
      });
      const series = parsePrometheusMatrix(document);
      return [specification.id, series.length
        ? availableMetric(specification, series)
        : unavailableMetric(specification, 'no samples in requested window')];
    } catch (error) {
      return [specification.id, unavailableMetric(specification, safeReason(error))];
    }
  }));
  const metrics = Object.fromEntries(entries);
  return {
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    status: Object.values(metrics).some((metric) => metric.status === 'available') ? 'available' : 'unavailable',
    window: { started_at: context.startedAt, finished_at: context.finishedAt },
    run_id: context.runId,
    service: context.service,
    namespace: context.namespace,
    replicas: context.replicas,
    metrics,
  };
}

export async function queryPrometheusRange({ prometheusUrl, query, startedAt, finishedAt, stepSeconds, fetchImpl = globalThis.fetch, timeoutMs = 10_000 }) {
  if (!prometheusUrl) {
    const error = new Error('Prometheus URL is not configured');
    error.code = 'prometheus_url_missing';
    throw error;
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
  const url = new URL('/api/v1/query_range', prometheusUrl);
  url.searchParams.set('query', query);
  url.searchParams.set('start', startedAt);
  url.searchParams.set('end', finishedAt);
  url.searchParams.set('step', String(stepSeconds));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response?.ok) {
      const error = new Error('Prometheus HTTP failure');
      error.status = Number(response?.status) || 502;
      throw error;
    }
    try {
      return await response.json();
    } catch {
      const error = new Error('Prometheus range response is invalid');
      error.code = 'prometheus_response_invalid';
      throw error;
    }
  } catch (error) {
    if (controller.signal.aborted) {
      const timeout = new Error('Prometheus query timed out');
      timeout.code = 'prometheus_timeout';
      throw timeout;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function createPrometheusObservabilityAdapter({ prometheusUrl = '', stepSeconds = 15, fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  const step = positiveInteger('stepSeconds', stepSeconds);
  const timeout = positiveInteger('timeoutMs', timeoutMs);
  return {
    snapshot(input) {
      return collectObservabilitySnapshot(input, {
        queryRange: ({ query, startedAt, finishedAt }) => queryPrometheusRange({
          prometheusUrl,
          query,
          startedAt,
          finishedAt,
          stepSeconds: step,
          fetchImpl,
          timeoutMs: timeout,
        }),
      });
    },
  };
}
