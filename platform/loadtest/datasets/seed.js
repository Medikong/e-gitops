#!/usr/bin/env node
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { datasetAuthPasswordHash } from './auth.js';
import { loadProfile, expectedTableCounts } from './profile.js';
import { DatasetModel } from './model.js';
import { DATABASES, tableContracts } from './plans.js';
import { databaseCompatibility, liveSchemaHash, truncateService, generateService, validateService, analyzeService } from './service.js';
import { restoreService, snapshotService, validateServiceCache } from './cache.js';

const { Client } = pg;
const now = () => new Date().toISOString();
function envName(service) { return `DATASET_DATABASE_URL_${service.replaceAll('-', '_').toUpperCase()}`; }
export function safeError(error) { return String(error?.message ?? error).replace(/(postgres(?:ql)?:\/\/)[^@\s]+@/gi, '$1[redacted]@').replace(/\b(authorization)\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi, '$1=[redacted]').replace(/\b(cookie|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]'); }
function writeJson(path, value) { const temporary = `${path}.${process.pid}.tmp`; writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`); renameSync(temporary, path); }
async function mapLimit(values, limit, operation) { const results = new Array(values.length); let cursor = 0; await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => { while (cursor < values.length) { const index = cursor++; results[index] = await operation(values[index]); } })); return results; }

export async function seed(options) {
  const profileDocument = JSON.parse(options.profileJson); const profile = loadProfile(profileDocument); const services = options.services.split(',').map((value) => value.trim()).filter(Boolean);
  const unknown = services.filter((service) => !DATABASES[service]); if (unknown.length) throw new TypeError(`unsupported dataset services: ${unknown.join(', ')}`);
  const model = new DatasetModel(profile, options.seed, { authPasswordHash: datasetAuthPasswordHash(options.seed) });
  const expected = expectedTableCounts(profile); const runDirectory = resolve(options.outputDir, options.runId); mkdirSync(runDirectory, { recursive: true });
  const execution = { run_id: options.runId, status: 'running', started_at: now(), ended_at: null, dataset: { profile: profile.name, revision: options.revision, seed: String(options.seed), profile_sha256: profile.digest, schema_identifiers: options.schemaHashes }, cache: { key: options.cacheMode === 'snapshot' ? options.cacheKey : null, status: options.cacheMode === 'snapshot' ? 'unknown' : 'disabled', services: {} }, phases: {}, services: {}, total_actual_rows: 0, total_database_bytes: 0, total_snapshot_bytes: 0, total_seconds: 0 };
  const started = performance.now(); writeJson(join(runDirectory, 'execution.json'), execution);
  try {
    let cacheMutation = Promise.resolve();
    const mutateCache = (operation) => { const current = cacheMutation.then(operation, operation); cacheMutation = current.catch(() => {}); return current; };
    const results = await mapLimit(services, options.parallelism, async (service) => {
      const url = process.env[envName(service)]; if (!url) throw new TypeError(`${envName(service)} is required`);
      const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000 }); await client.connect();
      const serviceStarted = performance.now(); const contracts = tableContracts(service, model); const metric = { status: 'running', cache: null, generation_seconds: 0, copy_seconds: 0, snapshot_seconds: 0, restore_seconds: 0, truncate_seconds: 0, validation_seconds: 0, analyze_seconds: 0, rows: 0, database_bytes: 0, snapshot_bytes: 0, tables: {} };
      try {
        const compatibility = await databaseCompatibility(client); const schemaHash = await liveSchemaHash(client, contracts);
        const validation = options.cacheMode === 'snapshot'
          ? validateServiceCache(options.cacheDirectory, { hash: options.cacheKey, service, postgresMajor: compatibility.postgresMajor, schemaHash, contracts, expectedRows: expected[service], generatorRevision: options.generatorRevision })
          : { hit: false };
        await client.query('BEGIN');
        try {
          const truncateStarted = performance.now(); await truncateService(client, contracts, service); metric.truncate_seconds = (performance.now() - truncateStarted) / 1000;
          if (validation.hit) { const restored = await restoreService(client, options.cacheDirectory, validation.entry, contracts, service); metric.cache = 'hit'; metric.restore_seconds = restored.seconds; metric.tables = restored.tables; }
          else { const generated = await generateService(client, model, service, { batchRows: options.batchRows }); metric.generation_seconds = generated.generationSeconds; metric.copy_seconds = generated.copySeconds; metric.tables = generated.tables; metric.cache = options.cacheMode === 'snapshot' ? 'miss' : 'direct'; }
          const validationStarted = performance.now(); const counts = await validateService(client, service, expected[service]); metric.validation_seconds = (performance.now() - validationStarted) / 1000; metric.rows = Object.values(counts).reduce((sum, count) => sum + count, 0); metric.analyze_seconds = await analyzeService(client, contracts); metric.database_bytes = Number((await client.query('SELECT pg_database_size(current_database())::bigint AS bytes')).rows[0].bytes); await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        if (options.cacheMode === 'snapshot' && metric.cache === 'miss') { const snapshot = await mutateCache(() => snapshotService(client, options.cacheDirectory, { hash: options.cacheKey, service, postgresMajor: compatibility.postgresMajor, schemaHash, contracts, expectedRows: expected[service], generatorRevision: options.generatorRevision, dataset: execution.dataset })); metric.snapshot_seconds = snapshot.seconds; metric.snapshot_bytes = snapshot.bytes; }
        metric.status = 'success'; metric.total_seconds = (performance.now() - serviceStarted) / 1000; return [service, metric];
      } finally { await client.end(); }
    });
    execution.services = Object.fromEntries(results); execution.cache.services = Object.fromEntries(results.map(([service, value]) => [service, value.cache])); const statuses = new Set(results.map(([, value]) => value.cache)); execution.cache.status = statuses.size === 1 ? [...statuses][0] : 'mixed'; execution.total_actual_rows = results.reduce((sum, [, value]) => sum + value.rows, 0); execution.total_database_bytes = results.reduce((sum, [, value]) => sum + value.database_bytes, 0); execution.total_snapshot_bytes = results.reduce((sum, [, value]) => sum + value.snapshot_bytes, 0);
    execution.addressing = { strategy: 'deterministic-seed-addressing', serialized_address_data: false }; execution.status = 'success';
  } catch (error) { execution.status = 'failed'; execution.error = safeError(error); process.exitCode = 1; }
  execution.ended_at = now(); execution.total_seconds = (performance.now() - started) / 1000; writeJson(join(runDirectory, 'execution.json'), execution); if (execution.status !== 'success') throw new Error(execution.error); return execution;
}

function options(argv) { const parsed = parseArgs({ args: argv, options: { 'profile-json': { type: 'string' }, seed: { type: 'string' }, revision: { type: 'string' }, services: { type: 'string' }, 'cache-key': { type: 'string' }, 'cache-dir': { type: 'string' }, 'cache-mode': { type: 'string', default: 'snapshot' }, 'generator-revision': { type: 'string' }, 'schema-hashes': { type: 'string', default: '{}' }, 'output-dir': { type: 'string' }, 'run-id': { type: 'string' }, 'batch-rows': { type: 'string', default: '10000' }, parallelism: { type: 'string', default: '2' } }, strict: true }).values;
  for (const key of ['profile-json','seed','revision','services','cache-key','cache-dir','generator-revision','output-dir','run-id']) if (!parsed[key]) throw new TypeError(`--${key} is required`);
  if (!/^[a-f0-9]{64}$/.test(parsed['cache-key'])) throw new TypeError('--cache-key must be a SHA-256 hex value'); if (!['snapshot', 'direct'].includes(parsed['cache-mode'])) throw new TypeError('--cache-mode must be snapshot or direct'); const batchRows=Number(parsed['batch-rows']),parallelism=Number(parsed.parallelism); if(!Number.isSafeInteger(batchRows)||batchRows<10000||batchRows>50000)throw new TypeError('--batch-rows must be between 10000 and 50000');if(!Number.isSafeInteger(parallelism)||parallelism<1||parallelism>4)throw new TypeError('--parallelism must be between 1 and 4');
  return { profileJson:parsed['profile-json'],seed:parsed.seed,revision:parsed.revision,services:parsed.services,cacheKey:parsed['cache-key'],cacheDirectory:resolve(parsed['cache-dir'],parsed['cache-key']),cacheMode:parsed['cache-mode'],generatorRevision:parsed['generator-revision'],schemaHashes:JSON.parse(parsed['schema-hashes']),outputDir:parsed['output-dir'],runId:parsed['run-id'],batchRows,parallelism };
}
if (import.meta.url === `file://${process.argv[1]}`) seed(options(process.argv.slice(2))).catch((error) => { console.error(`dataset seed failed: ${safeError(error)}`); process.exitCode = 1; });
