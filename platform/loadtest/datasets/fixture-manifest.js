import { canonicalJson } from './profile.js';
import { coprimeStep, DatasetModel, iso } from './model.js';
import { couponCodeRef, DEFAULT_COUPON_SECRET_NAME } from './coupon-secret.js';

export const WRITE_POOLS = ['profileWrite', 'interestAdd', 'existingInterests', 'viewEvents', 'orderCreate', 'orderCancel', 'paymentReady', 'couponClaim', 'couponRedeem', 'notificationEvents', 'webCheckouts'];

export function sampledIndices(model, purpose, size, count) {
  if (size <= 0 || count <= 0) return [];
  const wanted = Math.min(size, count);
  const offset = model.stableInt(`fixture-${purpose}-offset`, 0, size);
  const step = coprimeStep(size, model.stableInt(`fixture-${purpose}-step`, 0, size));
  return Array.from({ length: wanted }, (_, index) => (offset + step * index) % size);
}

export function trialSlices(length, trialCount) {
  if (!Number.isSafeInteger(trialCount) || trialCount <= 0) throw new TypeError('trialCount must be positive');
  const base = Math.floor(length / trialCount); const remainder = length % trialCount; let start = 0;
  return Array.from({ length: trialCount }, (_, sliceIndex) => { const count = base + Number(sliceIndex < remainder); const value = { sliceIndex, start, endExclusive: start + count, count }; start += count; return value; });
}

function existingInterestPool(model, limit) {
  const counts = Array.from({ length: model.profile.dropCount }, (_, index) => model.profile.interestsForDrop(index));
  const prefixes = model.prefixes(counts);
  return sampledIndices(model, 'existing-interests', prefixes.at(-1), limit).map((ordinal) => {
    let dropIndex = 0; while (prefixes[dropIndex + 1] <= ordinal) dropIndex += 1;
    return { userId: model.user(model.memberIndex('interest-user', dropIndex, ordinal - prefixes[dropIndex])), dropId: model.drop(dropIndex) };
  });
}

function newInterestPool(model, limit) {
  const profile = model.profile; const capacity = Array.from({ length: profile.dropCount }, (_, index) => profile.userCount - profile.interestsForDrop(index)).reduce((a, b) => a + b, 0);
  const wanted = Math.min(limit, capacity); const dropOrder = sampledIndices(model, 'interest-add-drops', profile.dropCount, profile.dropCount); const perDrop = new Map(); const result = [];
  for (let cursor = 0; result.length < wanted; cursor += 1) {
    const dropIndex = dropOrder[cursor % dropOrder.length]; const extra = perDrop.get(dropIndex) ?? 0; const existing = profile.interestsForDrop(dropIndex);
    if (existing + extra < profile.userCount) { result.push({ userId: model.user(model.memberIndex('interest-user', dropIndex, existing + extra)), dropId: model.drop(dropIndex) }); perDrop.set(dropIndex, extra + 1); }
  }
  return result;
}

function cancelOrderPool(model, limit) {
  const result = [];
  for (const index of sampledIndices(model, 'order-cancel', model.profile.orderCount, model.profile.orderCount)) { const fact = model.orderFact(index); if (fact.approved) result.push({ userId: fact.userId, orderId: fact.orderId }); if (result.length >= limit) break; }
  return result;
}

function couponWalletPool(model, limit) {
  const profile = model.profile; const available = [];
  for (let index = profile.couponRedemptionCount; index < profile.userCouponCount; index += 1) { const createdAt = new Date(profile.serviceStart.getTime() + Math.floor(index * profile.days * 86_400_000 / Math.max(1, profile.userCouponCount))); if (!(index % 10 === 0 && createdAt < new Date(profile.asOf.getTime() - 30 * 86_400_000))) available.push(index); }
  return sampledIndices(model, 'coupon-wallet', available.length, limit).map((index) => ({ userId: model.user(model.couponUserIndex(available[index])), userCouponId: model.userCoupon(available[index]) }));
}

