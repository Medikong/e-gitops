import { group } from 'k6';
import { Rate } from 'k6/metrics';

import { loginAdmin, loginProvider } from '../lib/auth.js';
import { getConfig, requireDatasetCredentials } from '../lib/config.js';
import { logDatasetFinished, logExperimentConditions, logRunFailed, logRunStarted } from '../lib/log.js';
import { summaryOutput } from '../lib/report.js';
import { setupDatasetProfile } from '../flows/dataset.js';

const config = getConfig();
const datasetSetupSuccess = new Rate('loadtest_dataset_setup_success');

export const options = {
  scenarios: {
    [config.scenario]: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: '30m',
      tags: {
        environment: config.environment,
        profile: config.dataset.profile,
        test_type: config.testType,
        phase: 'dataset_setup',
        target: config.target,
      },
    },
  },
  thresholds: {
    checks: ['rate>0.99'],
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<3000'],
    loadtest_dataset_setup_success: ['rate==1'],
  },
  tags: {
    environment: config.environment,
    profile: config.dataset.profile,
    test_type: config.testType,
    phase: 'dataset_setup',
    target: config.target,
  },
};

export default function setupDataset() {
  logExperimentConditions(config, 'dataset_setup');
  logRunStarted(config);
  try {
    requireDatasetCredentials(config);
    const tokens = {};
    group('dataset.auth', () => {
      tokens.provider = loginProvider(config).accessToken;
      tokens.admin = loginAdmin(config).accessToken;
    });
    const state = {};
    group('dataset.setup', () => {
      Object.assign(state, setupDatasetProfile(config, tokens));
    });
    datasetSetupSuccess.add(true);
    logDatasetFinished(config, state);
  } catch (error) {
    datasetSetupSuccess.add(false);
    logRunFailed(config, 'setup_read_dataset', error);
    throw error;
  }
}

export function handleSummary(data) {
  return summaryOutput(config, data);
}
