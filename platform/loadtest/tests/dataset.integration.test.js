import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { copyGeneratedTable } from '../datasets/copy.js';
import { restoreService, snapshotService, validateServiceCache } from '../datasets/cache.js';

const dockerAvailable = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
const docker = (args, check = true) => { const result = spawnSync('docker', args, { encoding: 'utf8' }); if (check && result.status !== 0) throw new Error(result.stderr || result.stdout); return result.stdout.trim(); };

test('작은 PostgreSQL fixture에서 miss snapshot 후 binary COPY로 원래 행을 복원한다', { skip: !dockerAvailable, timeout: 60_000 }, async () => {
  const name = `dropmong-dataset-test-${process.pid}`; const cache = mkdtempSync(join(tmpdir(), 'dropmong-dataset-integration-')); let client;
  try {
    docker(['run','-d','--rm','--name',name,'-e','POSTGRES_PASSWORD=fixture-test-only','-p','127.0.0.1::5432','postgres:16-alpine']);
    const port = docker(['port',name,'5432/tcp']).split(':').at(-1); const connectionString = `postgresql://postgres:fixture-test-only@127.0.0.1:${port}/postgres`;
    const readyDeadline = Date.now() + 30_000;
    while (Date.now() < readyDeadline) {
      const candidate = new pg.Client({ connectionString, connectionTimeoutMillis: 1_000 });
      try { await candidate.connect(); client = candidate; break; }
      catch { await candidate.end().catch(() => {}); await new Promise((resolve)=>setTimeout(resolve,250)); }
    }
    assert.ok(client, 'PostgreSQL did not become ready'); await client.query('CREATE TABLE fixture_items (id integer PRIMARY KEY, value text NOT NULL)');
    const columns=['id','value'],contracts=[{table:'fixture_items',columns}],expectedRows={fixture_items:3}; await copyGeneratedTable(client,'fixture_items',columns,[[1,'one'],[2,'two'],[3,'three']],{batchRows:10_000});
    const metadata={hash:'b'.repeat(64),service:'fixture-service',postgresMajor:16,schemaHash:'fixture-schema',contracts,expectedRows,generatorRevision:'fixture-generator',dataset:{profile:'fixture'}}; await snapshotService(client,cache,metadata);
    const validation=validateServiceCache(cache,{...metadata}); assert.equal(validation.hit,true); await client.query("TRUNCATE fixture_items; INSERT INTO fixture_items VALUES (99,'changed')"); await client.query('BEGIN'); await client.query('TRUNCATE fixture_items'); await restoreService(client,cache,validation.entry,contracts,'fixture-service'); await client.query('COMMIT');
    assert.deepEqual((await client.query('SELECT id,value FROM fixture_items ORDER BY id')).rows,[{id:1,value:'one'},{id:2,value:'two'},{id:3,value:'three'}]); assert.equal(validateServiceCache(cache,{...metadata}).hit,true);
  } finally { if(client)await client.end(); docker(['stop',name],false); rmSync(cache,{recursive:true,force:true}); }
});
