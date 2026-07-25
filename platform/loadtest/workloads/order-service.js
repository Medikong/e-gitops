import {
  buildOptions,
  bearerHeaders,
  buildAuthTokenPlan,
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
const user = (setupData, userId, occurrence, prefix) => ({
  ...bearerHeaders(setupData, userId),
  ...(prefix ? { 'Idempotency-Key': uniqueKey(prefix, occurrence) } : {}),
});

const lifecycle = createServiceLifecycle(profile, addresses, {
  setup: () => bootstrapAccessTokens(profile, addresses, buildAuthTokenPlan(profile, (selection) => {
    if (selection.endpoint.name === 'order.read') {
      return addresses.orderFact(addresses.sampleIndex('order-read', selection.occurrence, addresses.profile.orderCount)).userIndex;
    }
    if (selection.endpoint.name === 'order.create') return addresses.orderCreate(writeIndex('orderCreate', selection.occurrence)).userIndex;
    return addresses.approvedOrderFact(writeIndex('orderCancel', selection.occurrence)).userIndex;
  })),
  'order.read': (context) => {
    const fixture = addresses.orderFact(addresses.sampleIndex('order-read', context.occurrence, addresses.profile.orderCount));
    request(profile, context.endpoint, {
      path: `/orders/${encodeURIComponent(fixture.orderId)}`,
      headers: user(context.setupData, fixture.userId),
      validate: (response) => jsonData(response).id === fixture.orderId,
    });
  },
  'order.create': (context) => {
    const fixture = addresses.orderCreate(writeIndex('orderCreate', context.occurrence));
    request(profile, context.endpoint, {
      path: '/orders',
      headers: user(context.setupData, fixture.userId, context.occurrence, 'order-create'),
      body: {
        dropId: fixture.dropId,
        productId: fixture.productId,
        quantity: fixture.quantity || 1,
      },
      validate: (response) => Boolean(jsonData(response).id),
    });
  },
  'order.cancel': (context) => {
    const fixture = addresses.approvedOrderFact(writeIndex('orderCancel', context.occurrence));
    request(profile, context.endpoint, {
      path: `/orders/${encodeURIComponent(fixture.orderId)}/cancellations`,
      headers: user(context.setupData, fixture.userId, context.occurrence, 'order-cancel'),
      body: { reason: 'loadtest cancellation fixture' },
      validate: (response) => Boolean(jsonData(response).id),
    });
  },
});

export const options = buildOptions(profile);
export function setup() { return lifecycle.setup(); }
export default function (data) { lifecycle.run(data); }
export function handleSummary(data) { return lifecycle.handleSummary(data); }
