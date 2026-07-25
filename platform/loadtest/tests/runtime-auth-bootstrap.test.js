import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = readFileSync(resolve(root, 'lib', 'runtime.js'), 'utf8');

test('runtime authentication mints the deterministic account pool in bounded batches', () => {
  assert.match(runtime, /const AUTH_BATCH_SIZE = \d+;/);
  assert.match(runtime, /http\.batch\(/);
  assert.doesNotMatch(runtime, /for \(let index = 0; index < addresses\.profile\.authUserPoolSize; index \+= 1\) \{\s*const intent = authIntent/);
});

test('coupon workload uses the run-scoped plan instead of every dataset user', () => {
  const coupon = readFileSync(resolve(root, 'workloads', 'coupon-service.js'), 'utf8');
  const orchestrator = readFileSync(resolve(root, 'scripts', 'orchestrate.js'), 'utf8');
  assert.match(coupon, /buildAuthTokenPlan\(profile/);
  assert.match(coupon, /couponWallet\(selection\.occurrence\)\.userIndex/);
  assert.match(coupon, /couponClaim\(writeIndex\('couponClaim', selection\.occurrence\)\)\.userIndex/);
  assert.match(orchestrator, /runtimePlan = \{ schemaVersion: 'dropmong\.loadtest\.runtime-plan\/v1', iterationBudget: budget \}/);
});

test('all authenticated workloads construct their token plan from scheduled addresses', () => {
  for (const workload of ['user-service.js', 'interest-service.js', 'order-service.js', 'payment-service.js', 'notification-service.js']) {
    const source = readFileSync(resolve(root, 'workloads', workload), 'utf8');
    assert.match(source, /buildAuthTokenPlan\(profile/);
    assert.doesNotMatch(source, /setup: \(\) => bootstrapAccessTokens\(profile, addresses\),/);
  }
});
