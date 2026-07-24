import {
  buildOptions,
  bearerHeaders,
  createServiceLifecycle,
  jsonData,
  loadAccessTokens,
  loadSharedFixtures,
  readFixture,
  request,
} from '../lib/runtime.js';

const profile = JSON.parse(__ENV.LOADTEST_PROFILE_JSON);
const fixtures = loadSharedFixtures(profile, __ENV.LOADTEST_FIXTURE_MANIFEST || '../fixtures/inspect.json');
const tokens = loadAccessTokens(fixtures);

const lifecycle = createServiceLifecycle(profile, fixtures, {
  'notification.list': (context) => {
    const fixture = readFixture(fixtures, 'notificationRead', context.occurrence);
    request(profile, context.endpoint, {
      path: '/notifications',
      query: { limit: 20 },
      headers: bearerHeaders(tokens, fixture.userId),
      validate: (response) => Array.isArray(jsonData(response)),
    });
  },
});

export const options = buildOptions(profile);
export function setup() { return lifecycle.setup(); }
export default function (data) { lifecycle.run(data); }
export function handleSummary(data) { return lifecycle.handleSummary(data); }
