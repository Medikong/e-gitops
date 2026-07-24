import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fixtureUserIDs,
  serviceNeedsAccessTokens,
  tokenInputDocument,
} from '../lib/access-token-input.js';

const firstUserID = '11111111-1111-4111-8111-111111111111';
const secondUserID = '22222222-2222-4222-8222-222222222222';
const manifest = {
  dataset: { profile: 'smoke-1day', profileHash: 'fixture-profile-hash', seed: '20260724' },
  pools: {
    profileRead: [{ userId: firstUserID }],
    orderRead: [{ userId: secondUserID }, { userId: firstUserID }],
  },
};

test('fixture의 userId를 중복 없이 안정된 순서로 수집한다', () => {
  assert.deepEqual(fixtureUserIDs(manifest), [firstUserID, secondUserID]);
});

test('Auth 응답은 요청한 fixture userId와 정확히 일치할 때만 k6 입력 문서가 된다', () => {
  const document = tokenInputDocument(manifest, [firstUserID, secondUserID], {
    data: {
      count: 2,
      tokens: [
        { userId: firstUserID, accessToken: 'test-access-token-one' },
        { userId: secondUserID, accessToken: 'test-access-token-two' },
      ],
    },
  });
  assert.deepEqual(document.dataset, manifest.dataset);
  assert.deepEqual(document.tokens.map((token) => token.userId), [firstUserID, secondUserID]);
  assert.throws(() => tokenInputDocument(manifest, [firstUserID], { data: { count: 1, tokens: [{ userId: secondUserID, accessToken: 'test' }] } }));
});

test('Bearer token이 필요한 서비스만 local token input을 준비한다', () => {
  assert.equal(serviceNeedsAccessTokens('catalog-service'), false);
  assert.equal(serviceNeedsAccessTokens('user-service'), true);
  assert.equal(serviceNeedsAccessTokens('dropmong-web'), false);
});
