#!/usr/bin/env node
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildRunReport } from '../scenarios/service-static-replica-capacity-load-test/report.js';
import { LoadtestError, parseArgs, run, sanitize } from './lib/io.js';

export function safeRunId(value) {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value ?? '')) throw new TypeError('run ID must be a lowercase Kubernetes-safe name');
  return value;
}

function ownedNamespace(runId, namespace) {
  const document = JSON.parse(run('kubectl', ['get', 'namespace', namespace, '-o', 'json']).stdout);
  if (document.metadata?.labels?.['loadtest.dropmong.io/run-id'] !== runId) throw new LoadtestError('artifact', 'namespace run-id label does not match');
}

function findOwnedResource(namespace, runId, kind, role) {
  const selector = `loadtest.dropmong.io/run-id=${runId},loadtest.dropmong.io/role=${role}`;
  const items = JSON.parse(run('kubectl', ['get', kind, '-n', namespace, '-l', selector, '-o', 'json']).stdout).items ?? [];
  return items;
}

export function exportRun(runId, outputRoot) {
  const namespace = `dropmong-loadtest-${runId}`.slice(0, 63).replace(/-$/, '');
  ownedNamespace(runId, namespace);
  const pods = findOwnedResource(namespace, runId, 'pods', 'artifact-export');
  const ready = pods.find((pod) => pod.status?.conditions?.some((condition) => condition.type === 'Ready' && condition.status === 'True'));
  if (!ready) throw new LoadtestError('artifact', 'ready artifact export Pod was not found');
  const destination = join(resolve(outputRoot), runId);
  mkdirSync(destination, { recursive: true });
  const temporary = mkdtempSync(join(tmpdir(), 'dropmong-loadtest-export-'));
  try {
    const copied = join(temporary, 'run');
    run('kubectl', ['cp', '-n', namespace, `${ready.metadata.name}:/loadtest/reports/${runId}/.`, copied]);
    run('cp', ['-R', `${copied}/.`, destination]);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
  const result = buildRunReport(destination);
  console.log(JSON.stringify({ event: 'loadtest_export', run_id: runId, path: destination, status: result.run.status }));
  return result.run.status === 'pass' ? 0 : result.run.status === 'fail' ? 2 : 3;
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { runId: {}, outputRoot: { default: new URL('../reports/local', import.meta.url).pathname } });
  process.exitCode = exportRun(safeRunId(args.runId), args.outputRoot);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(`${error.category ?? 'artifact'}: ${sanitize(error.message)}`); process.exitCode = 1; });
