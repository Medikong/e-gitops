import {
  buildOptions,
  createServiceLifecycle,
  jsonData,
  request,
  runtimeAddressing,
} from '../lib/runtime.js';

const profile = JSON.parse(__ENV.LOADTEST_PROFILE_JSON);
const addresses = runtimeAddressing(profile);

const lifecycle = createServiceLifecycle(profile, addresses, {
  'catalog.drop-list': (context) => request(profile, context.endpoint, {
    path: '/drops',
    query: { limit: 20 },
    validate: (response) => Array.isArray(jsonData(response)),
  }),
  'catalog.drop-detail': (context) => {
    const dropId = addresses.drop(addresses.sampleIndex('drops', context.occurrence, addresses.profile.dropCount));
    request(profile, context.endpoint, {
      path: `/drops/${encodeURIComponent(dropId)}`,
      validate: (response) => {
        const data = jsonData(response);
        return data && data.id === dropId && Array.isArray(data.products);
      },
    });
  },
});

export const options = buildOptions(profile);
export function setup() { return lifecycle.setup(); }
export default function (data) { lifecycle.run(data); }
export function handleSummary(data) { return lifecycle.handleSummary(data); }
