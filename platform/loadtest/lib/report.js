import { experimentConditionFields, summaryLine } from './log.js';
import { HTTP_STEP_ROUTES, serviceLabel } from './http-metrics.js';

function metricValue(metrics, name, key) {
  const metric = metrics && metrics[name];
  if (!metric || !metric.values || metric.values[key] === undefined) {
    return null;
  }
  return metric.values[key];
}

function metricNameForSummary(config, name) {
  return config.summaryStep ? metricNameWithStep(name, config.summaryStep) : name;
}

function summaryMetricValue(config, metrics, name, key) {
  return metricValue(metrics, metricNameForSummary(config, name), key);
}

function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return 'n/a';
  }
  return Number(value).toFixed(digits);
}

function formatRate(value) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return 'n/a';
  }
  return `${(Number(value) * 100).toFixed(2)}%`;
}

function stepFromMetricName(metricName) {
  const match = metricName.match(/^[^{]+\{step:([^}]+)\}$/);
  return match ? match[1] : null;
}

function stepRequestCount(metrics, step) {
  return metricValue(metrics, metricNameWithStep('http_reqs', step), 'count');
}

function thresholdRows(data) {
  const rows = [];
  const metrics = data.metrics || {};
  for (const [metricName, metric] of Object.entries(metrics)) {
    const step = stepFromMetricName(metricName);
    const requestCount = step === null ? null : stepRequestCount(metrics, step);
    if (step !== null && (requestCount === null || requestCount <= 0)) {
      continue;
    }
    for (const [expression, threshold] of Object.entries(metric.thresholds || {})) {
      rows.push({
        metric: metricName,
        expression,
        ok: threshold.ok === undefined ? null : threshold.ok,
      });
    }
  }
  return rows;
}

function reportStatus(rows) {
  if (rows.some((row) => row.ok === false)) {
    return 'FAIL';
  }
  if (rows.length === 0 || rows.some((row) => row.ok === null)) {
    return 'WARN';
  }
  return 'PASS';
}

function reportSummary(config, data) {
  const metrics = data.metrics || {};
  const thresholds = thresholdRows(data);
  return {
    status: reportStatus(thresholds),
    thresholds,
    http_req_duration_p50_ms: summaryMetricValue(config, metrics, 'http_req_duration', 'med'),
    http_req_duration_p95_ms: summaryMetricValue(config, metrics, 'http_req_duration', 'p(95)'),
    http_req_duration_p99_ms: summaryMetricValue(config, metrics, 'http_req_duration', 'p(99)'),
    http_req_failed_rate: summaryMetricValue(config, metrics, 'http_req_failed', 'rate'),
    checks_pass_rate: summaryMetricValue(config, metrics, 'checks', 'rate'),
    http_reqs_rate: summaryMetricValue(config, metrics, 'http_reqs', 'rate'),
    rps: summaryMetricValue(config, metrics, 'http_reqs', 'rate'),
    iterations_count: metricValue(metrics, 'iterations', 'count'),
    iterations_rate: metricValue(metrics, 'iterations', 'rate'),
  };
}

function metricNameWithStep(name, step) {
  return `${name}{step:${step}}`;
}

function reservationCreateOutcomeMetrics(metrics, step) {
  if (!step.endsWith('.reservation.create')) {
    return {};
  }
  return {
    reservation_create_201_rate: metricValue(metrics, metricNameWithStep('loadtest_reservation_create_201_rate', step), 'rate'),
    reservation_create_201_count: metricValue(metrics, metricNameWithStep('loadtest_reservation_create_201_count', step), 'count'),
    reservation_create_409_rate: metricValue(metrics, metricNameWithStep('loadtest_reservation_create_409_rate', step), 'rate'),
    reservation_create_409_count: metricValue(metrics, metricNameWithStep('loadtest_reservation_create_409_count', step), 'count'),
    reservation_create_5xx_rate: metricValue(metrics, metricNameWithStep('loadtest_reservation_create_5xx_rate', step), 'rate'),
    reservation_create_5xx_count: metricValue(metrics, metricNameWithStep('loadtest_reservation_create_5xx_count', step), 'count'),
    reservation_create_timeout_rate: metricValue(metrics, metricNameWithStep('loadtest_reservation_create_timeout_rate', step), 'rate'),
    reservation_create_timeout_count: metricValue(metrics, metricNameWithStep('loadtest_reservation_create_timeout_count', step), 'count'),
  };
}

