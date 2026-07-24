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
const headers = (userId, occurrence, prefix) => ({
  ...bearerHeaders(tokens, userId),
  ...(prefix ? { 'Idempotency-Key': uniqueKey(prefix, occurrence) } : {}),
});

function paymentWrite(context, endpoint, fixtureOccurrence) {
  const fixture = writeFixture(fixtures, 'paymentReady', fixtureOccurrence);
  const expectedStatus = endpoint.includes('failures') ? 'FAILED' : 'APPROVED';
  request(profile, context.endpoint, {
    path: endpoint,
    headers: headers(fixture.userId, context.occurrence, endpoint.includes('failures') ? 'payment-fail' : 'payment-approve'),
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

const lifecycle = createServiceLifecycle(profile, fixtures, {
  'payment.read': (context) => {
    const fixture = readFixture(fixtures, 'paymentRead', context.occurrence);
    request(profile, context.endpoint, {
      path: `/payments/${encodeURIComponent(fixture.paymentId)}`,
      headers: headers(fixture.userId),
      validate: (response) => jsonData(response).id === fixture.paymentId,
    });
  },
  // Even and odd indexes keep approve/fail from consuming the same terminal-payment order.
  'payment.approve': (context) => paymentWrite(context, '/payments/mock-approvals', context.occurrence * 2),
  'payment.fail': (context) => paymentWrite(context, '/payments/mock-failures', context.occurrence * 2 + 1),
});

export const options = buildOptions(profile);
export function setup() { return lifecycle.setup(); }
export default function (data) { lifecycle.run(data); }
export function handleSummary(data) { return lifecycle.handleSummary(data); }