function notificationReadPool(model, limit) {
  const seen = new Set(); const result = [];
  for (const index of sampledIndices(model, 'notification-read', model.profile.orderCount, model.profile.orderCount)) { const userId = model.orderFact(index).userId; if (!seen.has(userId)) { seen.add(userId); result.push({ userId }); } if (result.length >= limit) break; }
  return result;
}

function checkoutId(dropId, productId, option, quantity) { return `dev.${Buffer.from(canonicalJson({ dropId, option, productId, quantity })).toString('base64url')}`; }

function webCheckoutPool(model, limit) {
  const options = ['S', 'M', 'L', 'XL']; const profile = model.profile; const productOrder = sampledIndices(model, 'web-checkout-products', profile.productCount, profile.productCount); const wanted = Math.min(limit, profile.productCount * 40);
  return Array.from({ length: wanted }, (_, ordinal) => { const productIndex = productOrder[ordinal % productOrder.length]; const variant = Math.floor(ordinal / productOrder.length); const dropId = model.drop(Math.floor(productIndex / profile.productsPerDrop)); const productId = model.product(productIndex); const option = options[variant % options.length]; const quantity = 1 + Math.floor(variant / options.length); return { checkoutId: checkoutId(dropId, productId, option, quantity), dropId, productId, quantity }; });
}

export function assertSecretFreeManifest(value) {
  const forbidden = new Set(['password', 'accesstoken', 'refreshtoken', 'authorization', 'cookie', 'clientsecret']);
  const visit = (item, path) => { if (Array.isArray(item)) item.forEach((child, index) => visit(child, `${path}[${index}]`)); else if (item && typeof item === 'object') Object.entries(item).forEach(([key, child]) => { if (forbidden.has(key.replaceAll('_', '').toLowerCase())) throw new TypeError(`fixture manifest contains secret field: ${path}.${key}`); visit(child, `${path}.${key}`); }); else if (typeof item === 'string' && item.toLowerCase().startsWith('bearer ')) throw new TypeError(`fixture manifest contains Authorization material: ${path}`); };
  visit(value, 'manifest');
}