function stepsFromMetrics(metrics) {
  const steps = new Set(Object.keys(HTTP_STEP_ROUTES));
  for (const metricName of Object.keys(metrics || {})) {
    const step = stepFromMetricName(metricName);
    if (step !== null) {
      steps.add(step);
    }
  }
  return [...steps];
}

function httpStepRows(data) {
  const metrics = data.metrics || {};
  return stepsFromMetrics(metrics)
    .map((step) => ({
      step,
      route: HTTP_STEP_ROUTES[step] || step,
      service: serviceLabel(step),
      http_req_duration_p50_ms: metricValue(metrics, metricNameWithStep('http_req_duration', step), 'med'),
      http_req_duration_p95_ms: metricValue(metrics, metricNameWithStep('http_req_duration', step), 'p(95)'),
      http_req_duration_p99_ms: metricValue(metrics, metricNameWithStep('http_req_duration', step), 'p(99)'),
      http_req_failed_rate: metricValue(metrics, metricNameWithStep('http_req_failed', step), 'rate'),
      checks_pass_rate: metricValue(metrics, metricNameWithStep('checks', step), 'rate'),
      http_reqs_count: metricValue(metrics, metricNameWithStep('http_reqs', step), 'count'),
      http_reqs_rate: metricValue(metrics, metricNameWithStep('http_reqs', step), 'rate'),
      rps: metricValue(metrics, metricNameWithStep('http_reqs', step), 'rate'),
      ...reservationCreateOutcomeMetrics(metrics, step),
    }))
    .filter((row) => row.http_reqs_count > 0);
}

function markdownHttpStepRows(rows) {
  if (rows.length === 0) {
    return ['No step-level HTTP metrics captured.'];
  }
  return [
    '| step | service | route | p50 | p95 | p99 | error rate | checks | requests | RPS |',
    '|---|---|---|---:|---:|---:|---:|---:|---:|---:|',
    ...rows.map((row) => [
      row.step,
      row.service,
      row.route,
      `${formatNumber(row.http_req_duration_p50_ms)} ms`,
      `${formatNumber(row.http_req_duration_p95_ms)} ms`,
      `${formatNumber(row.http_req_duration_p99_ms)} ms`,
      formatRate(row.http_req_failed_rate),
      formatRate(row.checks_pass_rate),
      formatNumber(row.http_reqs_count, 0),
      formatNumber(row.http_reqs_rate),
    ].join(' | ')).map((line) => `| ${line} |`),
  ];
}

function apiStepResults(rows) {
  return rows.map((row) => ({
    step: row.step,
    service: row.service,
    route: row.route,
    http_req_duration_p50_ms: row.http_req_duration_p50_ms,
    http_req_duration_p95_ms: row.http_req_duration_p95_ms,
    http_req_duration_p99_ms: row.http_req_duration_p99_ms,
    http_req_failed_rate: row.http_req_failed_rate,
    http_reqs_rate: row.http_reqs_rate,
    rps: row.rps,
    http_reqs_count: row.http_reqs_count,
    reservation_create_201_rate: row.reservation_create_201_rate,
    reservation_create_201_count: row.reservation_create_201_count,
    reservation_create_409_rate: row.reservation_create_409_rate,
    reservation_create_409_count: row.reservation_create_409_count,
    reservation_create_5xx_rate: row.reservation_create_5xx_rate,
    reservation_create_5xx_count: row.reservation_create_5xx_count,
    reservation_create_timeout_rate: row.reservation_create_timeout_rate,
    reservation_create_timeout_count: row.reservation_create_timeout_count,
  }));
}

function metadata(config) {
  return {
    run_id: config.runId,
    scenario: config.scenario,
    environment: config.environment,
    base_url: config.baseUrl,
    vus: config.vus,
    duration: config.duration,
    git_sha: config.gitSha,
    started_at: config.startedAt,
    finished_at: new Date().toISOString(),
  };
}

