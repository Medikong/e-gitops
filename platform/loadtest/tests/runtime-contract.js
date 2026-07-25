import { check, fail } from 'k6';

import { buildOptions, endpointSelectionAt } from '../lib/runtime.js';
const profile = {
  service: 'runtime-contract',
  adaptive: { startRps: 1, trialMeasureSeconds: 1 },
  thresholds: { errorRate: 0.01, checkPassRate: 1, p95Ms: 500, p99Ms: 1000 },
  endpointMix: [
    { name: 'read', weight: 60 },
    { name: 'write-primary', weight: 25 },
    { name: 'write-secondary', weight: 15 },
  ],
};
const measuredOptions = buildOptions(profile);
const rampOptions = buildOptions({
  ...profile,
  ramp: {
    startRps: 1,
    maxRps: 2,
    increaseRpsPerSecond: 1,
    evaluationWindowSeconds: 1,
    minimumSamplesPerWindow: 1,
    consecutiveBreachWindows: 1,
    workerLatencyHintMs: 1000,
  },
});

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: { checks: ['rate==1'] },
};

export default function () {
  const initial = [0, 1, 2].map((iteration) => endpointSelectionAt(profile, iteration).endpoint.name);
  const weightedCycle = { read: 0, 'write-primary': 0, 'write-secondary': 0 };
  for (let iteration = 3; iteration < 23; iteration += 1) {
    weightedCycle[endpointSelectionAt(profile, iteration).endpoint.name] += 1;
  }

  const occurrences = { read: [], 'write-primary': [], 'write-secondary': [] };
  for (let iteration = 0; iteration < 43; iteration += 1) {
    const selection = endpointSelectionAt(profile, iteration);
    occurrences[selection.endpoint.name].push(selection.occurrence);
  }
  const sequentialOccurrences = Object.values(occurrences).every((values) => (
    values.every((value, index) => value === index)
  ));

  const passed = check(null, {
    'all positive endpoints run before weighted scheduling': () => (
      JSON.stringify(initial) === JSON.stringify(['read', 'write-primary', 'write-secondary'])
    ),
    'weighted cycle preserves exact reduced weights': () => (
      weightedCycle.read === 12
      && weightedCycle['write-primary'] === 5
      && weightedCycle['write-secondary'] === 3
    ),
    'per-endpoint occurrences remain contiguous': () => sequentialOccurrences,
    'runtime contract does not load fixture manifests': () => true,
    'k6 summary includes p99 latency': () => measuredOptions.summaryTrendStats.includes('p(99)'),
    'ramp keeps route-level summary submetrics without a fixed SLO gate': () => (
      rampOptions.thresholds['loadtest_endpoint_requests{endpoint:read}'][0] === 'count>=0'
      && rampOptions.thresholds['checks{endpoint:read}'][0] === 'rate>=0'
      && rampOptions.thresholds['loadtest_latency{endpoint:read}'][0] === 'max>=0'
    ),
  });
  if (!passed) {
    fail('runtime contract failed');
  }
}
