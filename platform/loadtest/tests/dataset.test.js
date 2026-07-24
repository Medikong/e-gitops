import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { parse } from 'yaml';
import { datasetCacheKey, validateServiceCache } from '../datasets/cache.js';
import { couponCodeKey } from '../datasets/coupon-secret.js';
import { copyGeneratedTable, streamRowsToCopy } from '../datasets/copy.js';
import { assertSecretFreeManifest, buildFixtureManifest, WRITE_POOLS } from '../datasets/fixture-manifest.js';
import { DatasetModel } from '../datasets/model.js';
import { expectedTableCounts, loadProfile } from '../datasets/profile.js';
import { plansForService } from '../datasets/plans.js';
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

test('Coupon fixture는 기존 Secret 파일 참조만 보존하고 평문 코드를 넣지 않는다', () => {
  const document = parse(readFileSync(join(root, 'values', 'datasets', 'baseline-90days.yaml'), 'utf8')).dataset;
  const baseline = loadProfile({ name: document.profile, ...document.parameters });
  const manifest = buildFixtureManifest(baseline, document.seed, { couponSecretName: 'existing-dev-coupon-fixture' });
  assert.ok(manifest.pools.couponRedeem.every(({ codeRef }) => codeRef.startsWith('secretFileRef:existing-dev-coupon-fixture/')));
  assert.doesNotMatch(JSON.stringify(manifest), /DM-[A-Z0-9-]{8,}/);
});

test('dataset 초기화는 계약에 있는 데이터 테이블만 비우고 migration과 정책 테이블을 보존한다', async () => {
  for (const table of ['alembic_version', 'goose_db_version', 'auth_goose_db_version', 'auth_dev_goose_db_version', 'audit_goose_db_version', 'user_goose_db_version', 'coupon_goose_db_version']) assert.equal(isMigrationMetadataTable(table), true, table);
  assert.equal(isMigrationMetadataTable('auth_identities'), false);
  const statements = [];
  const client = { async query(statement) { statements.push(statement); return { rows: [] }; } };
  await truncateService(client, [{ table: 'auth_identities' }, { table: 'auth_policies' }, { table: 'alembic_version' }], 'auth-service');
  assert.deepEqual(statements, ['TRUNCATE TABLE "auth_identities" RESTART IDENTITY CASCADE']);
});

test('같은 seed의 행과 fixture는 결정론적이며 쓰기 pool은 중복되지 않는다', () => {
  const first = new DatasetModel(profile, smokeDocument.seed ?? '20260723');
  const second = new DatasetModel(profile, smokeDocument.seed ?? '20260723');
  const rows = (model) => Array.from(plansForService('catalog-service', model)).map((value) => Array.from(value.rows).slice(0, 3));
  assert.deepEqual(rows(first), rows(second));
  const manifest = buildFixtureManifest(profile, '20260723', { couponSecretName: 'existing-dev-coupon-fixture' });
  const repeated = buildFixtureManifest(profile, '20260723', { couponSecretName: 'existing-dev-coupon-fixture' });
  assert.deepEqual(manifest, repeated); assert.doesNotThrow(() => assertSecretFreeManifest(manifest));
  for (const pool of WRITE_POOLS) assert.equal(new Set(manifest.pools[pool].map((value) => JSON.stringify(value))).size, manifest.pools[pool].length, pool);
});

test('모든 서비스 generator가 예상 행 수와 column 계약을 지킨다', () => {
  const seed = '20260723';
  const couponCodes = Object.fromEntries(Array.from({ length: profile.couponCodeCount }, (_, index) => [couponCodeKey(index), `DM-TEST-${String(index).padStart(8, '0')}`]));
  const model = new DatasetModel(profile, seed, { authPasswordHash: 'test-only-password-hash', couponCodeHashKey: 'test-only-hash-key-000000000000000000', couponCodes });
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
