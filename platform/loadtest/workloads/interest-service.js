import {
  buildOptions,
  bearerHeaders,
  createServiceLifecycle,
  jsonData,
  loadAccessTokens,
  loadSharedFixtures,
  readFixture,
  request,
  writeFixture,
} from '../lib/runtime.js';

const profile = JSON.parse(__ENV.LOADTEST_PROFILE_JSON);
const fixtures = loadSharedFixtures(profile, __ENV.LOADTEST_FIXTURE_MANIFEST || '../fixtures/inspect.json');
const tokens = loadAccessTokens(fixtures);
const user = (userId) => bearerHeaders(tokens, userId);

const lifecycle = createServiceLifecycle(profile, fixtures, {
  'interest.list': (context) => {
    const fixture = readFixture(fixtures, 'existingInterests', context.occurrence);
    request(profile, context.endpoint, {
      path: '/v1/users/me/interests',
      query: { limit: 20 },
      headers: user(fixture.userId),
      validate: (response) => Array.isArray(jsonData(response)),
    });
  },
  'interest.ranking-upcoming': (context) => request(profile, context.endpoint, {
    path: '/v1/rankings/drops/upcoming',
    query: { limit: 20 },
    validate: (response) => Array.isArray(jsonData(response)),
  }),
  'interest.ranking-trending': (context) => request(profile, context.endpoint, {
    path: '/v1/rankings/drops/trending',
    query: { limit: 20 },
    validate: (response) => Array.isArray(jsonData(response)),
  }),
  'interest.view': (context) => {
    const fixture = writeFixture(fixtures, 'viewEvents', context.occurrence);
    request(profile, context.endpoint, {
      path: `/v1/drops/${encodeURIComponent(fixture.dropId)}/views`,
      headers: user(fixture.userId),
    });
  },
  'interest.add': (context) => {
    const fixture = writeFixture(fixtures, 'interestAdd', context.occurrence);
    request(profile, context.endpoint, {
      path: `/v1/users/me/interests/${encodeURIComponent(fixture.dropId)}`,
      headers: user(fixture.userId),
      validate: (response) => {
        const data = jsonData(response);
        return data.dropId === fixture.dropId && data.status === 'ACTIVE';
      },
    });
  },
  'interest.remove': (context) => {
    const fixture = writeFixture(fixtures, 'existingInterests', context.occurrence);
    request(profile, context.endpoint, {
      path: `/v1/users/me/interests/${encodeURIComponent(fixture.dropId)}`,
      headers: user(fixture.userId),
    });
  },
});

export const options = buildOptions(profile);
export function setup() { return lifecycle.setup(); }
export default function (data) { lifecycle.run(data); }
export function handleSummary(data) { return lifecycle.handleSummary(data); }
