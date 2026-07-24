import { createHash } from 'node:crypto';
import { canonicalJson } from './profile.js';

const UUID_URL_NAMESPACE = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex');

function uuidBuffer(value) {
  return Buffer.from(value.replaceAll('-', ''), 'hex');
}

function uuid5(namespace, name) {
  const digest = createHash('sha1').update(namespace).update(name).digest().subarray(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function gcd(first, second) {
  let a = Math.abs(first); let b = Math.abs(second);
  while (b) [a, b] = [b, a % b];
  return a;
}

export function coprimeStep(size, candidate) {
  if (size <= 1) return 1;
  let step = Math.max(1, candidate % size);
  while (gcd(step, size) !== 1) { step = (step + 1) % size; if (step === 0) step = 1; }
  return step;
}

export function iso(value) { return new Date(value).toISOString().replace('.000Z', 'Z'); }
export function compactJson(value) { return canonicalJson(value); }
export function addMilliseconds(value, milliseconds) { return new Date(value.getTime() + milliseconds); }

export class DatasetModel {
  constructor(profile, seed, secrets = {}) {
    this.profile = profile;
    this.seed = String(seed);
    this.namespace = uuidBuffer(uuid5(UUID_URL_NAMESPACE, `dropmong:${profile.name}:${this.seed}`));
    this.token = createHash('sha256').update(this.seed).digest('hex').slice(0, 8);
    this.authPasswordHash = secrets.authPasswordHash ?? null;
    this.couponCodeHashKey = secrets.couponCodeHashKey ?? null;
    this.couponCodes = secrets.couponCodes ?? {};
    this.orderPrefixes = this.prefixes([...Array(profile.dropCount).keys()].map((index) => profile.ordersForDrop(index)));
    this.viewPrefixes = this.prefixes([...Array(profile.dropCount).keys()].map((index) => profile.tierForDrop(index).viewsPerDrop));
    this.soldCache = null; this.reservedCache = null;
  }

  prefixes(counts) { const values = [0]; for (const count of counts) values.push(values.at(-1) + count); return values; }
  uuid(kind, index) { return uuid5(this.namespace, `${kind}:${index}`); }
  user(index) { return this.uuid('user', index); }
  identity(index) { return this.uuid('identity', index); }
  identityLink(index) { return this.uuid('identity-link', index); }
  drop(index) { return `drop-${this.token}-${String(index).padStart(6, '0')}`; }
  product(index) { return `product-${this.token}-${String(index).padStart(7, '0')}`; }
  order(index) { return `order-${this.token}-${String(index).padStart(8, '0')}`; }
  payment(index) { return `payment-${this.token}-${String(index).padStart(8, '0')}`; }
  campaign(index) { return `camp_${this.token}_${String(index).padStart(6, '0')}`; }
  issueRequest(index) { return `ireq_${this.token}_${String(index).padStart(8, '0')}`; }
  userCoupon(index) { return `ucpn_${this.token}_${String(index).padStart(8, '0')}`; }
  redemption(index) { return `redm_${this.token}_${String(index).padStart(8, '0')}`; }
  notification(index) { return `notification-${this.token}-${String(index).padStart(9, '0')}`; }

  stableInt(purpose, index, modulus) {
    if (modulus <= 0) return 0;
    const bytes = createHash('sha256').update(`${this.seed}:${purpose}:${index}`).digest().subarray(0, 8);
    return Number(bytes.readBigUInt64BE() % BigInt(modulus));
  }

  memberIndex(purpose, ownerIndex, memberIndex) {
    const size = this.profile.userCount;
    const offset = this.stableInt(`${purpose}-offset`, ownerIndex, size);
    const step = coprimeStep(size, this.stableInt(`${purpose}-step`, ownerIndex, size));
    return (offset + step * memberIndex) % size;
  }

  userCreatedAt(index) {
    if (index < this.profile.initialUsers) return this.profile.serviceStart;
    const offset = index - this.profile.initialUsers;
    const day = Math.min(this.profile.days - 1, Math.floor(offset / this.profile.dailyNewUsers));
    return addMilliseconds(this.profile.serviceStart, day * 86_400_000 + (offset % 86_400) * 1000);
  }
  dropOpensAt(index) { return addMilliseconds(this.profile.serviceStart, (Math.floor(index / this.profile.dailyDrops) * 86_400 + (index % this.profile.dailyDrops) * 3600) * 1000); }
  productPrice(index) { return 10_000 + ((index * 37 + this.stableInt('price', index, 97)) % 90) * 1000; }

  orderFact(index) {
    if (index < 0 || index >= this.profile.orderCount) throw new RangeError('historical order index is outside profile');
    let dropIndex = 0;
    while (this.orderPrefixes[dropIndex + 1] <= index) dropIndex += 1;
    const withinDrop = index - this.orderPrefixes[dropIndex];
    const productIndex = dropIndex * this.profile.productsPerDrop + withinDrop % this.profile.productsPerDrop;
    const userIndex = this.memberIndex('order-user', dropIndex, withinDrop);
    const quantity = 1 + Number(this.stableInt('order-quantity', index, 10) === 0);
    const step = coprimeStep(this.profile.orderCount, Math.floor(this.profile.orderCount / 2) + 1);
    const rank = (index * step + this.stableInt('approval', 0, this.profile.orderCount)) % this.profile.orderCount;
    const createdAt = addMilliseconds(this.profile.serviceStart, Math.floor(index * this.profile.days * 86_400_000 / Math.max(1, this.profile.orderCount)));
    return { index, orderId: this.order(index), paymentId: this.payment(index), userId: this.user(userIndex), dropId: this.drop(dropIndex), productId: this.product(productIndex), productIndex, quantity, amount: this.productPrice(productIndex) * quantity, approved: rank < this.profile.approvedPaymentCount, createdAt };
  }

  paymentReadyOrderFact(index) {
    if (index < 0 || index >= this.profile.paymentReadyOrderCount) throw new RangeError('payment-ready order index is outside profile');
    const globalIndex = this.profile.orderCount + index;
    const recent = Math.min(this.profile.dropCount, Math.max(1, this.profile.dailyDrops * 7));
    const dropIndex = this.profile.dropCount - 1 - (index % recent);
    const productIndex = dropIndex * this.profile.productsPerDrop + this.stableInt('payment-ready-product', index, this.profile.productsPerDrop);
    const quantity = 1 + Number(this.stableInt('payment-ready-quantity', index, 10) === 0);
    return { index: globalIndex, orderId: this.order(globalIndex), paymentId: this.payment(globalIndex), userId: this.user(this.stableInt('payment-ready-user', index, this.profile.userCount)), dropId: this.drop(dropIndex), productId: this.product(productIndex), productIndex, quantity, amount: this.productPrice(productIndex) * quantity, approved: false, createdAt: addMilliseconds(this.profile.asOf, -(this.profile.paymentReadyOrderCount - index) * 1000) };
  }

  soldByProduct() {
    if (!this.soldCache) { this.soldCache = Array(this.profile.productCount).fill(0); for (let i = 0; i < this.profile.orderCount; i += 1) { const fact = this.orderFact(i); if (fact.approved) this.soldCache[fact.productIndex] += fact.quantity; } }
    return this.soldCache;
  }
  reservedByProduct() {
    if (!this.reservedCache) { this.reservedCache = Array(this.profile.productCount).fill(0); for (let i = 0; i < this.profile.paymentReadyOrderCount; i += 1) { const fact = this.paymentReadyOrderFact(i); this.reservedCache[fact.productIndex] += fact.quantity; } }
    return this.reservedCache;
  }
  dividedCount(total, owner) { return Math.floor(total / this.profile.couponCampaignCount) + Number(owner < total % this.profile.couponCampaignCount); }
  couponIssuedCount(index) { return this.dividedCount(this.profile.userCouponCount, index); }
  couponClaimCount(index) { return this.dividedCount(this.profile.couponClaimHeadroom, index); }
  couponCodeCount(index) { return this.dividedCount(this.profile.couponCodeCount, index); }
  couponUserIndex(index) { const campaign = index % this.profile.couponCampaignCount; return this.memberIndex('coupon-user', campaign, Math.floor(index / this.profile.couponCampaignCount)); }
  couponClaimTarget(index) { const campaign = index % this.profile.couponCampaignCount; return [campaign, this.memberIndex('coupon-user', campaign, this.couponIssuedCount(campaign) + Math.floor(index / this.profile.couponCampaignCount))]; }
  couponCodeTarget(index) { const campaign = index % this.profile.couponCampaignCount; return [campaign, this.memberIndex('coupon-user', campaign, this.couponIssuedCount(campaign) + this.couponClaimCount(campaign) + Math.floor(index / this.profile.couponCampaignCount))]; }
  dropForVirtualView(index) { let drop = 0; while (this.viewPrefixes[drop + 1] <= index) drop += 1; return drop; }
}
