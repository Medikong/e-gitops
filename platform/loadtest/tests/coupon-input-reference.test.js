import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);

test('coupon Dataset Job validates the same existing input Secret that it mounts', () => {
  const source = readFileSync(resolve(root, 'scripts/orchestrate.js'), 'utf8');
  assert.match(source, /'run\.couponSecretName': fixture\.coupon\?\.existingSecret/);
  assert.match(source, /couponSecret\.existingSecret/);
});
