import {
  buildOptions,
  bearerHeaders,
  buildAuthTokenPlan,
  bootstrapAccessTokens,
  createServiceLifecycle,
  jsonData,
  request,
  runtimeAddressing,
} from '../lib/runtime.js';

const profile = JSON.parse(__ENV.LOADTEST_PROFILE_JSON);
const addresses = runtimeAddressing(profile);

const lifecycle = createServiceLifecycle(profile, addresses, {
  setup: () => bootstrapAccessTokens(profile, addresses, buildAuthTokenPlan(profile, (selection) => (
    addresses.notificationUserIndex(selection.occurrence)
  ))),
  'notification.list': (context) => {
    const userId = addresses.notificationUser(context.occurrence);
    request(profile, context.endpoint, {
      path: '/notifications',
      query: { limit: 20 },
      headers: bearerHeaders(context.setupData, userId),
      validate: (response) => Array.isArray(jsonData(response)),
    });
  },
});

export const options = buildOptions(profile);
export function setup() { return lifecycle.setup(); }
export default function (data) { lifecycle.run(data); }
export function handleSummary(data) { return lifecycle.handleSummary(data); }
