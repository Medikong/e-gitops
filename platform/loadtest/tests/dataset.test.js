import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { parse } from 'yaml';
import { datasetCacheKey, validateServiceCache } from '../datasets/cache.js';
import { copyGeneratedTable, streamRowsToCopy } from '../datasets/copy.js';
import { createAddressBook, writeCapacities } from '../lib/deterministic-data.js';
import { DatasetModel } from '../datasets/model.js';
import { datasetAuthPassword, datasetAuthPasswordHash } from '../datasets/auth.js';
import { expectedTableCounts, loadProfile } from '../datasets/profile.js';
import { ORDER_SERVICE_LOADTEST_PRODUCT, plansForService } from '../datasets/plans.js';
import { safeError } from '../datasets/seed.js';
import { isMigrationMetadataTable, truncateService } from '../datasets/service.js';

const root = resolve(new URL('..', import.meta.url).pathname);
const smokeDocument = parse(readFileSync(join(root, 'values', 'datasets', 'smoke.yaml'), 'utf8')).dataset;
const profile = loadProfile({ name: smokeDocument.profile, ...smokeDocument.parameters });

test('YAML profile 계약을 검증하고 예상 행 수를 계산한다', () => {
  assert.equal(profile.userCount, 128);
  assert.equal(expectedTableCounts(profile)['catalog-service'].products, 12);
  const smoke100 = parse(readFileSync(join(root, 'values', 'datasets', 'smoke-100.yaml'), 'utf8')).dataset;
  const smoke100Counts = expectedTableCounts(loadProfile({ name: smoke100.profile, ...smoke100.parameters }))['catalog-service'];
  assert.equal(Object.values(smoke100Counts).reduce((sum, count) => sum + count, 0), 96);
  const baseline = parse(readFileSync(join(root, 'values', 'datasets', 'baseline-90days.yaml'), 'utf8')).dataset;
  assert.equal(loadProfile({ name: baseline.profile, ...baseline.parameters }).days, 90);
  assert.throws(() => loadProfile({ ...profile.source, days: 0 }), /positive integer/);
});

function addressesFor(document) {
  return createAddressBook({ profile: document.profile, parameters: document.parameters }, document.seed, {
    sha256: (value) => createHash('sha256').update(value).digest('hex'),
    sha1: (value) => createHash('sha1').update(value).digest('hex'),
  });
}

test('Coupon runtime addressing은 코드 원문이나 Secret 참조 없이 사용자 공개 API만 측정한다', () => {
  const document = parse(readFileSync(join(root, 'values', 'datasets', 'baseline-90days.yaml'), 'utf8')).dataset;
  const addresses = addressesFor(document);
  assert.ok(addresses.couponWallet(0).userCouponId);
  assert.doesNotMatch(JSON.stringify(addresses.couponClaim(0)), /secretFileRef|coupon-codes\.json/i);
});

test('90일 runtime addressing은 대형 artifact manifest를 만들지 않는다', () => {
  const document = parse(readFileSync(join(root, 'values', 'datasets', 'baseline-90days.yaml'), 'utf8')).dataset;
  const addresses = addressesFor(document);
  assert.ok(addresses.profile.dropCount > 0);
  assert.ok(writeCapacities({ profile: document.profile, parameters: document.parameters }).paymentReady > 0);
});

test('seeder와 k6는 같은 seed에서 같은 주소를 계산하고 인증값은 파일 없이 검증된다', () => {
  const model = new DatasetModel(profile, smokeDocument.seed);
  const addresses = addressesFor(smokeDocument);
  assert.equal(model.user(7), addresses.user(7));
  for (const key of ['orderId', 'paymentId', 'userId', 'dropId', 'productId', 'quantity', 'amount', 'approved']) {
    assert.equal(model.orderFact(3)[key], addresses.orderFact(3)[key]);
  }
  for (const key of ['orderId', 'userId', 'dropId', 'productId', 'quantity', 'amount']) {
    assert.equal(model.paymentReadyOrderFact(2)[key], addresses.paymentReadyOrderFact(2)[key]);
  }
  const password = datasetAuthPassword(smokeDocument.seed);
  assert.equal(password, datasetAuthPassword(smokeDocument.seed));
  assert.equal(bcrypt.compareSync(password, datasetAuthPasswordHash(smokeDocument.seed)), true);
});

test('dataset 초기화는 계약에 있는 데이터 테이블만 비우고 migration과 정책 테이블을 보존한다', async () => {
  for (const table of ['alembic_version', 'goose_db_version', 'auth_goose_db_version', 'auth_dev_goose_db_version', 'audit_goose_db_version', 'user_goose_db_version', 'coupon_goose_db_version']) assert.equal(isMigrationMetadataTable(table), true, table);
  assert.equal(isMigrationMetadataTable('auth_identities'), false);
  const statements = [];
  const client = { async query(statement) { statements.push(statement); return { rows: [] }; } };
  await truncateService(client, [{ table: 'auth_identities' }, { table: 'auth_policies' }, { table: 'alembic_version' }], 'auth-service');
  assert.deepEqual(statements, ['TRUNCATE TABLE "auth_identities" RESTART IDENTITY CASCADE']);
});

test('같은 seed의 행과 runtime address는 결정론적이며 쓰기 범위는 용량을 가진다', () => {
  const first = new DatasetModel(profile, smokeDocument.seed ?? '20260723');
  const second = new DatasetModel(profile, smokeDocument.seed ?? '20260723');
  const rows = (model) => Array.from(plansForService('catalog-service', model)).map((value) => Array.from(value.rows).slice(0, 3));
  assert.deepEqual(rows(first), rows(second));
  const firstAddresses = addressesFor(smokeDocument);
  const secondAddresses = addressesFor(smokeDocument);
  assert.deepEqual(firstAddresses.couponClaim(0), secondAddresses.couponClaim(0));
  assert.ok(writeCapacities({ profile: smokeDocument.profile, parameters: smokeDocument.parameters }).paymentReady > 0);
});

