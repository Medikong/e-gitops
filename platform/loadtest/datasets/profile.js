import { createHash } from 'node:crypto';

const INTEGER_KEYS = [
  'days', 'initial_users', 'daily_new_users', 'daily_drops', 'products_per_drop',
  'raw_view_hours', 'active_inventory_per_product', 'paymentReadyOrderCount',
  'couponClaimHeadroom', 'runtime_auth_user_pool_size',
  'daily_coupon_campaigns', 'seasonal_coupon_campaigns', 'daily_coupon_issues',
  'event_coupon_issues', 'notifications_per_order',
];

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function halfUp(value) {
  return Math.floor(Number(value) + 0.5);
}

function positiveInteger(document, key) {
  const value = Number(document[key]);
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`dataset.parameters.${key} must be a positive integer`);
  return value;
}

export function loadProfile(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new TypeError('dataset profile must be an object');
  for (const key of INTEGER_KEYS) positiveInteger(document, key);
  if (!String(document.name ?? '').trim()) throw new TypeError('dataset profile name is required');
  if (!Number.isSafeInteger(Number(document.version)) || Number(document.version) <= 0) throw new TypeError('dataset profile version must be a positive integer');
  const asOf = new Date(document.as_of);
  if (!Number.isFinite(asOf.getTime()) || !/(Z|[+-]\d\d:\d\d)$/.test(String(document.as_of))) throw new TypeError('dataset profile as_of must include a timezone');
  if (!Array.isArray(document.tiers) || document.tiers.length === 0) throw new TypeError('dataset profile tiers are required');
  const tiers = document.tiers.map((tier, index) => {
    const result = {
      name: String(tier.name ?? ''),
      sharePercent: Number(tier.share_percent),
      viewsPerDrop: Number(tier.views_per_drop),
      interestRatePercent: Number(tier.interest_rate_percent),
      buyerConversionPercent: Number(tier.buyer_conversion_percent),
      ordersPerBuyer: Number(tier.orders_per_buyer),
    };
    if (!result.name || !Number.isFinite(result.sharePercent) || !Number.isSafeInteger(result.viewsPerDrop) || result.viewsPerDrop <= 0 ||
      !Number.isFinite(result.interestRatePercent) || !Number.isFinite(result.buyerConversionPercent) || !Number.isFinite(result.ordersPerBuyer) || result.ordersPerBuyer <= 0) {
      throw new TypeError(`dataset profile tier ${index} is invalid`);
    }
    return result;
  });
  if (Math.abs(tiers.reduce((sum, tier) => sum + tier.sharePercent, 0) - 100) > 1e-9) throw new TypeError('dataset tier share_percent values must total 100');
  if (!Array.isArray(document.agreements) || document.agreements.some((value) => !String(value).includes(':'))) throw new TypeError('dataset agreements must use code:version form');

  const profile = {
    name: String(document.name), version: Number(document.version), asOf,
    days: positiveInteger(document, 'days'), initialUsers: positiveInteger(document, 'initial_users'),
    dailyNewUsers: positiveInteger(document, 'daily_new_users'), dailyDrops: positiveInteger(document, 'daily_drops'),
    productsPerDrop: positiveInteger(document, 'products_per_drop'), rawViewHours: positiveInteger(document, 'raw_view_hours'),
    activeInventoryPerProduct: positiveInteger(document, 'active_inventory_per_product'),
    paymentReadyOrderCount: positiveInteger(document, 'paymentReadyOrderCount'), couponClaimHeadroom: positiveInteger(document, 'couponClaimHeadroom'),
    tiers,
    dailyCouponCampaigns: positiveInteger(document, 'daily_coupon_campaigns'), seasonalCouponCampaigns: positiveInteger(document, 'seasonal_coupon_campaigns'),
    dailyCouponIssues: positiveInteger(document, 'daily_coupon_issues'), eventCouponIssues: positiveInteger(document, 'event_coupon_issues'),
    couponRedemptionPercent: Number(document.coupon_redemption_percent), notificationsPerOrder: positiveInteger(document, 'notifications_per_order'),
    runtimeAuthUserPoolSize: positiveInteger(document, 'runtime_auth_user_pool_size'),
    agreements: document.agreements.map(String), digest: sha256(canonicalJson(document)), source: document,
  };
  if (!Number.isFinite(profile.couponRedemptionPercent) || profile.couponRedemptionPercent < 0 || profile.couponRedemptionPercent > 100) throw new TypeError('coupon_redemption_percent must be between 0 and 100');
  profile.serviceStart = new Date(profile.asOf.getTime() - profile.days * 86_400_000);
  profile.userCount = profile.initialUsers + profile.dailyNewUsers * profile.days;
  profile.authUserPoolSize = Math.min(profile.runtimeAuthUserPoolSize, profile.userCount);
  profile.dropCount = profile.dailyDrops * profile.days;
  profile.productCount = profile.dropCount * profile.productsPerDrop;
  let remaining = profile.dropCount;
  profile.tierDropCounts = tiers.map((tier, index) => {
    const count = index === tiers.length - 1 ? remaining : Math.floor(profile.dropCount * tier.sharePercent / 100);
    remaining -= count;
    return count;
  });
  profile.tierForDrop = (dropIndex) => {
    let offset = 0;
    for (let index = 0; index < tiers.length; index += 1) {
      if (dropIndex < offset + profile.tierDropCounts[index]) return tiers[index];
      offset += profile.tierDropCounts[index];
    }
    throw new RangeError(`drop index outside profile: ${dropIndex}`);
  };
  profile.interestsForDrop = (index) => halfUp(profile.tierForDrop(index).viewsPerDrop * profile.tierForDrop(index).interestRatePercent / 100);
  profile.ordersForDrop = (index) => halfUp(profile.tierForDrop(index).viewsPerDrop * profile.tierForDrop(index).buyerConversionPercent * profile.tierForDrop(index).ordersPerBuyer / 100);
  profile.viewCount = profile.tierDropCounts.reduce((sum, count, index) => sum + count * tiers[index].viewsPerDrop, 0);
  profile.interestCount = profile.tierDropCounts.reduce((sum, count, index) => sum + count * halfUp(tiers[index].viewsPerDrop * tiers[index].interestRatePercent / 100), 0);
  profile.orderCount = profile.tierDropCounts.reduce((sum, count, index) => sum + count * halfUp(tiers[index].viewsPerDrop * tiers[index].buyerConversionPercent * tiers[index].ordersPerBuyer / 100), 0);
  profile.totalOrderCount = profile.orderCount + profile.paymentReadyOrderCount;
  profile.approvedPaymentCount = halfUp(profile.orderCount * 0.92);
  profile.rawViewCount = Math.max(1, halfUp(profile.viewCount * profile.rawViewHours / (profile.days * 24)));
  profile.couponCampaignCount = profile.dailyCouponCampaigns * profile.days + profile.seasonalCouponCampaigns;
  profile.userCouponCount = profile.dailyCouponIssues * profile.days + profile.eventCouponIssues;
  profile.couponRedemptionCount = Math.min(profile.userCouponCount, halfUp(profile.orderCount * profile.couponRedemptionPercent / 100));
  profile.notificationCount = profile.orderCount * profile.notificationsPerOrder;
  if ([...Array(profile.dropCount).keys()].some((index) => profile.interestsForDrop(index) > profile.authUserPoolSize)) throw new TypeError('a drop cannot have more unique interests than runtime auth users');
  const largestCampaignPool = Math.ceil((profile.userCouponCount + profile.couponClaimHeadroom) / profile.couponCampaignCount);
  if (largestCampaignPool > profile.authUserPoolSize) throw new TypeError('coupon issue and claim pools exceed runtime auth users per campaign');
  return profile;
}

