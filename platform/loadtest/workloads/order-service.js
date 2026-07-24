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
const user = (userId, occurrence, prefix) => ({
  ...bearerHeaders(tokens, userId),
  ...(prefix ? { 'Idempotency-Key': uniqueKey(prefix, occurrence) } : {}),
});

const lifecycle = createServiceLifecycle(profile, fixtures, {
  'order.read': (context) => {
    const fixture = readFixture(fixtures, 'orderRead', context.occurrence);
    request(profile, context.endpoint, {
      path: `/orders/${encodeURIComponent(fixture.orderId)}`,
      headers: user(fixture.userId),
      validate: (response) => jsonData(response).id === fixture.orderId,
    });
  },
  'order.create': (context) => {
    const fixture = writeFixture(fixtures, 'orderCreate', context.occurrence);
    request(profile, context.endpoint, {
      path: '/orders',
      headers: user(fixture.userId, context.occurrence, 'order-create'),
      body: {
        dropId: fixture.dropId,
        productId: fixture.productId,
        quantity: fixture.quantity || 1,
      },
      validate: (response) => Boolean(jsonData(response).id),
    });
  },
  'order.cancel': (context) => {
    const fixture = writeFixture(fixtures, 'orderCancel', context.occurrence);
    request(profile, context.endpoint, {
      path: `/orders/${encodeURIComponent(fixture.orderId)}/cancellations`,
      headers: user(fixture.userId, context.occurrence, 'order-cancel'),
      body: { reason: 'loadtest cancellation fixture' },
      validate: (response) => Boolean(jsonData(response).id),
    });
  },
});

export const options = buildOptions(profile);
export function setup() { return lifecycle.setup(); }
export default function (data) { lifecycle.run(data); }
export function handleSummary(data) { return lifecycle.handleSummary(data); }
