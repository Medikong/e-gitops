import { createServer } from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { run, LoadtestError } from '../scripts/lib/io.js';

const AUTHENTICATED_SERVICES = new Set([
  'user-service', 'coupon-service', 'interest-service', 'order-service', 'payment-service', 'notification-service',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function serviceNeedsAccessTokens(service) {
  return AUTHENTICATED_SERVICES.has(service);
}

export function fixtureUserIDs(manifest) {
  if (!manifest?.pools || typeof manifest.pools !== 'object') throw new TypeError('fixture manifest pools are unavailable');
  const userIDs = [];
  const seen = new Set();
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (typeof value.userId === 'string') {
      if (!UUID.test(value.userId)) throw new TypeError('fixture manifest userId is not a UUID');
      if (!seen.has(value.userId)) {
        seen.add(value.userId);
        userIDs.push(value.userId);
      }
    }
    Object.values(value).forEach(visit);
  };
  visit(manifest.pools);
  return userIDs;
}

export function tokenInputDocument(manifest, requestedUserIDs, response) {
  const tokens = response?.data?.tokens;
  if (!Array.isArray(tokens) || response.data?.count !== requestedUserIDs.length || tokens.length !== requestedUserIDs.length) {
    throw new TypeError('Auth bulk token response count does not match fixture users');
  }
  const requested = new Set(requestedUserIDs);
  const seen = new Set();
  const values = tokens.map((token) => {
    if (!token || typeof token !== 'object' || !requested.has(token.userId) || seen.has(token.userId) || typeof token.accessToken !== 'string' || !token.accessToken) {
      throw new TypeError('Auth bulk token response does not match requested fixture users');
    }
    seen.add(token.userId);
    return { userId: token.userId, accessToken: token.accessToken };
  });
  if (seen.size !== requested.size) throw new TypeError('Auth bulk token response omitted a fixture user');
  return {
    schemaVersion: 1,
    dataset: {
      profile: manifest.dataset?.profile,
      profileHash: manifest.dataset?.profileHash,
      seed: String(manifest.dataset?.seed ?? ''),
    },
    tokens: values,
  };
}

function requiredString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new LoadtestError('configuration', `${name} is unavailable`);
  return value.trim();
}

function secretValue(namespace, name, key) {
  const encoded = run('kubectl', ['get', 'secret', name, '-n', namespace, '-o', `jsonpath={.data.${key}}`], { category: 'token_input' }).stdout.trim();
  if (!encoded) throw new LoadtestError('configuration', 'Auth development access token input is unavailable');
  return Buffer.from(encoded, 'base64').toString('utf8');
}

function availablePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('local port allocation failed'));
        return;
      }
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

async function stopPortForward(process) {
  if (process.exitCode !== null) return;
  process.kill('SIGTERM');
  await Promise.race([
    once(process, 'exit'),
    new Promise((resolveWait) => setTimeout(resolveWait, 3_000)),
  ]);
  if (process.exitCode === null) process.kill('SIGKILL');
}

async function requestTokens(baseURL, devAccessToken, userIDs, fetchImpl) {
  let lastError = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetchImpl(`${baseURL}/api/v1/dev/auth/test-tokens/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Dev-Access-Token': devAccessToken },
        body: JSON.stringify({ userIds: userIDs, ttlSeconds: 3600 }),
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status !== 201) throw new LoadtestError('token_input', `Auth bulk token issuance returned status ${response.status}`);
      return response.json();
    } catch (error) {
      if (error instanceof LoadtestError) throw error;
      lastError = error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    }
  }
  throw new LoadtestError('token_input', `Auth bulk token issuance is unavailable: ${lastError?.name ?? 'request failed'}`);
}

function applyTokenSecret(namespace, input, document) {
  const manifest = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: input.existingSecret, namespace, labels: { 'app.kubernetes.io/part-of': 'dropmong-loadtest' } },
    type: 'Opaque',
    data: { [input.key]: Buffer.from(JSON.stringify(document)).toString('base64') },
  };
  run('kubectl', ['apply', '-f', '-'], { input: JSON.stringify(manifest), category: 'token_input' });
}

export async function prepareLocalAccessTokens({ environment, service, fixtureManifest, fetchImpl = fetch }) {
  if (!serviceNeedsAccessTokens(service)) return { status: 'not_required', users: 0 };
  if (environment.safety?.remote === true) throw new LoadtestError('configuration', 'local access token preparation is unavailable for remote environments');
  const input = environment.accessTokenInput ?? {};
  const auth = input.auth ?? {};
  const ingress = input.ingress ?? {};
  const namespace = requiredString(environment.loadtestNamespace, 'loadtest namespace');
  requiredString(input.existingSecret, 'access token input Secret');
  requiredString(input.key, 'access token input key');
  const userIDs = fixtureUserIDs(fixtureManifest);
  if (!userIDs.length) throw new LoadtestError('configuration', `${service} fixture does not contain authenticated user IDs`);
  const devAccessToken = secretValue(requiredString(auth.namespace, 'Auth namespace'), requiredString(auth.secretName, 'Auth access Secret'), requiredString(auth.secretKey, 'Auth access Secret key'));
  const port = await availablePort();
  const forward = spawn('kubectl', [
    'port-forward', '--address', '127.0.0.1', '-n', requiredString(ingress.namespace, 'ingress namespace'),
    `service/${requiredString(ingress.service, 'ingress service')}`, `${port}:${Number(ingress.port ?? 80)}`,
  ], { stdio: ['ignore', 'ignore', 'ignore'] });
  try {
    const response = await requestTokens(`http://127.0.0.1:${port}`, devAccessToken, userIDs, fetchImpl);
    const document = tokenInputDocument(fixtureManifest, userIDs, response);
    applyTokenSecret(namespace, input, document);
    return { status: 'prepared', users: userIDs.length };
  } finally {
    await stopPortForward(forward);
  }
}
