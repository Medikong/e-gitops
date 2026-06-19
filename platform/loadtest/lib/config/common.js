import { optional, parseStringArray, required } from './env.js';

function baseUrlForTarget(target) {
  if (target === 'local') {
    return optional('LOADTEST_LOCAL_BASE_URL', required('LOADTEST_BASE_URL'));
  }
  if (target === 'aws') {
    return optional('LOADTEST_AWS_BASE_URL', required('LOADTEST_BASE_URL'));
  }
  return required('LOADTEST_BASE_URL');
}

function optionalPositiveNumber(name) {
  const raw = optional(name);
  if (!raw) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

function optionalPositiveInteger(name) {
  const value = optionalPositiveNumber(name);
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be an integer`);
  }
  return value;
}

function getTrafficModelConfig() {
  return {
    preset: optional('LOADTEST_TRAFFIC_MODEL_PRESET') || undefined,
    mau: optionalPositiveInteger('LOADTEST_TRAFFIC_MODEL_MAU'),
    stickiness: optionalPositiveNumber('LOADTEST_TRAFFIC_MODEL_STICKINESS'),
    peakParticipationRate: optionalPositiveNumber('LOADTEST_TRAFFIC_MODEL_PEAK_PARTICIPATION_RATE'),
    peakWindowMinutes: optionalPositiveNumber('LOADTEST_TRAFFIC_MODEL_PEAK_WINDOW_MINUTES'),
    journeysPerUser: optionalPositiveNumber('LOADTEST_TRAFFIC_MODEL_JOURNEYS_PER_USER'),
    safetyFactor: optionalPositiveNumber('LOADTEST_TRAFFIC_MODEL_SAFETY_FACTOR'),
    targetTicketsPerCustomer: optionalPositiveInteger('LOADTEST_TRAFFIC_MODEL_TARGET_TICKETS_PER_CUSTOMER'),
    calculatedJourneyRate: optionalPositiveNumber('LOADTEST_TRAFFIC_MODEL_CALCULATED_JOURNEY_RATE'),
    expectedJourneys: optionalPositiveInteger('LOADTEST_TRAFFIC_MODEL_EXPECTED_JOURNEYS'),
  };
}

export function getCommonConfig() {
  const target = optional('LOADTEST_TARGET', 'local');
  const scenario = optional('LOADTEST_SCENARIO', 'read-api-baseline');
  const environment = optional('LOADTEST_ENVIRONMENT', target);
  const runId = optional('LOADTEST_RUN_ID', `${Date.now()}`);
  const imageTag = optional('LOADTEST_IMAGE_TAG', 'unknown');
  const k6Output = optional('K6_OUTPUT');
  const k6ExtraArgs = parseStringArray('LOADTEST_K6_EXTRA_ARGS');
  const k6ScenarioFile = `/loadtest/scenarios/${scenario}.js`;
  const k6CommandArgs = [
    'run',
    '--log-format=raw',
    ...(k6Output ? ['--out', k6Output] : []),
    ...k6ExtraArgs,
    k6ScenarioFile,
  ];

  return {
    testType: optional('LOADTEST_TEST_TYPE', 'loadtest'),
    scenario,
    environment,
    target,
    runId,
    baseUrl: baseUrlForTarget(target).replace(/\/+$/, ''),
    gitSha: optional('LOADTEST_GIT_SHA', 'unknown'),
    startedAt: optional('LOADTEST_STARTED_AT', new Date().toISOString()),
    reportDir: optional('LOADTEST_REPORT_DIR'),
    revision: optional('LOADTEST_REVISION', imageTag),
    image: optional('LOADTEST_IMAGE'),
    imageTag,
    release: optional('LOADTEST_RELEASE'),
    namespace: optional('LOADTEST_NAMESPACE'),
    trafficModel: getTrafficModelConfig(),
    k6Output,
    k6ExtraArgs,
    k6ScenarioFile,
    k6Command: 'k6',
    k6CommandArgs,
  };
}
