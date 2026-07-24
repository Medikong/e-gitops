import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { runAuthenticatedIngressE2E } from './authenticated-ingress.mjs';

test('rejects a forged identity and reaches a downstream service with the issued token', async (t) => {
  const requests = [];
  const server = createServer(async (request, response) => {
    const body = [];
    for await (const chunk of request) body.push(chunk);
    requests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: Buffer.concat(body).toString('utf8'),
    });

    if (request.url === '/api/v1/dev/auth/test-tokens/bulk') {
      response.writeHead(201, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        data: { count: 1, tokens: [{ accessToken: 'signed-integration-token' }] },
        meta: { requestId: 'request-1' },
      }));
      return;
    }

    if (request.url === '/v1/users/me/interests' && request.headers.authorization === 'Bearer signed-integration-token') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [], pageInfo: { nextCursor: null, hasNext: false } }));
      return;
    }

    response.writeHead(403);
    response.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.equal(typeof address, 'object');

  const logs = [];
  await runAuthenticatedIngressE2E({
    baseUrl: `http://127.0.0.1:${address.port}`,
    devAccessToken: 'development-secret',
    logger: { log: (message) => logs.push(message) },
  });

  assert.equal(requests.length, 3);
  assert.equal(requests[0].headers['x-user-id'], 'forged-ingress-e2e-user');
  assert.equal(requests[0].headers.authorization, undefined);
  assert.equal(requests[1].headers['x-dev-access-token'], 'development-secret');
  assert.deepEqual(JSON.parse(requests[1].body), { count: 1, ttlSeconds: 300 });
  assert.equal(requests[2].headers.authorization, 'Bearer signed-integration-token');
  assert.equal(requests[2].headers['x-user-id'], undefined);
  assert.match(logs[0], /"status":"passed"/);
  assert.doesNotMatch(logs[0], /development-secret|signed-integration-token/);
});
