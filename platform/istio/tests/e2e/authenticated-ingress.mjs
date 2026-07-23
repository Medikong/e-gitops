import { pathToFileURL } from 'node:url';

const BULK_TOKEN_PATH = '/api/v1/dev/auth/test-tokens/bulk';
const DEFAULT_TARGET_PATH = '/v1/users/me/interests';
const DEFAULT_TIMEOUT_MS = 10_000;

function required(value, name) {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function positiveInteger(value, name, fallback) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function endpoint(baseUrl, path) {
  return new URL(path, `${baseUrl.replace(/\/$/, '')}/`);
}

async function call(fetchImpl, url, init, timeoutMs) {
  return fetchImpl(url, {
    ...init,
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function responseJson(response, label) {
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} returned non-JSON response with status ${response.status}`);
  }
}

export async function runAuthenticatedIngressE2E({
  baseUrl,
  devAccessToken,
  targetPath = DEFAULT_TARGET_PATH,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
  logger = console,
}) {
  const ingress = required(baseUrl, 'INGRESS_BASE_URL');
  const developmentCredential = required(devAccessToken, 'AUTH_DEV_ACCESS_TOKEN');
  const requestTimeoutMs = positiveInteger(timeoutMs, 'INGRESS_REQUEST_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);

  const bypassResponse = await call(fetchImpl, endpoint(ingress, targetPath), {
    method: 'GET',
    headers: { 'X-User-Id': 'forged-ingress-e2e-user' },
  }, requestTimeoutMs);
  if (![401, 403].includes(bypassResponse.status)) {
    throw new Error(`protected API accepted a forged identity header: status ${bypassResponse.status}`);
  }

  const issuanceResponse = await call(fetchImpl, endpoint(ingress, BULK_TOKEN_PATH), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Dev-Access-Token': developmentCredential,
    },
    body: JSON.stringify({ count: 1, ttlSeconds: 300 }),
  }, requestTimeoutMs);
  if (issuanceResponse.status !== 201) {
    throw new Error(`bulk token issuance failed with status ${issuanceResponse.status}`);
  }

  const issuance = await responseJson(issuanceResponse, 'bulk token issuance');
  const issued = issuance?.data?.tokens?.[0];
  if (issuance?.data?.count !== 1 || issuance.data.tokens.length !== 1 || !issued?.accessToken) {
    throw new Error('bulk token issuance response does not contain exactly one access token');
  }

  const protectedResponse = await call(fetchImpl, endpoint(ingress, targetPath), {
    method: 'GET',
    headers: { Authorization: `Bearer ${issued.accessToken}` },
  }, requestTimeoutMs);
  if (protectedResponse.status !== 200) {
    throw new Error(`authenticated downstream request failed with status ${protectedResponse.status}`);
  }

  const protectedBody = await responseJson(protectedResponse, 'authenticated downstream request');
  if (!Array.isArray(protectedBody?.data) || typeof protectedBody?.pageInfo !== 'object') {
    throw new Error('authenticated downstream response does not match the Interest service contract');
  }

  logger.log(JSON.stringify({
    status: 'passed',
    checks: {
      forgedIdentityRejected: true,
      bulkTokenIssued: true,
      authenticatedInterestRequest: true,
    },
  }));
}

async function main() {
  await runAuthenticatedIngressE2E({
    baseUrl: process.env.INGRESS_BASE_URL,
    devAccessToken: process.env.AUTH_DEV_ACCESS_TOKEN,
    targetPath: process.env.INGRESS_AUTH_TARGET_PATH || DEFAULT_TARGET_PATH,
    timeoutMs: process.env.INGRESS_REQUEST_TIMEOUT_MS || DEFAULT_TIMEOUT_MS,
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`authenticated ingress E2E failed: ${error.message}`);
    process.exitCode = 1;
  });
}
