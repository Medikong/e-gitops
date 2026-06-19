import {
  nonNegativeInteger,
  nonNegativeNumber,
  optional,
  positiveInteger,
  positiveNumber,
  rate,
} from './env.js';

export function getDatasetConfig() {
  const revision = optional('LOADTEST_DATASET_REVISION', 'v1');
  const seatSections = positiveInteger('LOADTEST_DATASET_SEAT_SECTIONS', 1);
  const seatRows = positiveInteger('LOADTEST_DATASET_SEAT_ROWS', 10);
  const seatsPerRow = positiveInteger('LOADTEST_DATASET_SEATS_PER_ROW', 30);

  return {
    requestPrefix: optional('LOADTEST_DATASET_REQUEST_PREFIX', 'loadtest-dataset'),
    requestIdBase: '',
    timeoutSeconds: positiveNumber('LOADTEST_DATASET_TIMEOUT_SECONDS', 15),
    vus: 1,
    plannedMaxVus: 1,
    duration: '1 iteration',
    stages: [],
    gracefulStop: '0s',
    thinkTimeSeconds: 0,
    pollSeconds: 0,
    pollIntervalSeconds: 0,
    paymentAmount: 0,
    maxSeatAttempts: 1,
    concertLimit: positiveInteger('LOADTEST_DATASET_DISCOVERY_LIMIT', 200),
    performanceLimit: positiveInteger('LOADTEST_DATASET_PERFORMANCE_LIMIT', 50),
    seatLimit: seatSections * seatRows * seatsPerRow,
    thresholds: {
      httpReqFailedRate: rate('LOADTEST_DATASET_THRESHOLD_HTTP_REQ_FAILED_RATE', 0.01),
      httpReqDurationP95Ms: positiveNumber('LOADTEST_DATASET_THRESHOLD_HTTP_REQ_DURATION_P95_MS', 3000),
      httpReqDurationP99Ms: positiveNumber('LOADTEST_DATASET_THRESHOLD_HTTP_REQ_DURATION_P99_MS', 5000),
      checksRate: rate('LOADTEST_DATASET_THRESHOLD_CHECKS_RATE', 0.99),
    },
    customerPool: {
      size: positiveInteger('LOADTEST_CUSTOMER_POOL_SIZE', 100),
      emailPrefix: optional('LOADTEST_CUSTOMER_POOL_EMAIL_PREFIX', 'loadtest'),
      emailDomain: optional('LOADTEST_CUSTOMER_POOL_EMAIL_DOMAIN', 'loadtest.medikong.local'),
      password: optional('LOADTEST_CUSTOMER_POOL_PASSWORD', 'loadtest1234'),
      revision: optional('LOADTEST_CUSTOMER_POOL_REVISION', revision),
      displayNamePrefix: optional('LOADTEST_CUSTOMER_POOL_DISPLAY_NAME_PREFIX', 'Loadtest Customer'),
      padWidth: positiveInteger('LOADTEST_CUSTOMER_POOL_PAD_WIDTH', 6),
    },
    dataset: {
      profile: optional('LOADTEST_DATASET_PROFILE', 'read-api-basic'),
      revision,
      titlePrefix: optional('LOADTEST_DATASET_TITLE_PREFIX', 'Medikong Loadtest'),
      venuePrefix: optional('LOADTEST_DATASET_VENUE_PREFIX', 'Loadtest Hall'),
      concerts: positiveInteger('LOADTEST_DATASET_CONCERTS', 20),
      performancesPerConcert: positiveInteger('LOADTEST_DATASET_PERFORMANCES_PER_CONCERT', 2),
      seatSections,
      seatRows,
      seatsPerRow,
      lookaheadDays: nonNegativeInteger('LOADTEST_DATASET_LOOKAHEAD_DAYS', 14),
      startsAtSpacingMinutes: positiveInteger('LOADTEST_DATASET_STARTS_AT_SPACING_MINUTES', 180),
      discoveryLimit: positiveInteger('LOADTEST_DATASET_DISCOVERY_LIMIT', 200),
      createPauseSeconds: nonNegativeNumber('LOADTEST_DATASET_CREATE_PAUSE_SECONDS', 0),
      providerEmail: optional('LOADTEST_PROVIDER_EMAIL'),
      providerPassword: optional('LOADTEST_PROVIDER_PASSWORD'),
      adminEmail: optional('LOADTEST_ADMIN_EMAIL'),
      adminPassword: optional('LOADTEST_ADMIN_PASSWORD'),
    },
  };
}
