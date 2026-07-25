// This module intentionally has no Node or k6 imports.  The dataset seeder
// and k6 provide the same hash functions, so both sides address the rows that
// were generated from one seed without serialising an address document.

function positive(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new TypeError(`${name} must be a positive integer`);
  return number;
}

function halfUp(value) { return Math.floor(Number(value) + 0.5); }

export function coprimeStep(size, candidate) {
  if (size <= 1) return 1;
  const gcd = (left, right) => {
    let a = Math.abs(left); let b = Math.abs(right);
    while (b) [a, b] = [b, a % b];
    return a;
  };
  let step = Math.max(1, candidate % size);
  while (gcd(step, size) !== 1) { step = (step + 1) % size; if (step === 0) step = 1; }
  return step;
}

function modularInverse(value, modulus) {
  let [oldR, r, oldS, s] = [value, modulus, 1, 0];
  while (r !== 0) {
    const quotient = Math.floor(oldR / r);
    [oldR, r] = [r, oldR - quotient * r];
    [oldS, s] = [s, oldS - quotient * s];
  }
  if (oldR !== 1) throw new RangeError('modular inverse is unavailable');
  return ((oldS % modulus) + modulus) % modulus;
}

export function normalizeDatasetProfile(document) {
  const source = document?.parameters ?? document;
  if (!source || typeof source !== 'object') throw new TypeError('dataset profile is required');
  const tiers = source.tiers;
  if (!Array.isArray(tiers) || !tiers.length) throw new TypeError('dataset profile tiers are required');
  const profile = {
    name: String(document?.profile ?? source.name ?? ''),
    days: positive(source.days, 'days'),
    initialUsers: positive(source.initial_users, 'initial_users'),
    dailyNewUsers: positive(source.daily_new_users, 'daily_new_users'),
    dailyDrops: positive(source.daily_drops, 'daily_drops'),
    productsPerDrop: positive(source.products_per_drop, 'products_per_drop'),
    activeInventoryPerProduct: positive(source.active_inventory_per_product, 'active_inventory_per_product'),
    paymentReadyOrderCount: positive(source.paymentReadyOrderCount, 'paymentReadyOrderCount'),
    couponClaimHeadroom: positive(source.couponClaimHeadroom, 'couponClaimHeadroom'),
    dailyCouponCampaigns: positive(source.daily_coupon_campaigns, 'daily_coupon_campaigns'),
    seasonalCouponCampaigns: positive(source.seasonal_coupon_campaigns, 'seasonal_coupon_campaigns'),
    dailyCouponIssues: positive(source.daily_coupon_issues, 'daily_coupon_issues'),
    eventCouponIssues: positive(source.event_coupon_issues, 'event_coupon_issues'),
    couponRedemptionPercent: Number(source.coupon_redemption_percent),
    notificationsPerOrder: positive(source.notifications_per_order, 'notifications_per_order'),
    authUserPoolSize: Math.min(positive(source.runtime_auth_user_pool_size ?? 1024, 'runtime_auth_user_pool_size'), positive(source.initial_users, 'initial_users') + positive(source.daily_new_users, 'daily_new_users') * positive(source.days, 'days')),
    tiers: tiers.map((tier) => ({
      sharePercent: Number(tier.share_percent),
      viewsPerDrop: positive(tier.views_per_drop, 'tiers.views_per_drop'),
      interestRatePercent: Number(tier.interest_rate_percent),
      buyerConversionPercent: Number(tier.buyer_conversion_percent),
      ordersPerBuyer: Number(tier.orders_per_buyer),
    })),
  };
  if (!profile.name) throw new TypeError('dataset profile name is required');
  profile.userCount = profile.initialUsers + profile.dailyNewUsers * profile.days;
  profile.dropCount = profile.dailyDrops * profile.days;
  profile.productCount = profile.dropCount * profile.productsPerDrop;
  let remaining = profile.dropCount;
  profile.tierDropCounts = profile.tiers.map((tier, index) => {
    const count = index === profile.tiers.length - 1 ? remaining : Math.floor(profile.dropCount * tier.sharePercent / 100);
    remaining -= count;
    return count;
  });
  profile.tierForDrop = (dropIndex) => {
    let offset = 0;
    for (let index = 0; index < profile.tiers.length; index += 1) {
      if (dropIndex < offset + profile.tierDropCounts[index]) return profile.tiers[index];
      offset += profile.tierDropCounts[index];
    }
    throw new RangeError('drop index outside profile');
  };
  profile.interestsForDrop = (index) => halfUp(profile.tierForDrop(index).viewsPerDrop * profile.tierForDrop(index).interestRatePercent / 100);
  profile.ordersForDrop = (index) => halfUp(profile.tierForDrop(index).viewsPerDrop * profile.tierForDrop(index).buyerConversionPercent * profile.tierForDrop(index).ordersPerBuyer / 100);
  profile.orderCount = profile.tierDropCounts.reduce((sum, count, index) => sum + count * halfUp(profile.tiers[index].viewsPerDrop * profile.tiers[index].buyerConversionPercent * profile.tiers[index].ordersPerBuyer / 100), 0);
  profile.approvedPaymentCount = halfUp(profile.orderCount * 0.92);
  profile.couponCampaignCount = profile.dailyCouponCampaigns * profile.days + profile.seasonalCouponCampaigns;
  profile.userCouponCount = profile.dailyCouponIssues * profile.days + profile.eventCouponIssues;
  profile.couponRedemptionCount = Math.min(profile.userCouponCount, halfUp(profile.orderCount * profile.couponRedemptionPercent / 100));
  profile.notificationCount = profile.orderCount * profile.notificationsPerOrder;
  for (let index = 0; index < profile.dropCount; index += 1) {
    if (profile.interestsForDrop(index) > profile.authUserPoolSize) throw new TypeError('runtime auth user pool is too small for unique interests');
  }
  if (Math.ceil((profile.userCouponCount + profile.couponClaimHeadroom) / profile.couponCampaignCount) > profile.authUserPoolSize) {
    throw new TypeError('runtime auth user pool is too small for coupon issuance');
  }
  return profile;
}

