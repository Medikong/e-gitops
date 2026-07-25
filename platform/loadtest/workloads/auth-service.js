import {
  buildOptions,
  createServiceLifecycle,
  jsonData,
  datasetAuthPassword,
  request,
  runtimeAddressing,
  uniqueKey,
} from '../lib/runtime.js';

const profile = JSON.parse(__ENV.LOADTEST_PROFILE_JSON);
const addresses = runtimeAddressing(profile);
const supportIntent = {
  name: 'auth.support.intent',
  method: 'POST',
  route: 'POST /api/v1/auth/intents',
  classification: 'setup',
  expectedStatuses: [201],
};

function createIntent(context, measured) {
  const response = request(profile, measured ? context.endpoint : supportIntent, {
    measured,
    path: '/api/v1/auth/intents',
    headers: {
      'X-Client-Channel': 'ios',
      'Idempotency-Key': uniqueKey('auth-intent', context.occurrence),
    },
    body: { returnPath: '/loadtest', intentType: 'navigation' },
    expectedStatuses: [201],
    validate: (result) => {
      const data = jsonData(result);
      return Boolean(data && data.authIntentId && data.authFlowToken);
    },
  });
  return jsonData(response);
}

const lifecycle = createServiceLifecycle(profile, addresses, {
  'auth.intent': (context) => createIntent(context, true),
  'auth.methods': (context) => {
    const intent = createIntent(context, false);
    request(profile, context.endpoint, {
      path: '/api/v1/auth/methods',
      query: { intentId: intent.authIntentId },
      headers: { 'X-Auth-Flow-Token': intent.authFlowToken },
      validate: (response) => Array.isArray(jsonData(response).methods),
    });
  },
  'auth.email-signin': (context) => {
    const intent = createIntent(context, false);
    const userIndex = addresses.sampleIndex('auth-users', context.occurrence, addresses.profile.authUserPoolSize);
    request(profile, context.endpoint, {
      path: '/api/v1/auth/signins/email',
      headers: {
        'X-Auth-Flow-Token': intent.authFlowToken,
        'Idempotency-Key': uniqueKey('auth-signin', context.occurrence),
      },
      body: {
        authIntentId: intent.authIntentId,
        email: addresses.email(userIndex),
        password: datasetAuthPassword(profile),
        rememberMe: false,
      },
      validate: (response) => {
        const data = jsonData(response);
        return Boolean(data && data.tokens && data.tokens.accessToken && data.session && data.session.sessionId);
      },
    });
  },
});

export const options = buildOptions(profile);
export function setup() { return lifecycle.setup(); }
export default function (data) { lifecycle.run(data); }
export function handleSummary(data) { return lifecycle.handleSummary(data); }
