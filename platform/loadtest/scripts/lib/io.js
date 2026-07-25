import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const SECRET_KEY = /(authorization|password|token|cookie|secret|credential)/i;
const DEFAULT_MAX_BUFFER = 32 * 1024 * 1024;

export class LoadtestError extends Error {
  constructor(category, message) {
    super(message);
    this.name = 'LoadtestError';
    this.category = category;
  }
}

export function utcNow() {
  return new Date().toISOString();
}

export function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      SECRET_KEY.test(key) ? '[REDACTED]' : sanitize(item),
    ]));
  }
  if (typeof value === 'string') {
    return value
      .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
      .replace(/((?:authorization|cookie|set-cookie)\s*:\s*)([^\r\n]+)/gi, '$1[REDACTED]')
      .replace(/(["']?(?:password|token|cookie|secret|credential)["']?\s*:\s*["']?)([^"',\s}]+)/gi, '$1[REDACTED]')
      .replace(/(password|token|cookie|secret|credential)=([^\s&]+)/gi, '$1=[REDACTED]');
  }
  return value;
}

export function readJson(path) {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${path} JSON root must be an object`);
  }
  return value;
}

export function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(sanitize(value), null, 2)}\n`, 'utf8');
  renameSync(temporary, path);
}

export function run(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    input: options.input,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
  });
  if (result.error) throw new LoadtestError('environment', `${command} ${sanitize(args.join(' '))}: ${result.error.message}`);
  const output = { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  if (options.check !== false && output.code !== 0) {
    const detail = sanitize(output.stderr || output.stdout).slice(-1200);
    throw new LoadtestError(options.category ?? 'execution', `${command} exited ${output.code}: ${detail}`);
  }
  return output;
}

export function commandExists(name) {
  try {
    execFileSync('sh', ['-c', 'command -v "$1" >/dev/null', 'sh', name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function parseArgs(argv, specification) {
  const output = {};
  for (const [name, entry] of Object.entries(specification)) output[name] = entry.default;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new TypeError(`unexpected argument: ${token}`);
    const negated = token.startsWith('--no-');
    const key = (negated ? token.slice(5) : token.slice(2)).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const entry = specification[key];
    if (!entry) throw new TypeError(`unknown option: ${token}`);
    if (entry.type === 'boolean') {
      output[key] = !negated;
      continue;
    }
    if (negated) throw new TypeError(`${token} cannot be negated`);
    const raw = argv[index + 1];
    if (raw === undefined) throw new TypeError(`${token} requires a value`);
    index += 1;
    output[key] = entry.type === 'number' ? Number(raw) : raw;
    if (entry.type === 'number' && !Number.isFinite(output[key])) throw new TypeError(`${token} must be numeric`);
  }
  return output;
}
