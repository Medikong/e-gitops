import { check } from 'k6';

import { summaryOutput } from '../lib/report.js';

function numberEnv(name, fallback) {
  const raw = __ENV[name] === undefined || __ENV[name] === '' ? fallback : __ENV[name];
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a number, got ${raw}`);
  }
  return value;
}

const config = {
  runId: __ENV.LOADTEST_RUN_ID || `local-${Date.now()}`,
  scenario: 'report-smoke',
  environment: __ENV.LOADTEST_ENVIRONMENT || 'local',
  target: __ENV.LOADTEST_TARGET || 'local',
  baseUrl: (__ENV.LOADTEST_BASE_URL || 'http://127.0.0.1').replace(/\/+$/, ''),
  vus: numberEnv('LOADTEST_VUS', 1),
  duration: __ENV.LOADTEST_DURATION || '1s',
  gitSha: __ENV.LOADTEST_GIT_SHA || 'unknown',
  startedAt: __ENV.LOADTEST_STARTED_AT || new Date().toISOString(),
  reportDir: __ENV.LOADTEST_REPORT_DIR || '',
};

export const options = {
  scenarios: {
    'report-smoke': {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: '5s',
      tags: {
        environment: config.environment,
        test_type: 'loadtest',
        target: config.target,
      },
    },
  },
  thresholds: {
    checks: ['rate>=1'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  tags: {
    environment: config.environment,
    test_type: 'loadtest',
    target: config.target,
  },
};

export default function reportSmoke() {
  check(null, {
    'report smoke executes': () => true,
  });
}

export function handleSummary(data) {
  return summaryOutput(config, data);
}