export function expectedTableCounts(profile) {
  const campaigns = profile.couponCampaignCount;
  return {
    'auth-service': { auth_identities: profile.userCount, auth_password_credentials: profile.userCount, auth_identity_links: profile.userCount, auth_user_auth_states: profile.userCount },
    'user-service': { users: profile.userCount, user_agreement_acceptances: profile.userCount * profile.agreements.length },
    'catalog-service': { drops: profile.dropCount, products: profile.productCount, inventory_projections: profile.productCount },
    'interest-service': { interests: profile.interestCount, drop_interest_counters: profile.dropCount, drop_view_counters: profile.dropCount, drop_views: profile.rawViewCount, drop_view_rankings: Math.min(100, profile.dropCount) },
    'order-service': { orders: profile.totalOrderCount, inventory_items: profile.productCount + 1 },
    'payment-service': { known_orders: profile.totalOrderCount, payments: profile.orderCount },
    'notification-service': { notifications: profile.notificationCount, processed_events: profile.notificationCount },
    'coupon-service': { coupon_campaigns: campaigns, coupon_campaign_policy_versions: campaigns, coupon_benefits: campaigns, coupon_applicability_policies: campaigns, coupon_issue_requests: profile.userCouponCount, user_coupons: profile.userCouponCount, coupon_redemptions: profile.couponRedemptionCount, rm_user_coupon_wallet: profile.userCouponCount, rm_coupon_details: profile.userCouponCount },
  };
}
