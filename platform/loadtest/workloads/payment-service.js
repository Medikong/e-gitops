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
const headers = (setupData, userId, occurrence, prefix) => ({
  ...bearerHeaders(setupData, userId),
  ...(prefix ? { 'Idempotency-Key': uniqueKey(prefix, occurrence) } : {}),
});

function paymentWrite(context, endpoint, poolName, offset = 0) {
  const fixture = addresses.paymentReadyOrderFact(writeIndex(poolName, context.occurrence) + offset);
  const expectedStatus = endpoint.includes('failures') ? 'FAILED' : 'APPROVED';
  request(profile, context.endpoint, {
    path: endpoint,
    headers: headers(context.setupData, fixture.userId, context.occurrence, endpoint.includes('failures') ? 'payment-fail' : 'payment-approve'),
    body: {
      orderId: fixture.orderId,
      amount: fixture.amount,
      method: 'MOCK_CARD',
      ...(endpoint.includes('failures') ? { reason: 'loadtest requested failure' } : {}),
    },
    validate: (response) => {
      const data = jsonData(response);
      return Boolean(data.id) && data.orderId === fixture.orderId && data.status === expectedStatus;
    },
  });
}

const lifecycle = createServiceLifecycle(profile, addresses, {
  setup: () => bootstrapAccessTokens(profile, addresses, buildAuthTokenPlan(profile, (selection) => {
    if (selection.endpoint.name === 'payment.read') {
      return addresses.orderFact(addresses.sampleIndex('payment-read', selection.occurrence, addresses.profile.orderCount)).userIndex;
    }
    const offset = selection.endpoint.name === 'payment.fail' ? Math.floor(addresses.profile.paymentReadyOrderCount / 2) : 0;
    const poolName = selection.endpoint.name === 'payment.fail' ? 'paymentReadyFail' : 'paymentReadyApprove';
    return addresses.paymentReadyOrderFact(writeIndex(poolName, selection.occurrence) + offset).userIndex;
  })),
  'payment.read': (context) => {
    const fixture = addresses.orderFact(addresses.sampleIndex('payment-read', context.occurrence, addresses.profile.orderCount));
    request(profile, context.endpoint, {
      path: `/payments/${encodeURIComponent(fixture.paymentId)}`,
      headers: headers(context.setupData, fixture.userId),
      validate: (response) => jsonData(response).id === fixture.paymentId,
    });
  },
  // Even and odd indexes keep approve/fail from consuming the same terminal-payment order.
  'payment.approve': (context) => paymentWrite(context, '/payments/mock-approvals', 'paymentReadyApprove'),
  'payment.fail': (context) => paymentWrite(context, '/payments/mock-failures', 'paymentReadyFail', Math.floor(addresses.profile.paymentReadyOrderCount / 2)),
});

export const options = buildOptions(profile);
export function setup() { return lifecycle.setup(); }
export default function (data) { lifecycle.run(data); }
export function handleSummary(data) { return lifecycle.handleSummary(data); }
