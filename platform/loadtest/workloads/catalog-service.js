import {
  buildOptions,
  createServiceLifecycle,
  jsonData,
  loadSharedFixtures,
  readFixture,
  request,
} from '../lib/runtime.js';

const profile = JSON.parse(__ENV.LOADTEST_PROFILE_JSON);
const fixtures = loadSharedFixtures(profile, __ENV.LOADTEST_FIXTURE_MANIFEST || '../fixtures/inspect.json');

const lifecycle = createServiceLifecycle(profile, fixtures, {
  'catalog.drop-list': (context) => request(profile, context.endpoint, {
    path: '/drops',
    query: { limit: 20 },
    validate: (response) => Array.isArray(jsonData(response)),
  }),
  'catalog.drop-detail': (context) => {
    const fixture = readFixture(fixtures, 'drops', context.occurrence);
    request(profile, context.endpoint, {
      path: `/drops/${encodeURIComponent(fixture.dropId)}`,
      validate: (response) => {
        const data = jsonData(response);
        return data && data.id === fixture.dropId && Array.isArray(data.products);
      },
    });
  },
});

export const options = buildOptions(profile);
export function setup() { return lifecycle.setup(); }
export default function (data) { lifecycle.run(data); }
export function handleSummary(data) { return lifecycle.handleSummary(data); }