function markdownReport(config, data) {
  const meta = metadata(config);
  const result = reportSummary(config, data);
  const stepRows = httpStepRows(data);
  const thresholdLines = result.thresholds.length === 0
    ? ['- WARN n/a']
    : result.thresholds.map((row) => {
      const status = row.ok === false ? 'FAIL' : row.ok === null ? 'WARN' : 'PASS';
      return `- ${status} ${row.metric} ${row.expression}`;
    });

  return [
    `# Loadtest Report: ${meta.run_id}`,
    '',
    `Status: ${result.status}`,
    '',
    '## Metadata',
    '',
    `- scenario: ${meta.scenario}`,
    `- environment: ${meta.environment}`,
    `- base_url: ${meta.base_url}`,
    `- vus: ${meta.vus}`,
    `- duration: ${meta.duration}`,
    `- git_sha: ${meta.git_sha}`,
    `- started_at: ${meta.started_at}`,
    `- finished_at: ${meta.finished_at}`,
    '',
    '## Quick Metrics',
    '',
    `- p50 latency: ${formatNumber(result.http_req_duration_p50_ms)} ms`,
    `- p95 latency: ${formatNumber(result.http_req_duration_p95_ms)} ms`,
    `- p99 latency: ${formatNumber(result.http_req_duration_p99_ms)} ms`,
    `- error rate: ${formatRate(result.http_req_failed_rate)}`,
    `- checks pass rate: ${formatRate(result.checks_pass_rate)}`,
    `- RPS: ${formatNumber(result.http_reqs_rate)}`,
    `- iterations: ${formatNumber(result.iterations_count, 0)} (${formatNumber(result.iterations_rate)}/s)`,
    '',
    '## HTTP Metrics By Step',
    '',
    ...markdownHttpStepRows(stepRows),
    '',
    '## Thresholds',
    '',
    ...thresholdLines,
    '',
  ].join('\n');
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function htmlReport(config, data) {
  const meta = metadata(config);
  const result = reportSummary(config, data);
  const stepRows = httpStepRows(data);
  const stepRowsHtml = stepRows.map((row) => `<tr><td>${escapeHtml(row.step)}</td><td>${escapeHtml(row.service)}</td><td>${escapeHtml(row.route)}</td><td>${escapeHtml(formatNumber(row.http_req_duration_p50_ms))} ms</td><td>${escapeHtml(formatNumber(row.http_req_duration_p95_ms))} ms</td><td>${escapeHtml(formatNumber(row.http_req_duration_p99_ms))} ms</td><td>${escapeHtml(formatRate(row.http_req_failed_rate))}</td><td>${escapeHtml(formatRate(row.checks_pass_rate))}</td><td>${escapeHtml(formatNumber(row.http_reqs_count, 0))}</td><td>${escapeHtml(formatNumber(row.http_reqs_rate))}</td></tr>`).join('');
  const thresholdRowsHtml = result.thresholds.map((row) => {
    const status = row.ok === false ? 'FAIL' : row.ok === null ? 'WARN' : 'PASS';
    return `<tr><td>${escapeHtml(row.metric)}</td><td>${escapeHtml(row.expression)}</td><td>${status}</td></tr>`;
  }).join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Loadtest Report ${escapeHtml(meta.run_id)}</title>
  <style>
    body { color: #202124; font-family: ui-sans-serif, system-ui, sans-serif; margin: 40px; max-width: 960px; }
    h1, h2 { margin-bottom: 8px; }
    .status { display: inline-block; font-weight: 700; padding: 6px 10px; border: 1px solid #202124; }
    dl { display: grid; grid-template-columns: 160px 1fr; gap: 6px 14px; }
    dt { color: #5f6368; }
    dd { margin: 0; }
    table { border-collapse: collapse; margin-top: 12px; width: 100%; }
    th, td { border-bottom: 1px solid #dadce0; padding: 8px; text-align: left; }
  </style>
</head>
<body>
  <h1>Loadtest Report</h1>
  <p class="status">${escapeHtml(result.status)}</p>
  <h2>Metadata</h2>
  <dl>
    <dt>run_id</dt><dd>${escapeHtml(meta.run_id)}</dd>
    <dt>scenario</dt><dd>${escapeHtml(meta.scenario)}</dd>
    <dt>environment</dt><dd>${escapeHtml(meta.environment)}</dd>
    <dt>base_url</dt><dd>${escapeHtml(meta.base_url)}</dd>
    <dt>vus</dt><dd>${escapeHtml(meta.vus)}</dd>
    <dt>duration</dt><dd>${escapeHtml(meta.duration)}</dd>
    <dt>git_sha</dt><dd>${escapeHtml(meta.git_sha)}</dd>
    <dt>started_at</dt><dd>${escapeHtml(meta.started_at)}</dd>
    <dt>finished_at</dt><dd>${escapeHtml(meta.finished_at)}</dd>
  </dl>
  <h2>Quick Metrics</h2>
  <dl>
    <dt>p50 latency</dt><dd>${escapeHtml(formatNumber(result.http_req_duration_p50_ms))} ms</dd>
    <dt>p95 latency</dt><dd>${escapeHtml(formatNumber(result.http_req_duration_p95_ms))} ms</dd>
    <dt>p99 latency</dt><dd>${escapeHtml(formatNumber(result.http_req_duration_p99_ms))} ms</dd>
    <dt>error rate</dt><dd>${escapeHtml(formatRate(result.http_req_failed_rate))}</dd>
    <dt>checks pass rate</dt><dd>${escapeHtml(formatRate(result.checks_pass_rate))}</dd>
    <dt>RPS</dt><dd>${escapeHtml(formatNumber(result.http_reqs_rate))}</dd>
    <dt>iterations</dt><dd>${escapeHtml(formatNumber(result.iterations_count, 0))} (${escapeHtml(formatNumber(result.iterations_rate))}/s)</dd>
  </dl>
  <h2>HTTP Metrics By Step</h2>
  <table>
    <thead><tr><th>Step</th><th>Service</th><th>Route</th><th>p50</th><th>p95</th><th>p99</th><th>Error rate</th><th>Checks</th><th>Requests</th><th>RPS</th></tr></thead>
    <tbody>${stepRowsHtml || '<tr><td colspan="10">No step-level HTTP metrics captured.</td></tr>'}</tbody>
  </table>
  <h2>Thresholds</h2>
  <table>
    <thead><tr><th>Metric</th><th>Threshold</th><th>Status</th></tr></thead>
    <tbody>${thresholdRowsHtml || '<tr><td colspan="3">WARN n/a</td></tr>'}</tbody>
  </table>
</body>
</html>
`;
}

function runReportLine(config, data, result, stepRows) {
  return JSON.stringify({
    event: 'loadtest_run_report',
    timestamp: new Date().toISOString(),
    test_type: 'loadtest',
    loadtest_run_id: config.runId,
    scenario: config.scenario,
    environment: config.environment,
    target: config.target,
    target_base_url: config.baseUrl,
    status: result.status,
    http_req_duration_p50_ms: result.http_req_duration_p50_ms,
    http_req_duration_p95_ms: result.http_req_duration_p95_ms,
    http_req_duration_p99_ms: result.http_req_duration_p99_ms,
    http_req_failed_rate: result.http_req_failed_rate,
    http_reqs_rate: result.http_reqs_rate,
    rps: result.rps,
    iterations_count: result.iterations_count,
    iterations_rate: result.iterations_rate,
    reservation_handled_rate: metricValue(data.metrics || {}, 'loadtest_reservation_handled_rate', 'rate'),
    reservation_created_rate: metricValue(data.metrics || {}, 'loadtest_reservation_created_rate', 'rate'),
    reservation_infra_failure_rate: metricValue(data.metrics || {}, 'loadtest_reservation_infra_failure_rate', 'rate'),
    execution_conditions: experimentConditionFields(config, 'summary'),
    api_step_results: apiStepResults(stepRows),
  });
}

export function summaryOutput(config, data) {
  const result = reportSummary(config, data);
  const stepRows = httpStepRows(data);
  const stdoutLines = [
    runReportLine(config, data, result, stepRows),
    summaryLine(config, data),
  ];
  const output = {
    stdout: `${stdoutLines.join('\n')}\n`,
  };
  if (!config.reportDir) {
    return output;
  }
  return {
    ...output,
    [`${config.reportDir}/metadata.json`]: JSON.stringify(metadata(config), null, 2),
    [`${config.reportDir}/summary.json`]: JSON.stringify(data, null, 2),
    [`${config.reportDir}/report.md`]: markdownReport(config, data),
    [`${config.reportDir}/report.html`]: htmlReport(config, data),
  };
}
