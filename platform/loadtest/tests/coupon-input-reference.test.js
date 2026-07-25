import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);

test('coupon code input Secret과 hash key는 loadtest 경로에 남기지 않는다', () => {
  const source = [
    readFileSync(resolve(root, 'scripts/orchestrate.js'), 'utf8'),
    readFileSync(resolve(root, 'values/local.yaml'), 'utf8'),
    readFileSync(resolve(root, 'templates/k6-job.yaml'), 'utf8'),
    readFileSync(resolve(root, 'templates/dataset-job.yaml'), 'utf8'),
  ].join('\n');
  assert.doesNotMatch(source, /couponSecret|COUPON_CODE_HASH_KEY|coupon-codes\.json|LOADTEST_COUPON_SECRET/i);
});
