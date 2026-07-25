import {
  buildOptions,
  bearerHeaders,
  bootstrapAccessTokens,
  createServiceLifecycle,
  jsonData,
  request,
  runtimeAddressing,
  uniqueKey,
  writeIndex,
} from '../lib/runtime.js';

const profile = JSON.parse(__ENV.LOADTEST_PROFILE_JSON);
const addresses = runtimeAddressing(profile);

function headers(setupData, userId, occurrence, mutation = false) {
  return {
    ...bearerHeaders(setupData, userId),
    ...(mutation ? {
      Origin: 'https://user.dropmong.internal',
      'Idempotency-Key': uniqueKey('profile-patch', occurrence),
    } : {}),
  };
}

const lifecycle = createServiceLifecycle(profile, addresses, {
  setup: () => bootstrapAccessTokens(profile, addresses),
  'user.profile-read': (context) => {
    const userId = addresses.profileUser(context.occurrence);
    request(profile, context.endpoint, {
      path: '/api/v1/users/me/profile',
      headers: headers(context.setupData, userId, context.occurrence),
      validate: (response) => Boolean(jsonData(response).userId),
    });
  },
  'user.profile-update': (context) => {
    const userId = addresses.profileUser(writeIndex('profileWrite', context.occurrence));
    request(profile, context.endpoint, {
      path: '/api/v1/users/me/profile',
      headers: headers(context.setupData, userId, context.occurrence, true),
      body: {
        expectedUserVersion: 1,
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
