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
import crypto from 'k6/crypto';

const profile = JSON.parse(__ENV.LOADTEST_PROFILE_JSON);
const fixtures = loadSharedFixtures(profile, __ENV.LOADTEST_FIXTURE_MANIFEST || '../fixtures/inspect.json');
const tokens = loadAccessTokens(fixtures);
const auth = (userId) => bearerHeaders(tokens, userId);
const couponSecretFile = __ENV.LOADTEST_COUPON_SECRET_FILE;
const couponSecretBundle = couponSecretFile ? parseCouponSecretBundle(open(couponSecretFile), fixtures) : null;

function parseCouponSecretBundle(text, manifest) {
  const bundle = JSON.parse(text);
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
    throw new Error('coupon Secret file root must be an object');
  }
  if (bundle.schemaVersion !== 1 || typeof bundle.secretName !== 'string' || bundle.secretKey !== 'coupon-codes.json') {
    throw new Error('coupon Secret file contract is invalid');
  }
  if (!bundle.codes || typeof bundle.codes !== 'object' || Array.isArray(bundle.codes)) {
    throw new Error('coupon Secret file codes mapping is missing');
  }
  const secretDataset = bundle.dataset;
  const fixtureDataset = manifest.dataset;
  if (
    !secretDataset
    || !fixtureDataset
    || secretDataset.profile !== fixtureDataset.profile
    || secretDataset.profileHash !== fixtureDataset.profileHash
    || secretDataset.seedHash !== crypto.sha256(String(fixtureDataset.seed), 'hex')
  ) {
    throw new Error('coupon Secret file dataset identity does not match the fixture manifest');
  }
  return bundle;
}

function couponCode(fixture) {
  if (!couponSecretBundle) {
    throw new Error('LOADTEST_COUPON_SECRET_FILE is required by coupon.code-redeem');
  }
  const reference = String(fixture.codeRef || '');
  const match = /^secretFileRef:([^/]+)\/([^#]+)#([A-Za-z0-9_.-]+)$/.exec(reference);
  if (!match) {
    throw new Error('couponRedeem fixture codeRef is invalid');
  }
  const [, secretName, secretKey, codeKey] = match;
  if (secretName !== couponSecretBundle.secretName || secretKey !== couponSecretBundle.secretKey) {
    throw new Error('couponRedeem fixture codeRef does not match the mounted Secret');
  }
  const code = couponSecretBundle.codes[codeKey];
  if (typeof code !== 'string' || !/^[A-Z0-9-]{4,128}$/.test(code)) {
    throw new Error('couponRedeem Secret does not contain the referenced code');
  }
  return code;
}

const lifecycle = createServiceLifecycle(profile, fixtures, {
  'coupon.wallet-list': (context) => {
    const fixture = readFixture(fixtures, 'couponWallet', context.occurrence);
    request(profile, context.endpoint, {
      path: '/api/v1/users/me/coupons',
      query: { limit: 20 },
      headers: auth(fixture.userId),
      validate: (response) => Array.isArray(jsonData(response).items),
    });
  },
  'coupon.wallet-detail': (context) => {
    const fixture = readFixture(fixtures, 'couponWallet', context.occurrence);
    request(profile, context.endpoint, {
      path: `/api/v1/users/me/coupons/${encodeURIComponent(fixture.userCouponId)}`,
      headers: auth(fixture.userId),
      validate: (response) => jsonData(response).userCouponId === fixture.userCouponId,
    });
  },
  'coupon.claim': (context) => {
    const fixture = writeFixture(fixtures, 'couponClaim', context.occurrence);
    request(profile, context.endpoint, {
      path: `/api/v1/coupon-campaigns/${encodeURIComponent(fixture.campaignId)}/claims`,
      headers: {
        ...auth(fixture.userId),
        'Idempotency-Key': uniqueKey('coupon-claim', context.occurrence),
      },
      validate: (response) => {
        const data = jsonData(response);
        return Boolean(data.issueRequestId) && data.status === 'pending' && Boolean(data.statusPath);
      },
    });
  },
  'coupon.code-redeem': (context) => {
    const fixture = writeFixture(fixtures, 'couponRedeem', context.occurrence);
    request(profile, context.endpoint, {
      path: '/api/v1/coupon-code-redemptions',
      headers: {
        ...auth(fixture.userId),
        'Idempotency-Key': uniqueKey('coupon-code', context.occurrence),
      },
      body: { code: couponCode(fixture) },
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
