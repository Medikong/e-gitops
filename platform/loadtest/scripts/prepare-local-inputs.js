#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadExperiment } from '../scenarios/registry.js';
import { couponCodeKey } from '../datasets/coupon-secret.js';
import { loadProfile } from '../datasets/profile.js';

const SERVICE_NAMES = [
  'auth-service', 'user-service', 'catalog-service', 'coupon-service',
  'interest-service', 'order-service', 'payment-service', 'notification-service',
];
const DATASET_SECRET = 'dropmong-loadtest-dataset-input';
const AUTH_SECRET = 'dropmong-loadtest-auth-input';
const COUPON_SECRET = 'dropmong-loadtest-coupon-input';
const INPUT_VERSION = 'v5';

function fail(message) {
  throw new Error(message);
}

function command(name, args, { input = null, label = name } = {}) {
  const result = spawnSync(name, args, { encoding: 'utf8', input });
  if (result.error || result.status !== 0) fail(`${label} failed`);
  return result.stdout;
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function secretData(namespace, name, key) {
  const document = JSON.parse(command('kubectl', ['get', 'secret', name, '-n', namespace, '-o', 'json'], { label: `secret lookup for ${namespace}/${name}` }));
  const encoded = document.data?.[key];
  if (!encoded) fail(`database credential key is unavailable for ${namespace}/${name}`);
  return Buffer.from(encoded, 'base64').toString('utf8');
}

export function databaseUrlForNamespace(value, namespace) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('DATABASE_URL is not a valid URL');
  }
  // A service can resolve its own short database Service name, while the
  // Dataset Job runs in the load-test namespace and must use the full name.
  if (parsed.hostname && !parsed.hostname.includes('.') && parsed.hostname !== 'localhost') {
    parsed.hostname = `${parsed.hostname}.${namespace}.svc.cluster.local`;
    return parsed.toString();
  }
  return value;
}

function databaseUrl(experiment, service) {
  const namespace = experiment.services[service]?.namespace;
  if (!namespace) fail(`service namespace is unavailable for ${service}`);
  const deployment = JSON.parse(command('kubectl', ['get', 'deployment', service, '-n', namespace, '-o', 'json'], { label: `deployment lookup for ${service}` }));
  const env = deployment.spec?.template?.spec?.containers?.flatMap((container) => container.env ?? []) ?? [];
  const entry = env.find((item) => item.name === 'DATABASE_URL');
  if (!entry) fail(`DATABASE_URL is unavailable in ${service}`);
  if (typeof entry.value === 'string' && entry.value) return databaseUrlForNamespace(entry.value, namespace);
  const reference = entry.valueFrom?.secretKeyRef;
  if (!reference?.name || !reference?.key) fail(`DATABASE_URL secret reference is unavailable in ${service}`);
  return databaseUrlForNamespace(secretData(namespace, reference.name, reference.key), namespace);
}

function bcryptHash(password) {
  const output = command('htpasswd', ['-nbBC', '10', 'loadtest', password], { label: 'bcrypt password generation' });
  const hash = output.trim().replace(/^loadtest:/, '');
  if (!/^\$2[aby]\$\d\d\$/.test(hash)) fail('bcrypt password generation returned an unsupported hash');
  return hash;
}

function localContext(experiment) {
  if (experiment.environment.safety?.remote === true) fail('local input preparation is not available for remote environments');
  const context = command('kubectl', ['config', 'current-context'], { label: 'Kubernetes context lookup' }).trim();
  const allowed = experiment.environment.kubernetesContext?.allowedNames ?? [];
  if (!allowed.includes(context)) fail('current Kubernetes context is not approved by the local RUN');
  return context;
}

function sameDatasetIdentity(namespace, profileHash, seedHash) {
  for (const name of [DATASET_SECRET, AUTH_SECRET, COUPON_SECRET]) {
    const result = spawnSync('kubectl', ['get', 'secret', name, '-n', namespace, '-o', 'json'], { encoding: 'utf8' });
    if (result.error || result.status !== 0) return false;
    const annotations = JSON.parse(result.stdout).metadata?.annotations ?? {};
    if (annotations['loadtest.dropmong.io/profile-hash'] !== profileHash
      || annotations['loadtest.dropmong.io/seed-hash'] !== seedHash
      || annotations['loadtest.dropmong.io/input-version'] !== INPUT_VERSION
      || !/^[a-f0-9]{64}$/.test(annotations['loadtest.dropmong.io/auth-credential-fingerprint'] ?? '')) return false;
  }
  return true;
}

