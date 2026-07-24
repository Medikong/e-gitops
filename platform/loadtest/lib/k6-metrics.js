function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function firstFinite(values) {
  for (const value of values) {
    const number = finiteNumber(value);
    if (number !== null) return number;
  }
  return null;
}

function metricValues(summary, name) {
  return summary?.metrics?.[name]?.values ?? null;
}

export function k6MetricValue(summary, names, keys) {
  for (const name of Array.isArray(names) ? names : [names]) {
    const values = metricValues(summary, name);
    if (!values) continue;
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      const value = finiteNumber(values[key]);
      if (value !== null) return value;
    }
  }
  return null;
}

function metricRate(summary, names, requestCount = null) {
  for (const name of Array.isArray(names) ? names : [names]) {
    const values = metricValues(summary, name);
    if (!values) continue;
    const rate = finiteNumber(values.rate);
    if (rate !== null) return rate;
    const count = finiteNumber(values.count);
    if (count !== null && requestCount !== null && requestCount > 0) return count / requestCount;
  }
  return null;
}

function endpointMetricName(metric, endpoint) {
  return `${metric}{endpoint:${endpoint}}`;
}

function endpointMetricValue(summary, metric, endpoint, keys) {
  const exact = endpointMetricName(metric, endpoint);
  const value = k6MetricValue(summary, exact, keys);
  if (value !== null) return value;

  // k6 can retain additional tags in a submetric name. Keep the endpoint tag
  // contract as the selector instead of deriving an API name from a URL.
  const marker = `endpoint:${endpoint}`;
  for (const [name, entry] of Object.entries(summary?.metrics ?? {})) {
    if (!name.startsWith(`${metric}{`) || !name.includes(marker)) continue;
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      const candidate = finiteNumber(entry?.values?.[key]);
      if (candidate !== null) return candidate;
    }
  }
  return null;
}

function endpointMetricRate(summary, metric, endpoint, requestCount) {
  const exact = endpointMetricName(metric, endpoint);
  const direct = metricRate(summary, exact, requestCount);
  if (direct !== null) return direct;
  const marker = `endpoint:${endpoint}`;
  for (const [name, entry] of Object.entries(summary?.metrics ?? {})) {
    if (!name.startsWith(`${metric}{`) || !name.includes(marker)) continue;
    const rate = finiteNumber(entry?.values?.rate);
    if (rate !== null) return rate;
    const count = finiteNumber(entry?.values?.count);
    if (count !== null && requestCount !== null && requestCount > 0) return count / requestCount;
  }
  return null;
}

function normalizedEndpointSummary(summary, endpoint) {
  return (summary?.endpoints ?? []).find((item) => item?.endpoint === endpoint.name) ?? null;
}

function endpointField(summary, endpoint, names, fallback) {
  const entry = normalizedEndpointSummary(summary, endpoint);
  if (!entry) return fallback;
  return firstFinite(names.map((name) => entry[name])) ?? fallback;
}

export function k6TrialMetrics(summary, { targetRps = null, durationSeconds = null } = {}) {
  const requestCount = firstFinite([
    summary?.request_count,
    k6MetricValue(summary, ['loadtest_requests', 'http_reqs'], 'count'),
  ]);
  let actualRps = firstFinite([
    summary?.actual_rps,
    k6MetricValue(summary, ['loadtest_requests', 'http_reqs'], 'rate'),
  ]);
  if (actualRps === null && requestCount !== null && Number(durationSeconds) > 0) {
    actualRps = requestCount / Number(durationSeconds);
  }

  let errorRate = firstFinite([
    summary?.error_rate,
    metricRate(summary, ['loadtest_error_rate', 'http_req_failed'], requestCount),
  ]);
  const failedRequests = firstFinite([
    summary?.failed_requests,
    k6MetricValue(summary, ['loadtest_errors'], ['count', 'fails']),
  ]);
  if (errorRate === null && failedRequests !== null && requestCount !== null && requestCount > 0) {
    errorRate = failedRequests / requestCount;
  }

  const successfulRequests = firstFinite([
    summary?.successful_requests,
    k6MetricValue(summary, ['loadtest_successes', 'loadtest_success'], ['count', 'passes']),
  ]) ?? (requestCount !== null && failedRequests !== null ? Math.max(0, requestCount - failedRequests) : null);

  return {
    target_rps: firstFinite([targetRps, summary?.target_rps]),
    actual_rps: actualRps,
    request_count: requestCount,
    successful_requests: successfulRequests,
    failed_requests: failedRequests,
    error_rate: errorRate,
    check_pass_rate: firstFinite([
      summary?.check_pass_rate,
      summary?.checks_rate,
      k6MetricValue(summary, 'checks', 'rate'),
    ]),
    failed_checks: firstFinite([
      summary?.failed_checks,
      k6MetricValue(summary, 'checks', 'fails'),
    ]),
    dropped_iterations: firstFinite([
      summary?.dropped_iterations,
      k6MetricValue(summary, 'dropped_iterations', 'count'),
    ]),
    p50_ms: firstFinite([
      summary?.p50_ms,
      k6MetricValue(summary, ['loadtest_latency', 'http_req_duration'], ['med', 'p(50)']),
    ]),
    p95_ms: firstFinite([
      summary?.p95_ms,
      k6MetricValue(summary, ['loadtest_latency', 'http_req_duration'], 'p(95)'),
    ]),
    p99_ms: firstFinite([
      summary?.p99_ms,
      k6MetricValue(summary, ['loadtest_latency', 'http_req_duration'], 'p(99)'),
    ]),
    max_latency_ms: firstFinite([
      summary?.max_latency_ms,
      k6MetricValue(summary, ['loadtest_latency', 'http_req_duration'], 'max'),
    ]),
    thresholds_passed: typeof summary?.thresholds_passed === 'boolean' ? summary.thresholds_passed : null,
  };
}

