import { createHash, createHmac } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

export const COUPON_SECRET_FILE_NAME = 'coupon-codes.json';
export const DEFAULT_COUPON_SECRET_NAME = 'dropmong-loadtest-coupon-codes';
const CODE_PATTERN = /^[A-Z0-9-]{4,128}$/;
function key(value, label) {
  const encoded = Buffer.from(String(value));
  if (encoded.length < 32) throw new TypeError(`${label} must be at least 32 bytes`);
  return encoded;
}

export function couponCodeKey(index) {
  if (!Number.isSafeInteger(index) || index < 0) throw new TypeError('coupon code index must not be negative');
  return `code-${String(index).padStart(6, '0')}`;
}

export function couponCodeRef(secretName, index) {
  if (!String(secretName).trim()) throw new TypeError('coupon secret name must not be empty');
  return `secretFileRef:${secretName}/${COUPON_SECRET_FILE_NAME}#${couponCodeKey(index)}`;
}

export function couponCodeFingerprint(rawCode, hashKey) {
  const normalized = String(rawCode).replace(/\s/g, '').toUpperCase();
  if (!CODE_PATTERN.test(normalized)) throw new TypeError('load-test coupon codes contain unsupported characters');
  return createHmac('sha256', key(hashKey, 'coupon code hash key')).update(normalized).digest();
}

export function validateCouponSecretBundle(bundle, profile, seed, secretName = DEFAULT_COUPON_SECRET_NAME) {
  if (bundle?.schemaVersion !== 1 || bundle.secretName !== secretName || bundle.secretKey !== COUPON_SECRET_FILE_NAME) throw new TypeError('coupon secret metadata does not match');
  const identity = bundle.dataset ?? {};
  if (identity.profile !== profile.name || identity.profileHash !== profile.digest || identity.seedHash !== createHash('sha256').update(String(seed)).digest('hex')) throw new TypeError('coupon secret dataset identity does not match');
  const expected = Array.from({ length: profile.couponCodeCount }, (_, index) => couponCodeKey(index));
  if (!bundle.codes || Object.keys(bundle.codes).sort().join() !== expected.join()) throw new TypeError('coupon secret code keys do not match the profile');
  const values = Object.values(bundle.codes);
  if (values.some((value) => typeof value !== 'string' || !CODE_PATTERN.test(value)) || new Set(values).size !== values.length) throw new TypeError('coupon secret values are invalid or duplicated');
  return { ...bundle.codes };
}

export function loadCouponSecretFile(path, profile, seed, secretName = DEFAULT_COUPON_SECRET_NAME) {
  const mode = statSync(path).mode & 0o777;
  if (![0o400, 0o440, 0o600].includes(mode)) throw new TypeError(`coupon secret file permissions must be 0400, 0440, or 0600, got ${mode.toString(8).padStart(4, '0')}`);
  return validateCouponSecretBundle(JSON.parse(readFileSync(path, 'utf8')), profile, seed, secretName);
}
