import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { canonicalJson } from './profile.js';
import { restoreBinaryTable, snapshotBinaryTable } from './copy.js';

export const CACHE_SCHEMA_VERSION = 'dropmong.loadtest.dataset-cache/v1';

export function datasetCacheKey({ dataset, seed, revision, generatorRevision, schemaIdentifiers, credentialFingerprint = null }) {
  const identity = { dataset, seed: String(seed), revision, generatorRevision, schemaIdentifiers };
  if (credentialFingerprint) identity.credentialFingerprint = credentialFingerprint;
  return createHash('sha256').update(canonicalJson(identity)).digest('hex');
}

export function fileSha256(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
export function manifestPath(cacheDirectory) { return join(cacheDirectory, 'manifest.json'); }

export function readCacheManifest(cacheDirectory) {
  const value = JSON.parse(readFileSync(manifestPath(cacheDirectory), 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('cache manifest root must be an object');
  return value;
}

export function validateCacheFiles(cacheDirectory, { hash, generatorRevision }) {
  const manifest = readCacheManifest(cacheDirectory);
  if (manifest.schemaVersion !== CACHE_SCHEMA_VERSION || manifest.hash !== hash || manifest.generatorRevision !== generatorRevision) throw new TypeError('cache manifest identity does not match');
  for (const [service, serviceEntry] of Object.entries(manifest.services ?? {})) {
    const directory = join(cacheDirectory, 'databases', service);
    for (const tableEntry of Object.values(serviceEntry.tables ?? {})) {
      const path = safeFile(directory, tableEntry.file);
      if (statSync(path).size !== tableEntry.bytes || fileSha256(path) !== tableEntry.sha256) throw new TypeError(`${service} cache file checksum does not match`);
    }
  }
  return manifest;
}

function atomicJson(path, value) { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); const temporary = `${path}.${process.pid}.tmp`; writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); renameSync(temporary, path); }

function safeFile(directory, relative) { const path = resolve(directory, String(relative)); if (dirname(path) !== resolve(directory)) throw new TypeError('cache table path escapes service directory'); return path; }

export function validateServiceCache(cacheDirectory, { hash, service, postgresMajor, schemaHash, contracts, expectedRows, generatorRevision }) {
  let manifest;
  try { manifest = readCacheManifest(cacheDirectory); } catch (error) { return { hit: false, reason: `manifest_unavailable:${error.code ?? error.name}` }; }
  if (manifest.schemaVersion !== CACHE_SCHEMA_VERSION || manifest.hash !== hash || manifest.generatorRevision !== generatorRevision) return { hit: false, reason: 'manifest_identity_mismatch' };
  const entry = manifest.services?.[service];
  if (!entry || String(entry.postgresqlMajor) !== String(postgresMajor) || entry.schemaHash !== schemaHash) return { hit: false, reason: 'service_compatibility_mismatch' };
  if (Object.keys(entry.tables ?? {}).sort().join() !== contracts.map(({ table }) => table).sort().join()) return { hit: false, reason: 'table_contract_mismatch' };
  const directory = join(cacheDirectory, 'databases', service);
  try {
    for (const { table, columns } of contracts) {
      const tableEntry = entry.tables[table]; const path = safeFile(directory, tableEntry?.file);
      if (tableEntry.rows !== expectedRows[table] || canonicalJson(tableEntry.columns) !== canonicalJson(columns) || statSync(path).size !== tableEntry.bytes || fileSha256(path) !== tableEntry.sha256) throw new TypeError(`invalid ${table}`);
    }
  } catch { return { hit: false, reason: 'file_checksum_or_contract_mismatch' }; }
  return { hit: true, manifest, entry };
}

export async function snapshotService(client, cacheDirectory, metadata) {
  const finalDirectory = join(cacheDirectory, 'databases', metadata.service); const temporary = `${finalDirectory}.${process.pid}.tmp`;
  rmSync(temporary, { recursive: true, force: true }); mkdirSync(temporary, { recursive: true, mode: 0o700 });
  const tables = {}; let totalBytes = 0; let totalSeconds = 0;
  try {
    for (const { table, columns } of metadata.contracts) { const path = join(temporary, `${table}.bin`); const started = performance.now(); await snapshotBinaryTable(client, table, columns, path); const seconds = (performance.now() - started) / 1000; const bytes = statSync(path).size; totalBytes += bytes; totalSeconds += seconds; tables[table] = { file: `${table}.bin`, columns, rows: metadata.expectedRows[table], sha256: fileSha256(path), bytes, snapshotSeconds: seconds }; }
    const previous = (() => { try { return readCacheManifest(cacheDirectory); } catch { return null; } })();
    const timestamp = new Date().toISOString();
    const manifest = previous?.hash === metadata.hash && previous?.generatorRevision === metadata.generatorRevision ? previous : { schemaVersion: CACHE_SCHEMA_VERSION, hash: metadata.hash, generatorRevision: metadata.generatorRevision, dataset: metadata.dataset, createdAt: timestamp, services: {} };
    manifest.services[metadata.service] = { postgresqlMajor: String(metadata.postgresMajor), schemaHash: metadata.schemaHash, tables };
    manifest.updatedAt = timestamp;
    rmSync(finalDirectory, { recursive: true, force: true }); renameSync(temporary, finalDirectory); atomicJson(manifestPath(cacheDirectory), manifest);
    return { seconds: totalSeconds, bytes: totalBytes, tables };
  } catch (error) { rmSync(temporary, { recursive: true, force: true }); throw error; }
}

export async function restoreService(client, cacheDirectory, serviceEntry, contracts, service) {
  const directory = join(cacheDirectory, 'databases', service); const metrics = {}; let totalSeconds = 0;
  for (const { table, columns } of contracts) { const started = performance.now(); await restoreBinaryTable(client, table, columns, safeFile(directory, serviceEntry.tables[table].file)); const seconds = (performance.now() - started) / 1000; totalSeconds += seconds; metrics[table] = { restoreSeconds: seconds, rows: serviceEntry.tables[table].rows }; }
  return { seconds: totalSeconds, tables: metrics };
}