export function k6EndpointMetrics(summary, profile, { durationSeconds = null } = {}) {
  return (profile?.endpointMix ?? []).filter((endpoint) => Number(endpoint?.weight) > 0).map((endpoint) => {
    const entry = normalizedEndpointSummary(summary, endpoint);
    const requests = endpointField(summary, endpoint, ['requests', 'request_count', 'sample_count'], endpointMetricValue(summary, 'loadtest_endpoint_requests', endpoint.name, 'count'));
    let actualRps = endpointField(summary, endpoint, ['actual_rps', 'rps'], endpointMetricValue(summary, 'loadtest_endpoint_requests', endpoint.name, 'rate'));
    if (actualRps === null && requests !== null && Number(durationSeconds) > 0) actualRps = requests / Number(durationSeconds);
    const failedRequests = endpointField(summary, endpoint, ['failed_requests', 'errors'], endpointMetricValue(summary, 'loadtest_errors', endpoint.name, ['count', 'fails']));
    let errorRate = endpointField(summary, endpoint, ['error_rate'], endpointMetricRate(summary, 'loadtest_error_rate', endpoint.name, requests));
    if (errorRate === null && failedRequests !== null && requests !== null && requests > 0) errorRate = failedRequests / requests;
    return {
      endpoint: endpoint.name,
      route: endpoint.route ?? null,
      classification: endpoint.classification ?? null,
      requests,
      actual_rps: actualRps,
      error_rate: errorRate,
      checks_rate: endpointField(summary, endpoint, ['checks_rate', 'check_pass_rate'], endpointMetricRate(summary, 'checks', endpoint.name, requests)),
      p50_ms: endpointField(summary, endpoint, ['p50_ms'], endpointMetricValue(summary, 'loadtest_latency', endpoint.name, ['med', 'p(50)'])),
      p95_ms: endpointField(summary, endpoint, ['p95_ms'], endpointMetricValue(summary, 'loadtest_latency', endpoint.name, 'p(95)')),
      p99_ms: endpointField(summary, endpoint, ['p99_ms'], endpointMetricValue(summary, 'loadtest_latency', endpoint.name, 'p(99)')),
      max_latency_ms: endpointField(summary, endpoint, ['max_latency_ms', 'max_ms'], endpointMetricValue(summary, 'loadtest_latency', endpoint.name, 'max')),
      failed_requests: failedRequests,
      source: entry ? 'runtime-summary' : 'k6-summary',
    };
  });
}

export function safeDiagnosticSummary(value, fallback = 'observability query did not return a usable snapshot') {
  if (value === null || value === undefined || value === '') return fallback;
  const normalized = String(value)
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\b(authorization|cookie|token|password|secret|coupon(?:[_ -]?code)?)\s*[:=]\s*[^\s,;&]+/gi, '$1=[redacted]')
    .replace(/([?&](?:authorization|cookie|token|password|secret|coupon(?:[_-]?code)?)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized ? normalized.slice(0, 240) : fallback;
}

function lastFiniteSeriesValue(series = []) {
  let latest = null;
  for (const item of series) {
    for (const pair of item?.values ?? []) {
      const at = finiteNumber(pair?.[0]);
      const value = finiteNumber(pair?.[1]);
      if (at === null || value === null) continue;
      if (latest === null || at >= latest.at) latest = { at, value };
    }
  }
  return latest?.value ?? null;
}

export function observabilityMetric(snapshot, id) {
  const metric = snapshot?.metrics?.[id];
  if (!metric) {
    return { value: null, status: 'unavailable', reason: `metric ${id} was not returned`, unit: null };
  }
  const value = finiteNumber(metric.value) ?? lastFiniteSeriesValue(metric.series);
  const status = metric.status === 'available' && value !== null ? 'available' : 'unavailable';
  return {
    value: status === 'available' ? value : null,
    status,
    reason: status === 'available' ? null : safeDiagnosticSummary(metric.reason, `metric ${id} is unavailable`),
    unit: metric.unit ?? null,
  };
}

export function finiteMetricValue(value) {
  return finiteNumber(value);
}
