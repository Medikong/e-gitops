#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, readJson, sanitize, utcNow, writeJsonAtomic } from './lib/io.js';

const SECRET_KEY = /(authorization|password|token|cookie|secret|credential)/i;
const REQUIRED_FIELDS = ['eventId', 'userId'];
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function selectEvents(manifest, start, count) {
  const events = manifest?.pools?.notificationEvents;
  if (!Array.isArray(events)) throw new TypeError('fixture manifest pools.notificationEvents must be an array');
  if (!Number.isInteger(start) || !Number.isInteger(count) || start < 0 || count <= 0 || start + count > events.length) {
    throw new RangeError(`notification event slice [${start}, ${start + count}) exceeds pool size ${events.length}`);
  }
  return events.slice(start, start + count).map((event, offset) => {
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new TypeError(`notificationEvents[${start + offset}] must be an object`);
    for (const field of REQUIRED_FIELDS) if (!(field in event)) throw new TypeError(`notificationEvents[${start + offset}] is missing ${field}`);
    const stack = [[`notificationEvents[${start + offset}]`, event]];
    while (stack.length) {
      const [path, value] = stack.pop();
      for (const [key, item] of Object.entries(value)) {
        if (SECRET_KEY.test(key)) throw new TypeError(`${path}.${key} contains a forbidden secret field`);
        if (item && typeof item === 'object') stack.push([`${path}.${key}`, item]);
      }
    }
    return event;
  });
}

async function waitForMarker(path, timeoutSeconds) {
  if (!path) return;
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`k6 start marker did not appear within ${timeoutSeconds}s`);
    await sleep(100);
  }
}

export async function produceEvents(events, { bootstrap, topic, durationSeconds }) {
  const child = spawn('kcat', ['-P', '-b', bootstrap, '-t', topic, '-K', '\t'], { stdio: ['pipe', 'inherit', 'inherit'] });
  const started = Date.now();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!child.stdin.write(`${event.eventId}\t${JSON.stringify(event)}\n`)) await new Promise((resolve) => child.stdin.once('drain', resolve));
    if (durationSeconds > 0 && index + 1 < events.length) {
      const wait = started + ((index + 1) * durationSeconds * 1000) / events.length - Date.now();
      if (wait > 0) await sleep(wait);
    }
  }
  child.stdin.end();
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  if (code !== 0) throw new Error(`kcat exited with code ${code}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    fixtureManifest: {}, bootstrap: {}, topic: { default: 'notification.requested' }, runId: {}, trialId: {},
    service: { default: 'notification-service' }, start: { type: 'number' }, count: { type: 'number' },
    durationSeconds: { type: 'number', default: 0 }, startMarker: { default: '' }, startTimeoutSeconds: { type: 'number', default: 120 }, reportDir: {},
  });
  await waitForMarker(args.startMarker, args.startTimeoutSeconds);
  const startedAt = utcNow();
  const events = selectEvents(readJson(args.fixtureManifest), args.start, args.count);
  await produceEvents(events, args);
  const result = { schema_version: 1, event: 'notification_kafka_ingress', run_id: args.runId, trial_id: args.trialId, service: args.service, topic: args.topic, fixture_range: { start: args.start, end: args.start + args.count }, produced_count: args.count, started_at: startedAt, finished_at: utcNow(), status: 'succeeded' };
  const destination = join(args.reportDir, 'raw', 'kafka', `${args.trialId}.json`);
  mkdirSync(dirname(destination), { recursive: true });
  writeJsonAtomic(destination, result);
  console.log(JSON.stringify(result));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(JSON.stringify({ event: 'notification_kafka_ingress', status: 'failed', message: sanitize(error.message) })); process.exitCode = 1; });
