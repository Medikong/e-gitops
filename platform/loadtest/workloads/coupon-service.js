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
const auth = (setupData, userId) => bearerHeaders(setupData, userId);
const lifecycle = createServiceLifecycle(profile, addresses, {
  // Write allocation is injected by the orchestrator only for a real run, so
  // build this plan in setup rather than k6's inspect-time init context.
  setup: () => bootstrapAccessTokens(profile, addresses, buildAuthTokenPlan(profile, (selection) => {
    if (selection.endpoint.name === 'coupon.claim') return addresses.couponClaim(writeIndex('couponClaim', selection.occurrence)).userIndex;
    return addresses.couponWallet(selection.occurrence).userIndex;
  })),
  'coupon.wallet-list': (context) => {
    const fixture = addresses.couponWallet(context.occurrence);
    request(profile, context.endpoint, {
      path: '/api/v1/users/me/coupons',
      query: { limit: 20 },
      headers: auth(context.setupData, fixture.userId),
      validate: (response) => Array.isArray(jsonData(response).items),
    });
  },
  'coupon.wallet-detail': (context) => {
    const fixture = addresses.couponWallet(context.occurrence);
    request(profile, context.endpoint, {
      path: `/api/v1/users/me/coupons/${encodeURIComponent(fixture.userCouponId)}`,
      headers: auth(context.setupData, fixture.userId),
      validate: (response) => jsonData(response).userCouponId === fixture.userCouponId,
    });
  },
  'coupon.claim': (context) => {
    const fixture = addresses.couponClaim(writeIndex('couponClaim', context.occurrence));
    request(profile, context.endpoint, {
      path: `/api/v1/coupon-campaigns/${encodeURIComponent(fixture.campaignId)}/claims`,
      headers: {
        ...auth(context.setupData, fixture.userId),
        'Idempotency-Key': uniqueKey('coupon-claim', context.occurrence),
      },
      validate: (response) => {
        const data = jsonData(response);
        return Boolean(data.issueRequestId) && data.status === 'pending' && Boolean(data.statusPath);
      },
    });
  },
});

export const options = buildOptions(profile);
export function setup() { return lifecycle.setup(); }
export default function (data) { lifecycle.run(data); }
export function handleSummary(data) { return lifecycle.handleSummary(data); }
