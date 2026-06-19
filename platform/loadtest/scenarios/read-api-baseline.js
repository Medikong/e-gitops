import { group, sleep } from 'k6';
import { Rate } from 'k6/metrics';

import { getConfig } from '../lib/config.js';
import { getJson } from '../lib/http.js';
import { httpStepThresholds, READ_API_STEPS } from '../lib/http-metrics.js';
import {
  logExperimentConditions,
  logRunFailed,
  logRunFinished,
  logRunStarted,
} from '../lib/log.js';
import { itemsFrom, pickByIteration, requireField } from '../lib/pick.js';
import { summaryOutput } from '../lib/report.js';

const config = getConfig();
const readIterationSuccess = new Rate('loadtest_read_iteration_success');

function iterationConfig() {
  const iterationId = `${Date.now()}-${__VU}-${__ITER}`;
  return {
    ...config,
    iterationId,
    requestIdBase: `${config.requestPrefix}-${config.scenario}-${iterationId}`,
  };
}

function pauseBetweenReadIterations(runConfig) {
  if (runConfig.thinkTimeSeconds > 0) {
    sleep(runConfig.thinkTimeSeconds);
  }
}

function executorConfig() {
  if (config.stages.length > 0) {
    return {
      executor: 'ramping-vus',
      stages: config.stages,
      gracefulStop: config.gracefulStop,
    };
  }
  return {
    executor: 'constant-vus',
    vus: config.vus,
    duration: config.duration,
    gracefulStop: config.gracefulStop,
  };
}

export const options = {
  scenarios: {
    [config.scenario]: {
      ...executorConfig(),
      tags: {
        environment: config.environment,
        profile: config.dataset.profile,
        test_type: config.testType,
        target: config.target,
      },
    },
  },
  thresholds: {
    http_req_failed: [`rate<${config.thresholds.httpReqFailedRate}`],
    http_req_duration: [
      `p(95)<${config.thresholds.httpReqDurationP95Ms}`,
      `p(99)<${config.thresholds.httpReqDurationP99Ms}`,
    ],
    checks: [`rate>${config.thresholds.checksRate}`],
    loadtest_read_iteration_success: [`rate>${config.thresholds.checksRate}`],
    ...httpStepThresholds(READ_API_STEPS, config.thresholds),
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  tags: {
    environment: config.environment,
    profile: config.dataset.profile,
    test_type: config.testType,
    target: config.target,
  },
};

export function setup() {
  logExperimentConditions(config, 'read_baseline');
  return {};
}

export default function readApiBaseline() {
  const runConfig = iterationConfig();
  const state = {};
  logRunStarted(runConfig);

  try {
    group('GET /concerts', () => {
      const concertsBody = getJson(runConfig, 'read_api.concerts', '/concerts', { limit: runConfig.concertLimit });
      const concerts = itemsFrom(concertsBody, 'read_api.concerts');
      const concert = pickByIteration(concerts, 'read_api.concerts');
      state.concertId = requireField(concert, 'id', 'read_api.concerts');
    });

    group('GET /concerts/{id}/performances', () => {
      const performancesBody = getJson(
        runConfig,
        'read_api.performances',
        `/concerts/${encodeURIComponent(state.concertId)}/performances`,
        { limit: runConfig.performanceLimit },
      );
      const performances = itemsFrom(performancesBody, 'read_api.performances');
      const performance = pickByIteration(performances, 'read_api.performances');
      state.performanceId = requireField(performance, 'id', 'read_api.performances');
    });

    group('GET /performances/{id}/seats', () => {
      const seatsBody = getJson(
        runConfig,
        'read_api.seats',
        `/performances/${encodeURIComponent(state.performanceId)}/seats`,
        { limit: runConfig.seatLimit },
      );
      const seats = itemsFrom(seatsBody, 'read_api.seats');
      state.seatCount = seats.length;
    });

    readIterationSuccess.add(true);
    logRunFinished(runConfig, state);
  } catch (error) {
    readIterationSuccess.add(false);
    logRunFailed(runConfig, 'read_api_baseline', error, state);
    throw error;
  } finally {
    pauseBetweenReadIterations(runConfig);
  }
}

export function handleSummary(data) {
  return summaryOutput(config, data);
}