export function buildFixtureManifest(profile, seed, { authPasswordRef = null, couponSecretName = null } = {}) {
  const model = new DatasetModel(profile, seed); const limit = profile.fixturePoolSize;
  const drops = sampledIndices(model, 'drops', profile.dropCount, limit).map((dropIndex) => ({ dropId: model.drop(dropIndex), productIds: Array.from({ length: profile.productsPerDrop }, (_, offset) => model.product(dropIndex * profile.productsPerDrop + offset)) }));
  const historical = sampledIndices(model, 'order-read', profile.orderCount, limit).map((index) => model.orderFact(index));
  const ready = sampledIndices(model, 'payment-ready', profile.paymentReadyOrderCount, limit).map((index) => model.paymentReadyOrderFact(index));
  const couponClaim = sampledIndices(model, 'coupon-claim', profile.couponClaimHeadroom, limit).map((index) => { const [campaign, user] = model.couponClaimTarget(index); return { userId: model.user(user), campaignId: model.campaign(campaign) }; });
  const pools = {
    authUsers: sampledIndices(model, 'auth-users', profile.userCount, limit).map((index) => ({ userId: model.user(index), email: `loadtest-${model.token}-${String(index).padStart(6, '0')}@example.invalid` })),
    profileRead: sampledIndices(model, 'profile-read', profile.userCount, limit).map((index) => ({ userId: model.user(index), version: 1 })),
    profileWrite: sampledIndices(model, 'profile-write', profile.userCount, limit).map((index) => ({ userId: model.user(index), version: 1 })),
    drops, existingInterests: existingInterestPool(model, limit), interestAdd: newInterestPool(model, limit),
    viewEvents: sampledIndices(model, 'view-events', profile.dropCount * profile.userCount, limit).map((index) => ({ userId: model.user(index % profile.userCount), dropId: model.drop(Math.floor(index / profile.userCount)) })),
    orderCreate: sampledIndices(model, 'order-create-users', profile.userCount, limit).map((userIndex, index) => ({ userId: model.user(userIndex), dropId: drops[index % drops.length].dropId, productId: drops[index % drops.length].productIds[index % profile.productsPerDrop], quantity: 1 })),
    orderRead: historical.map((fact) => ({ userId: fact.userId, orderId: fact.orderId })), orderCancel: cancelOrderPool(model, limit),
    paymentReady: ready.map((fact) => ({ userId: fact.userId, orderId: fact.orderId, amount: fact.amount })), paymentRead: historical.map((fact) => ({ userId: fact.userId, paymentId: fact.paymentId })),
    couponClaim, couponWallet: couponWalletPool(model, limit), couponRedeem: sampledIndices(model, 'coupon-code', profile.couponCodeCount, limit).map((index) => {
      const [, user] = model.couponCodeTarget(index);
      return { userId: model.user(user), codeRef: couponSecretName ? couponCodeRef(couponSecretName, index) : null };
    }),
    notificationRead: notificationReadPool(model, limit),
    notificationEvents: sampledIndices(model, 'notification-events', profile.orderCount, limit).map((index, ordinal) => { const fact = model.orderFact(index); const eventId = model.uuid('notification-load-event', ordinal); return { schemaVersion: 1, eventId, eventType: 'notification.requested', userId: fact.userId, sourceId: `loadtest:${model.token}`, notificationId: model.uuid('notification-load', ordinal), orderId: fact.orderId, notificationType: 'ORDER_CONFIRMED', channel: 'IN_APP', title: 'Load test notification', message: `Load test notification for ${fact.orderId}`, occurredAt: iso(new Date(profile.asOf.getTime() + ordinal)), producer: 'dropmong-loadtest-seeder', correlationId: eventId }; }),
    webProducts: drops.map(({ dropId, productIds }) => ({ dropId, productId: productIds[0] })), webCheckouts: webCheckoutPool(model, limit),
  };
  const manifest = { manifestVersion: 1, dataset: { profile: profile.name, seed: String(seed), profileHash: profile.digest }, credentials: { authPasswordRef }, allocation: { strategy: 'deterministic-contiguous-index-ranges', independentTrialReset: 'restore-service-snapshot-and-reset-offset', reusePolicy: 'forbidden-without-restore', exhaustionPolicy: 'fail', capacity: Object.fromEntries(WRITE_POOLS.map((name) => [name, pools[name].length])), trialSlices: Object.fromEntries(WRITE_POOLS.map((name) => [name, trialSlices(pools[name].length, profile.fixtureTrialCount)])) }, pools, constraints: { couponRedeemCodeMaterial: 'kubernetes-secret-file-required', couponSecretFileMode: '0400-or-0440', paymentReadyTerminalPayment: 'absent', statefulPoolsMustNotBeReusedAcrossTrials: true } };
  assertSecretFreeManifest(manifest); return manifest;
}

export function requireFixtureCapacity(manifest, pool, { start, occurrences, stride = 1 }) {
  if (start < 0 || occurrences < 0 || stride <= 0) throw new RangeError('fixture allocation values are invalid'); const capacity = manifest.pools?.[pool]?.length; if (!Number.isSafeInteger(capacity)) throw new TypeError(`fixture pool ${pool} is missing`); const endExclusive = occurrences === 0 ? start : start + (occurrences - 1) * stride + 1; if (start > capacity || endExclusive > capacity) throw new RangeError(`fixture pool ${pool} exhausted: required end ${endExclusive}, capacity ${capacity}; restore before this independent trial`); return { pool, start, occurrences, stride, endExclusive, capacity };
}
