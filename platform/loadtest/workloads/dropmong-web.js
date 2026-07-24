import {
  buildOptions,
  createServiceLifecycle,
  decodeSignedDevelopmentSession,
  jsonData,
  loadSharedFixtures,
  readFixture,
  request,
  uniqueKey,
  writeFixture,
} from '../lib/runtime.js';
import { fail } from 'k6';
import http from 'k6/http';

const profile = JSON.parse(__ENV.LOADTEST_PROFILE_JSON);
const fixtures = loadSharedFixtures(profile, __ENV.LOADTEST_FIXTURE_MANIFEST || '../fixtures/inspect.json');
const supportSession = {
  name: 'web.support.development-session',
  method: 'GET',
  route: 'GET /api/web/auth/development-session',
  classification: 'setup',
  expectedStatuses: [307],
};

function developmentSession() {
  const response = http.get(`${profile.baseUrl}/api/web/auth/development-session?returnTo=%2Fcheckout%2Floadtest`, {
    redirects: 0,
    responseCallback: http.expectedStatuses(307, 404),
    tags: {
      endpoint: supportSession.name,
      measured: 'false',
      run_id: __ENV.LOADTEST_RUN_ID || 'unknown',
      service: profile.service,
      trial_id: __ENV.LOADTEST_TRIAL_ID || 'unknown',
    },
  });
  if (response.status === 404) {
    return { available: false, reason: 'DEV_MOCK_MODE_DISABLED' };
  }
  if (response.status !== 307) {
    throw new Error(`development session failed with status ${response.status}`);
  }
  const cookies = response.cookies.dropmong_dev_session || [];
  if (cookies.length === 0) {
    throw new Error('development session response did not set dropmong_dev_session');
  }
  const value = cookies[0].value;
  return { available: true, cookie: value, actor: decodeSignedDevelopmentSession(value) };
}

function requireDevelopmentSession(context) {
  const session = context.setupData && context.setupData.developmentSession;
  if (!session || !session.available) {
    console.log(JSON.stringify({
      event: 'api_step_results',
      endpoint: context.endpoint.name,
      error_class: 'development_mock_unavailable',
      reason: session && session.reason ? session.reason : 'development session missing',
      run_id: __ENV.LOADTEST_RUN_ID || 'unknown',
      service: profile.service,
      trial_id: __ENV.LOADTEST_TRIAL_ID || 'unknown',
    }));
    fail(`${context.endpoint.name} requires DEV_MOCK_MODE=true`);
  }
  return session;
}

const lifecycle = createServiceLifecycle(profile, fixtures, {
  setup: () => ({ developmentSession: developmentSession() }),
  'web.home': (context) => request(profile, context.endpoint, {
    path: '/api/web/home',
    validate: (response) => Boolean(jsonData(response)),
  }),
  'web.product': (context) => {
    const fixture = readFixture(fixtures, 'webProducts', context.occurrence);
    request(profile, context.endpoint, {
      path: `/api/web/products/${encodeURIComponent(fixture.productId)}`,
      query: { dropId: fixture.dropId },
      validate: (response) => Boolean(jsonData(response)),
    });
  },
  'web.checkout': (context) => {
    const fixture = readFixture(fixtures, 'webCheckouts', context.occurrence);
    const session = requireDevelopmentSession(context);
    request(profile, context.endpoint, {
      path: `/api/web/checkouts/${encodeURIComponent(fixture.checkoutId)}`,
      cookies: { dropmong_dev_session: session.cookie },
      validate: (response) => jsonData(response).checkoutId === fixture.checkoutId,
    });
  },
  'web.checkout-confirm': (context) => {
    const fixture = writeFixture(fixtures, 'webCheckouts', context.occurrence);
    const session = requireDevelopmentSession(context);
    const webOrigin = __ENV.LOADTEST_WEB_ORIGIN;
    if (!webOrigin) {
      throw new Error('LOADTEST_WEB_ORIGIN is required by web.checkout-confirm');
    }
    request(profile, context.endpoint, {
      path: `/api/web/checkouts/${encodeURIComponent(fixture.checkoutId)}/confirm`,
      cookies: { dropmong_dev_session: session.cookie },
      headers: {
        Origin: webOrigin,
        'X-CSRF-Token': session.actor.csrfToken,
        'Idempotency-Key': uniqueKey('web-checkout', context.occurrence),
      },
      body: { agreementConfirmed: true },
      validate: (response) => Boolean(jsonData(response).orderId),
    });
  },
});

export const options = buildOptions(profile);
export function setup() { return lifecycle.setup(); }
export default function (data) { lifecycle.run(data); }
export function handleSummary(data) { return lifecycle.handleSummary(data); }
