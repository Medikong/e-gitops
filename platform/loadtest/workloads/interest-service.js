import {
  buildOptions,
  bearerHeaders,
  bootstrapAccessTokens,
  createServiceLifecycle,
  jsonData,
  request,
  runtimeAddressing,
  writeIndex,
} from '../lib/runtime.js';

const profile = JSON.parse(__ENV.LOADTEST_PROFILE_JSON);
const addresses = runtimeAddressing(profile);
const user = (setupData, userId) => bearerHeaders(setupData, userId);

const lifecycle = createServiceLifecycle(profile, addresses, {
  setup: () => bootstrapAccessTokens(profile, addresses),
  'interest.list': (context) => {
    const fixture = addresses.existingInterest(context.occurrence);
    request(profile, context.endpoint, {
      path: '/v1/users/me/interests',
      query: { limit: 20 },
      headers: user(context.setupData, fixture.userId),
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
    const fixture = addresses.viewEvent(writeIndex('viewEvents', context.occurrence));
    request(profile, context.endpoint, {
      path: `/v1/drops/${encodeURIComponent(fixture.dropId)}/views`,
      headers: user(context.setupData, fixture.userId),
    });
  },
  'interest.add': (context) => {
    const fixture = addresses.newInterest(writeIndex('interestAdd', context.occurrence));
    request(profile, context.endpoint, {
      path: `/v1/users/me/interests/${encodeURIComponent(fixture.dropId)}`,
      headers: user(context.setupData, fixture.userId),
      validate: (response) => {
        const data = jsonData(response);
        return data.dropId === fixture.dropId && data.status === 'active';
      },
    });
  },
  'interest.remove': (context) => {
    const fixture = addresses.existingInterest(writeIndex('existingInterests', context.occurrence));
    request(profile, context.endpoint, {
      path: `/v1/users/me/interests/${encodeURIComponent(fixture.dropId)}`,
      headers: user(context.setupData, fixture.userId),
    });
  },
});

export const options = buildOptions(profile);
export function setup() { return lifecycle.setup(); }
export default function (data) { lifecycle.run(data); }
export function handleSummary(data) { return lifecycle.handleSummary(data); }