function applySecret(namespace, name, sourceArgs, tempDir, annotations) {
  const manifest = command('kubectl', [
    'create', 'secret', 'generic', name, '-n', namespace,
    ...sourceArgs,
    '--dry-run=client', '-o', 'yaml',
  ], { label: `secret manifest for ${name}` });
  command('kubectl', ['apply', '-f', '-'], { input: manifest, label: `secret apply for ${name}` });
  for (const [key, value] of Object.entries(annotations)) {
    command('kubectl', ['annotate', 'secret', name, '-n', namespace, `${key}=${value}`, '--overwrite'], { label: `secret annotation for ${name}` });
  }
  return tempDir;
}

function couponBundle(profile, seed) {
  const codes = Object.fromEntries(Array.from({ length: profile.couponCodeCount }, (_, index) => [
    couponCodeKey(index),
    `LT-${randomBytes(12).toString('hex').toUpperCase()}`,
  ]));
  return {
    schemaVersion: 1,
    secretName: COUPON_SECRET,
    secretKey: 'coupon-codes.json',
    dataset: {
      profile: profile.name,
      profileHash: profile.digest,
      seedHash: createHash('sha256').update(String(seed)).digest('hex'),
    },
    codes,
  };
}

function prepare(experiment) {
  localContext(experiment);
  const namespace = experiment.environment.loadtestNamespace;
  if (!namespace) fail('environment.loadtestNamespace is required for local input preparation');
  // Data-plane policies already admit namespaces carrying this label. Label the
  // persistent local namespace before checking the input cache so a cache hit
  // cannot leave Dataset Jobs without their intended access contract.
  const namespaceManifest = command('kubectl', ['create', 'namespace', namespace, '--dry-run=client', '-o', 'yaml'], { label: 'loadtest namespace manifest' });
  command('kubectl', ['apply', '-f', '-'], { input: namespaceManifest, label: 'loadtest namespace apply' });
  command('kubectl', ['label', 'namespace', namespace, 'app.kubernetes.io/component=loadtest', '--overwrite'], { label: 'loadtest namespace label' });
  const profile = loadProfile(experiment.dataset.profileDocument);
  const seedHash = createHash('sha256').update(String(experiment.dataset.seed)).digest('hex');
  if (sameDatasetIdentity(namespace, profile.digest, seedHash)) return 'reused';

  const tempDir = mkdtempSync(join(tmpdir(), 'dropmong-loadtest-inputs-'));
  try {
    const password = randomBytes(24).toString('base64url');
    const authHash = bcryptHash(password);
    const credentialFingerprint = createHash('sha256').update(authHash).digest('hex');
    const hashKey = randomBytes(32).toString('base64url');
    const datasetEntries = {
      DATASET_AUTH_PASSWORD_HASH: authHash,
      DATASET_AUTH_PASSWORD_REF: `secretRef:${AUTH_SECRET}/LOADTEST_AUTH_PASSWORD`,
      DATASET_COUPON_CODE_HASH_KEY: hashKey,
      KAFKA_BOOTSTRAP_SERVERS: 'kafka.dropmong-messaging.svc.cluster.local:9092',
    };
    for (const service of SERVICE_NAMES) datasetEntries[`DATASET_DATABASE_URL_${service.replaceAll('-', '_').toUpperCase()}`] = databaseUrl(experiment, service);
    const datasetPath = join(tempDir, 'dataset.env');
    const authPath = join(tempDir, 'auth.env');
    const couponPath = join(tempDir, 'coupon-codes.json');
    writeFileSync(datasetPath, `${Object.entries(datasetEntries).map(([key, value]) => `${key}=${value}`).join('\n')}\n`, { mode: 0o600 });
    writeFileSync(authPath, `LOADTEST_AUTH_PASSWORD=${password}\n`, { mode: 0o600 });
    writeFileSync(couponPath, JSON.stringify(couponBundle(profile, experiment.dataset.seed)), { mode: 0o600 });
    const annotations = {
      'loadtest.dropmong.io/profile-hash': profile.digest,
      'loadtest.dropmong.io/seed-hash': seedHash,
      'loadtest.dropmong.io/input-version': INPUT_VERSION,
      // The fingerprint changes cache identity without writing a password or
      // bcrypt value into the cache manifest or any result artifact.
      'loadtest.dropmong.io/auth-credential-fingerprint': credentialFingerprint,
    };
    applySecret(namespace, DATASET_SECRET, [`--from-env-file=${datasetPath}`], tempDir, annotations);
    applySecret(namespace, AUTH_SECRET, [`--from-env-file=${authPath}`], tempDir, annotations);
    applySecret(namespace, COUPON_SECRET, [`--from-file=coupon-codes.json=${couponPath}`], tempDir, annotations);
    return 'prepared';
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runPath = argument('--run');
  if (!runPath) fail('--run is required');
  const experiment = loadExperiment(resolve(runPath));
  const action = prepare(experiment);
  console.log(`local Dataset/k6 input references ${action} for RUN=${experiment.run.name}`);
}