function uuidFromHex(hex) {
  const value = `${hex.slice(0, 12)}5${hex.slice(13, 16)}${((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0')}${hex.slice(18, 32)}`;
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
}

export function createAddressBook(document, seed, hashes) {
  const profile = normalizeDatasetProfile(document);
  const value = String(seed);
  const sha256 = (input) => hashes.sha256(String(input));
  const sha1 = (input) => hashes.sha1(String(input));
  const token = sha256(value).slice(0, 8);
  const stableInt = (purpose, index, modulus) => modulus <= 0 ? 0 : parseInt(sha256(`${value}:${purpose}:${index}`).slice(0, 12), 16) % modulus;
  const uuid = (kind, index) => uuidFromHex(sha1(`dropmong:${profile.name}:${value}:${kind}:${index}`));
  const memberIndex = (purpose, ownerIndex, ordinal) => {
    const size = profile.authUserPoolSize;
    const offset = stableInt(`${purpose}-offset`, ownerIndex, size);
    return (offset + coprimeStep(size, stableInt(`${purpose}-step`, ownerIndex, size)) * ordinal) % size;
  };
  const orderPrefixes = [0];
  for (let index = 0; index < profile.dropCount; index += 1) orderPrefixes.push(orderPrefixes.at(-1) + profile.ordersForDrop(index));
  const sampleIndex = (purpose, occurrence, size) => (stableInt(`${purpose}-offset`, 0, size) + coprimeStep(size, stableInt(`${purpose}-step`, 0, size)) * occurrence) % size;
  const orderFact = (index) => {
    if (index < 0 || index >= profile.orderCount) throw new RangeError('historical order index is outside profile');
    let dropIndex = 0;
    while (orderPrefixes[dropIndex + 1] <= index) dropIndex += 1;
    const withinDrop = index - orderPrefixes[dropIndex];
    const productIndex = dropIndex * profile.productsPerDrop + withinDrop % profile.productsPerDrop;
    const rank = (index * coprimeStep(profile.orderCount, Math.floor(profile.orderCount / 2) + 1) + stableInt('approval', 0, profile.orderCount)) % profile.orderCount;
    const quantity = 1 + Number(stableInt('order-quantity', index, 10) === 0);
    return { orderId: `order-${token}-${String(index).padStart(8, '0')}`, paymentId: `payment-${token}-${String(index).padStart(8, '0')}`, userId: user(memberIndex('order-user', dropIndex, withinDrop)), dropId: drop(dropIndex), productId: product(productIndex), quantity, amount: productPrice(productIndex) * quantity, approved: rank < profile.approvedPaymentCount };
  };
  const approvalStep = coprimeStep(profile.orderCount, Math.floor(profile.orderCount / 2) + 1);
  const approvalOffset = stableInt('approval', 0, profile.orderCount);
  const approvalStepInverse = modularInverse(approvalStep, profile.orderCount);
  const approvedOrderFact = (ordinal) => {
    if (ordinal < 0 || ordinal >= profile.approvedPaymentCount) throw new RangeError('approved order addressing is exhausted');
    const index = (((ordinal - approvalOffset) * approvalStepInverse) % profile.orderCount + profile.orderCount) % profile.orderCount;
    return orderFact(index);
  };
  const paymentReadyOrderFact = (index) => {
    if (index < 0 || index >= profile.paymentReadyOrderCount) throw new RangeError('payment-ready order index is outside profile');
    const globalIndex = profile.orderCount + index;
    const recent = Math.min(profile.dropCount, Math.max(1, profile.dailyDrops * 7));
    const dropIndex = profile.dropCount - 1 - (index % recent);
    const productIndex = dropIndex * profile.productsPerDrop + stableInt('payment-ready-product', index, profile.productsPerDrop);
    const quantity = 1 + Number(stableInt('payment-ready-quantity', index, 10) === 0);
    return { orderId: `order-${token}-${String(globalIndex).padStart(8, '0')}`, userId: user(stableInt('payment-ready-user', index, profile.authUserPoolSize)), dropId: drop(dropIndex), productId: product(productIndex), quantity, amount: productPrice(productIndex) * quantity };
  };
  const user = (index) => uuid('user', index);
  const drop = (index) => `drop-${token}-${String(index).padStart(6, '0')}`;
  const product = (index) => `product-${token}-${String(index).padStart(7, '0')}`;
  const productPrice = (index) => 10_000 + ((index * 37 + stableInt('price', index, 97)) % 90) * 1000;
  const couponUserIndex = (index) => memberIndex('coupon-user', index % profile.couponCampaignCount, Math.floor(index / profile.couponCampaignCount));
  return {
    profile, token, uuid, user, drop, product, productPrice, orderFact, approvedOrderFact, paymentReadyOrderFact, stableInt, sampleIndex,
    email: (index) => `loadtest-${token}-${String(index).padStart(6, '0')}@example.invalid`,
    authUser: (occurrence) => user(sampleIndex('auth-users', occurrence, profile.authUserPoolSize)),
    profileUser: (occurrence) => user(sampleIndex('profile-user', occurrence, profile.authUserPoolSize)),
    existingInterest: (occurrence) => {
      const dropIndex = sampleIndex('existing-interest-drop', occurrence, profile.dropCount);
      const member = sampleIndex(`existing-interest-member:${dropIndex}`, occurrence, profile.interestsForDrop(dropIndex));
      return { userId: user(memberIndex('interest-user', dropIndex, member)), dropId: drop(dropIndex) };
    },
    newInterest: (occurrence) => {
      const dropIndex = occurrence % profile.dropCount;
      const member = profile.interestsForDrop(dropIndex) + Math.floor(occurrence / profile.dropCount);
      if (member >= profile.authUserPoolSize) throw new RangeError('interest add addressing is exhausted');
      return { userId: user(memberIndex('interest-user', dropIndex, member)), dropId: drop(dropIndex) };
    },
    viewEvent: (occurrence) => ({ userId: user(sampleIndex('view-user', occurrence, profile.authUserPoolSize)), dropId: drop(sampleIndex('view-drop', occurrence, profile.dropCount)) }),
    orderCreate: (occurrence) => ({ userId: user(sampleIndex('order-create-user', occurrence, profile.authUserPoolSize)), dropId: 'drop-001', productId: 'product-001', quantity: 1 }),
    couponWallet: (occurrence) => {
      const usable = Math.min(profile.userCouponCount - profile.couponRedemptionCount, 10_000);
      const index = profile.userCouponCount - 1 - sampleIndex('coupon-wallet', occurrence, usable);
      return { userId: user(couponUserIndex(index)), userCouponId: `ucpn_${token}_${String(index).padStart(8, '0')}` };
    },
    couponClaim: (occurrence) => {
      const index = occurrence;
      if (index >= profile.couponClaimHeadroom) throw new RangeError('coupon claim addressing is exhausted');
      const campaign = index % profile.couponCampaignCount;
      const issued = Math.floor(profile.userCouponCount / profile.couponCampaignCount) + Number(campaign < profile.userCouponCount % profile.couponCampaignCount);
      return { campaignId: `camp_${token}_${String(campaign).padStart(6, '0')}`, userId: user(memberIndex('coupon-user', campaign, issued + Math.floor(index / profile.couponCampaignCount))) };
    },
    notificationUser: (occurrence) => orderFact(sampleIndex('notification-read', occurrence, profile.orderCount)).userId,
    notificationEvent: (index) => {
      const fact = orderFact(index % profile.orderCount);
      const eventId = uuid('notification-load-event', index);
      return { schemaVersion: 1, eventId, eventType: 'notification.requested', userId: fact.userId, sourceId: `loadtest:${token}`, notificationId: `notification-${token}-${String(index).padStart(9, '0')}`, orderId: fact.orderId, notificationType: 'ORDER_CONFIRMED', channel: 'IN_APP', title: 'Load test notification', message: `Load test notification for ${fact.orderId}`, producer: 'dropmong-loadtest-seeder', correlationId: eventId };
    },
    webCheckout: (occurrence) => {
      const productIndex = sampleIndex('web-checkout-products', occurrence, profile.productCount);
      return { dropId: drop(Math.floor(productIndex / profile.productsPerDrop)), productId: product(productIndex), quantity: 1 };
    },
  };
}

export function writeCapacities(document) {
  const profile = normalizeDatasetProfile(document);
  return {
    profileWrite: profile.authUserPoolSize,
    existingInterests: profile.interestCount,
    interestAdd: profile.dropCount * Math.max(0, profile.authUserPoolSize - Math.max(...Array.from({ length: profile.dropCount }, (_, index) => profile.interestsForDrop(index)))),
    viewEvents: profile.authUserPoolSize * profile.dropCount,
    orderCreate: profile.authUserPoolSize,
    orderCancel: profile.approvedPaymentCount,
    paymentReady: profile.paymentReadyOrderCount,
    paymentReadyApprove: Math.floor(profile.paymentReadyOrderCount / 2),
    paymentReadyFail: profile.paymentReadyOrderCount - Math.floor(profile.paymentReadyOrderCount / 2),
    couponClaim: profile.couponClaimHeadroom,
    notificationEvents: profile.orderCount,
    webCheckouts: profile.productCount * 40,
  };
}
