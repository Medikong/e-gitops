import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { finished, pipeline } from 'node:stream/promises';
import { from as copyFrom, to as copyTo } from 'pg-copy-streams';

export function sqlIdentifier(value) {
  if (!/^[a-z_][a-z0-9_]*$/.test(String(value))) throw new TypeError(`unsafe SQL identifier: ${value}`);
  return `"${value}"`;
}

function copyText(value) {
  if (value == null) return '\\N';
  if (typeof value === 'boolean') return value ? 't' : 'f';
  return String(value).replaceAll('\\', '\\\\').replaceAll('\t', '\\t').replaceAll('\n', '\\n').replaceAll('\r', '\\r');
}

export function encodeCopyRow(row) { return `${row.map(copyText).join('\t')}\n`; }

export async function streamRowsToCopy(stream, rows, { batchRows = 10_000 } = {}) {
  if (!Number.isSafeInteger(batchRows) || batchRows < 10_000 || batchRows > 50_000) throw new RangeError('COPY batchRows must be between 10000 and 50000');
  let count = 0; let batch = [];
  const flush = async () => { if (!batch.length) return; const chunk = batch.join(''); batch = []; if (!stream.write(chunk)) await once(stream, 'drain'); };
  try {
    for (const row of rows) { batch.push(encodeCopyRow(row)); count += 1; if (batch.length >= batchRows) await flush(); }
    await flush(); stream.end(); await finished(stream);
    return count;
  } catch (error) { stream.destroy(error); throw error; }
}

export async function copyGeneratedTable(client, table, columns, rows, options = {}) {
  const statement = `COPY ${sqlIdentifier(table)} (${columns.map(sqlIdentifier).join(', ')}) FROM STDIN WITH (FORMAT text)`;
  return streamRowsToCopy(client.query(copyFrom(statement)), rows, options);
}

export async function snapshotBinaryTable(client, table, columns, path) {
  const statement = `COPY ${sqlIdentifier(table)} (${columns.map(sqlIdentifier).join(', ')}) TO STDOUT WITH (FORMAT binary)`;
  await pipeline(client.query(copyTo(statement)), createWriteStream(path, { mode: 0o600 }));
}

export async function restoreBinaryTable(client, table, columns, path) {
  const statement = `COPY ${sqlIdentifier(table)} (${columns.map(sqlIdentifier).join(', ')}) FROM STDIN WITH (FORMAT binary)`;
  await pipeline(createReadStream(path), client.query(copyFrom(statement)));
}