test('Order 생성 address는 현재 Order 서비스가 판매 가능으로 허용한 상품과 inventory를 함께 준비한다', () => {
  const model = new DatasetModel(profile, '20260725');
  const addresses = addressesFor({ ...smokeDocument, seed: '20260725' });
  const address = addresses.orderCreate(0);
  assert.equal(address.dropId, ORDER_SERVICE_LOADTEST_PRODUCT.dropId);
  assert.equal(address.productId, ORDER_SERVICE_LOADTEST_PRODUCT.productId);
  const inventory = Array.from(plansForService('order-service', model)).find((entry) => entry.table === 'inventory_items');
  assert.ok(inventory);
  assert.ok(Array.from(inventory.rows).some(([dropId, productId, total]) => dropId === ORDER_SERVICE_LOADTEST_PRODUCT.dropId && productId === ORDER_SERVICE_LOADTEST_PRODUCT.productId && total > 0));
});

test('모든 서비스 generator가 예상 행 수와 column 계약을 지킨다', () => {
  const seed = '20260723';
  const model = new DatasetModel(profile, seed, { authPasswordHash: 'test-only-password-hash' });
  const expected = expectedTableCounts(profile);
  for (const service of Object.keys(expected)) {
    for (const value of plansForService(service, model)) {
      let count = 0;
      for (const row of value.rows) { assert.equal(row.length, value.columns.length, `${service}.${value.table}`); count += 1; }
      assert.equal(count, expected[service][value.table], `${service}.${value.table}`);
    }
  }
});

test('제한된 배치가 backpressure를 기다리면서 하나의 COPY stream을 유지한다', async () => {
  let writes = 0;
  const writable = new Writable({ highWaterMark: 1, write(_chunk, _encoding, callback) { writes += 1; setImmediate(callback); } });
  const rows = Array.from({ length: 10_001 }, (_, index) => [index, `value-${index}`]);
  assert.equal(await streamRowsToCopy(writable, rows, { batchRows: 10_000 }), rows.length);
  assert.equal(writes, 2);
  let copyStarts = 0;
  const client = { query(statement) { copyStarts += 1; assert.match(statement.text, /^COPY "items"/); return new Writable({ write(_chunk, _encoding, callback) { callback(); } }); } };
  assert.equal(await copyGeneratedTable(client, 'items', ['id'], [[1], [2]], { batchRows: 10_000 }), 2);
  assert.equal(copyStarts, 1);
});

test('cache key는 정규화 순서에 안정적이고 dataset, generator, schema 변경을 감지한다', () => {
  const base = { dataset: { b: 2, a: 1 }, seed: 's', revision: 'r1', generatorRevision: 'g1', schemaIdentifiers: { catalog: 'x' } };
  const key = datasetCacheKey(base);
  assert.equal(key, datasetCacheKey({ ...base, dataset: { a: 1, b: 2 } }));
  for (const changed of [{ ...base, seed: 's2' }, { ...base, revision: 'r2' }, { ...base, generatorRevision: 'g2' }, { ...base, schemaIdentifiers: { catalog: 'y' } }, { ...base, credentialFingerprint: 'f'.repeat(64) }]) assert.notEqual(key, datasetCacheKey(changed));
});

test('checksum이 바뀐 local cache는 hit로 인정하지 않는다', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dropmong-cache-')); const serviceDirectory = join(directory, 'databases', 'catalog-service'); mkdirSync(serviceDirectory, { recursive: true }); const path = join(serviceDirectory, 'drops.bin'); writeFileSync(path, 'binary-one');
  const entry = { schemaVersion: 'dropmong.loadtest.dataset-cache/v1', hash: 'a'.repeat(64), generatorRevision: 'g', services: { 'catalog-service': { postgresqlMajor: '16', schemaHash: 'schema', tables: { drops: { file: 'drops.bin', columns: ['id'], rows: 1, bytes: 10, sha256: createHash('sha256').update('binary-one').digest('hex') } } } } };
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(entry)); const args = { hash: 'a'.repeat(64), service: 'catalog-service', postgresMajor: 16, schemaHash: 'schema', contracts: [{ table: 'drops', columns: ['id'] }], expectedRows: { drops: 1 }, generatorRevision: 'g' };
  assert.equal(validateServiceCache(directory, args).hit, true); writeFileSync(path, 'corrupted'); assert.equal(validateServiceCache(directory, args).hit, false); rmSync(directory, { recursive: true, force: true });
});

test('dataset 오류는 DSN, password, Authorization, cookie 값을 노출하지 않는다', () => {
  const message = safeError(new Error('postgresql://user:dsn-secret@db:5432/app password=pw-secret Authorization: Bearer token-secret cookie=cookie-secret'));
  for (const secret of ['user:dsn-secret', 'pw-secret', 'token-secret', 'cookie-secret']) assert.doesNotMatch(message, new RegExp(secret));
});

test('Dataset 검증은 운영 outbox를 seed 실패 조건으로 취급하지 않는다', () => {
  const service = readFileSync(join(root, 'datasets', 'service.js'), 'utf8');
  assert.doesNotMatch(service, /pending_outbox/);
  assert.match(service, /Dataset jobs neither truncate nor/);
});
