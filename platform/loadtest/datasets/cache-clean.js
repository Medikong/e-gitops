#!/usr/bin/env node
import { existsSync, rmSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export function cacheDirectory(root, hash) {
  if (!/^[a-f0-9]{64}$/.test(String(hash))) throw new TypeError('CACHE_KEY must be a 64-character SHA-256 value');
  const directory = resolve(root, hash); const path = relative(resolve(root), directory);
  if (!path || path.startsWith('..') || path.includes('/')) throw new TypeError('cache cleanup target is outside the dataset cache root');
  return directory;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const directory = cacheDirectory(resolve(new URL('../tmp/datasets', import.meta.url).pathname), process.argv[2]);
  if (existsSync(directory)) rmSync(directory, { recursive: true });
  console.log(`dataset cache cleanup completed: ${directory}`);
}
