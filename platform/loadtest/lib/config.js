import { getCommonConfig } from './config/common.js';
import { getDatasetConfig } from './config/dataset.js';
import { getAuthLoginConfig } from './config/scenarios/auth-login.js';
import { getReadApiBaselineConfig } from './config/scenarios/read-api-baseline.js';
import { getReservationCreateConfig, getReservationSeatContentionConfig } from './config/scenarios/reservation-load.js';
import { getReservationJourneyConfig } from './config/scenarios/reservation-journey.js';
import { getTicketServiceReadConfig } from './config/scenarios/ticket-service-read.js';

function scenarioConfig(scenario) {
  if (scenario === 'setup-read-dataset') {
    return getDatasetConfig();
  }
  if (scenario === 'read-api-baseline') {
    return getReadApiBaselineConfig();
  }
  if (scenario === 'reservation-journey-load-test') {
    return getReservationJourneyConfig();
  }
  if (scenario === 'reservation-create-load-test') {
    return getReservationCreateConfig();
  }
  if (scenario === 'reservation-seat-contention-load-test') {
    return getReservationSeatContentionConfig();
  }
  if (scenario === 'auth-login-load-test') {
    return getAuthLoginConfig();
  }
  if (scenario === 'ticket-service-read-load-test') {
    return getTicketServiceReadConfig();
  }
  throw new Error(`unsupported LOADTEST_SCENARIO=${scenario}`);
}

export function getConfig() {
  const common = getCommonConfig();
  const dataset = getDatasetConfig();
  const scenario = scenarioConfig(common.scenario);
  const requestIdBase = `${scenario.requestPrefix}-${common.scenario}-${common.runId}`;

  return {
    ...common,
    ...scenario,
    dataset: dataset.dataset,
    customerPool: dataset.customerPool,
    requestIdBase,
  };
}

export function requireCustomerPool(config) {
  if (!config.customerPool.password) {
    throw new Error('LOADTEST_CUSTOMER_POOL_PASSWORD required for customer-pool loadtest');
  }
  if (config.activeCustomerCount && config.customerPool.size < config.activeCustomerCount) {
    throw new Error('LOADTEST_CUSTOMER_POOL_SIZE must be greater than or equal to the scenario active customer count');
  }
}

export function requireDatasetCredentials(config) {
  const missing = [
    ['LOADTEST_PROVIDER_EMAIL', config.dataset.providerEmail],
    ['LOADTEST_PROVIDER_PASSWORD', config.dataset.providerPassword],
    ['LOADTEST_ADMIN_EMAIL', config.dataset.adminEmail],
    ['LOADTEST_ADMIN_PASSWORD', config.dataset.adminPassword],
  ].filter(([, value]) => !value).map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(`${missing.join(', ')} required for loadtest dataset setup`);
  }
}
