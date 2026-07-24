import {
  buildOptions,
  bearerHeaders,
  createServiceLifecycle,
  jsonData,
  loadAccessTokens,
  loadSharedFixtures,
  readFixture,
  request,
  uniqueKey,
  writeFixture,
} from '../lib/runtime.js';

const profile = JSON.parse(__ENV.LOADTEST_PROFILE_JSON);
const fixtures = loadSharedFixtures(profile, __ENV.LOADTEST_FIXTURE_MANIFEST || '../fixtures/inspect.json');
const tokens = loadAccessTokens(fixtures);

function headers(userId, occurrence, mutation = false) {
  return {
    ...bearerHeaders(tokens, userId),
    ...(mutation ? {
      Origin: 'https://user.dropmong.internal',
      'Idempotency-Key': uniqueKey('profile-patch', occurrence),
    } : {}),
  };
}

const lifecycle = createServiceLifecycle(profile, fixtures, {
  'user.profile-read': (context) => {
    const fixture = readFixture(fixtures, 'profileRead', context.occurrence);
    request(profile, context.endpoint, {
      path: '/api/v1/users/me/profile',
      headers: headers(fixture.userId, context.occurrence),
      validate: (response) => Boolean(jsonData(response).userId),
    });
  },
  'user.profile-update': (context) => {
    const fixture = writeFixture(fixtures, 'profileWrite', context.occurrence);
    request(profile, context.endpoint, {
      path: '/api/v1/users/me/profile',
      headers: headers(fixture.userId, context.occurrence, true),
      body: {
        expectedUserVersion: fixture.version,
        nickname: `load-${context.occurrence}`.slice(0, 30),
        introduction: `DropMong loadtest ${context.occurrence}`,
      },
      validate: (response) => Boolean(jsonData(response)),
    });
  },
});

export const options = buildOptions(profile);
export function setup() { return lifecycle.setup(); }
export default function (data) { lifecycle.run(data); }
export function handleSummary(data) { return lifecycle.handleSummary(data); }
