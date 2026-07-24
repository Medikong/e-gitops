import { check, fail } from 'k6';

import { buildOptions, endpointSelectionAt, parseJsonFixture } from '../lib/runtime.js';

const fixtures = parseJsonFixture(open('../fixtures/inspect.json'));
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
  const trialSlices = fixtures.allocation && fixtures.allocation.trialSlices;
  const sliceShapeMatchesSeeder = trialSlices && Object.values(trialSlices).every((slices) => (
    Array.isArray(slices) && slices.every((slice) => (
      slice.endExclusive - slice.start === slice.count
    ))
  ));
  const couponReference = fixtures.pools.couponRedeem[0];

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
    'inspect trialSlices match pool-to-list seeder contract': () => sliceShapeMatchesSeeder,
    'coupon fixture contains only a Secret file reference': () => (
      Object.keys(couponReference).sort().join(',') === 'codeRef,userId'
      && couponReference.codeRef.startsWith('secretFileRef:')
    ),
    'k6 summary includes p99 latency': () => measuredOptions.summaryTrendStats.includes('p(99)'),
  });
  if (!passed) {
    fail('runtime contract failed');
  }
}
