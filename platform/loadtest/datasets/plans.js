import { createHash } from 'node:crypto';
import { canonicalJson } from './profile.js';
import { iso } from './model.js';

export const DATABASES = Object.freeze({
  'auth-service': 'auth_service', 'user-service': 'user_service', 'catalog-service': 'catalog_service', 'coupon-service': 'coupon_service',
  'interest-service': 'interest_service', 'order-service': 'order_service', 'payment-service': 'payment_service', 'notification-service': 'notification_service',
});

const day = 86_400_000;
const date = (base, milliseconds) => new Date(base.getTime() + milliseconds);
const json = canonicalJson;
const plan = (database, table, columns, rows) => ({ database, table, columns, rows });

// Order service currently validates this local development catalog in-process.
// Keep the generated load-test data aligned with that explicit service contract.
export const ORDER_SERVICE_LOADTEST_PRODUCT = Object.freeze({ dropId: 'drop-001', productId: 'product-001' });

function* authPlans(model) {
  const p = model.profile; if (!model.authPasswordHash) throw new TypeError('auth-service dataset requires an in-process password hash');
  function* identities() { for (let i = 0; i < p.userCount; i += 1) { const at = iso(model.userCreatedAt(i)); yield [model.identity(i), 'email', 'default', `loadtest-${model.token}-${String(i).padStart(6, '0')}@example.invalid`, `loadtest-${String(i).padStart(6, '0')}@e***.invalid`, 'active', 'verified', 'active', model.user(i), 0, at, 0, at, at]; } }
  function* credentials() { for (let i = 0; i < p.userCount; i += 1) { const at = iso(model.userCreatedAt(i)); yield [model.uuid('password-credential', i), model.identity(i), model.authPasswordHash, 'active', 'bcrypt', '{}', 1, 0, at, at]; } }
  function* links() { for (let i = 0; i < p.userCount; i += 1) { const at = iso(model.userCreatedAt(i)); yield [model.identityLink(i), model.identity(i), 'email', model.user(i), 'active', 'signup', at, at, 0, at, at]; } }
  function* states() { for (let i = 0; i < p.userCount; i += 1) { const at = iso(model.userCreatedAt(i)); yield [model.user(i), 'active', 1, at, `dataset-${model.token}-${String(i).padStart(8, '0')}`, 0, at]; } }
  yield plan('auth_service', 'auth_identities', ['identity_id','identity_type','identity_namespace','normalized_value','masked_value','status','verification_status','credential_status','owner_user_id','failure_count','verified_at','row_version','created_at','updated_at'], identities());
  yield plan('auth_service', 'auth_password_credentials', ['password_credential_id','identity_id','password_hash','password_status','hash_algorithm','hash_parameters','credential_version','row_version','created_at','updated_at'], credentials());
  yield plan('auth_service', 'auth_identity_links', ['identity_link_id','identity_id','identity_type','user_id','link_status','link_reason','requested_at','activated_at','row_version','created_at','updated_at'], links());
  yield plan('auth_service', 'auth_user_auth_states', ['user_id','status','user_version','effective_at','status_change_id','row_version','updated_at'], states());
}

function* userPlans(model) {
  const p = model.profile;
  function* users() { for (let i = 0; i < p.userCount; i += 1) { const at = iso(model.userCreatedAt(i)); const privateName = createHash('sha256').update(`${model.seed}:private-name:${i}`).digest('hex'); yield [model.user(i), `registration-${model.token}-${String(i).padStart(8, '0')}`, 'active', `\\x${privateName}`, `loadtester-${String(i).padStart(6, '0')}`, `deterministic benchmark user ${i}`, 1, at, at]; } }
  function* agreements() { for (let i = 0; i < p.userCount; i += 1) for (const agreement of p.agreements) { const [code, version] = agreement.split(':', 2); yield [model.user(i), code, version, iso(model.userCreatedAt(i))]; } }
  yield plan('user_service', 'users', ['user_id','registration_id','account_status','private_name_ciphertext','nickname','introduction','user_version','created_at','updated_at'], users());
  yield plan('user_service', 'user_agreement_acceptances', ['user_id','agreement_code','agreement_version','accepted_at'], agreements());
}

function* catalogPlans(model) {
  const p = model.profile;
  function* drops() { for (let i = 0; i < p.dropCount; i += 1) { const opens = model.dropOpensAt(i); yield [model.drop(i), `Deterministic drop ${String(i).padStart(6, '0')}`, opens >= date(p.asOf, -14 * day) ? 'OPEN' : 'CLOSED', iso(opens), iso(date(opens, 7 * day)), `${p.name} generated drop ${i}`]; } }
  function* products() { for (let i = 0; i < p.productCount; i += 1) yield [model.product(i), model.drop(Math.floor(i / p.productsPerDrop)), `Benchmark product ${String(i).padStart(7, '0')}`, model.productPrice(i)]; }
  function* inventory() { for (let i = 0; i < p.productCount; i += 1) yield [model.product(i), model.drop(Math.floor(i / p.productsPerDrop)), p.activeInventoryPerProduct, 0]; }
  yield plan('catalog_service','drops',['id','title','status','opens_at','closes_at','description'],drops());
  yield plan('catalog_service','products',['id','drop_id','name','price'],products());
  yield plan('catalog_service','inventory_projections',['product_id','drop_id','remaining_quantity','inventory_version'],inventory());
}

function* interestPlans(model) {
  const p = model.profile;
  function* interests() { let ordinal = 0; for (let d = 0; d < p.dropCount; d += 1) for (let member = 0; member < p.interestsForDrop(d); member += 1) { const at = new Date(Math.min(p.asOf.getTime() - 60_000, model.dropOpensAt(d).getTime() + (member % 48) * 3_600_000)); yield [model.uuid('interest', ordinal++), model.user(model.memberIndex('interest-user', d, member)), model.drop(d), 'active', iso(at), iso(at), 0]; } }
  function* interestCounters() { for (let d = 0; d < p.dropCount; d += 1) yield [model.drop(d), p.interestsForDrop(d), iso(new Date(Math.min(p.asOf.getTime() - 60_000, model.dropOpensAt(d).getTime() + 2 * day)))]; }
  function* viewCounters() { for (let d = 0; d < p.dropCount; d += 1) yield [model.drop(d), p.tierForDrop(d).viewsPerDrop, iso(new Date(Math.min(p.asOf.getTime() - 60_000, model.dropOpensAt(d).getTime() + 3 * day)))]; }
  function* rawViews() { for (let i = 0; i < p.rawViewCount; i += 1) { const virtual = Math.floor(i * p.viewCount / p.rawViewCount); const d = model.dropForVirtualView(virtual); yield [model.drop(d), model.user(model.memberIndex('raw-view-user', d, i)), iso(date(p.asOf, -Math.floor((p.rawViewCount - i) * p.rawViewHours * 3_600_000 / p.rawViewCount)))]; } }
  const rawCounts = Array(p.dropCount).fill(0); for (let i = 0; i < p.rawViewCount; i += 1) rawCounts[model.dropForVirtualView(Math.floor(i * p.viewCount / p.rawViewCount))] += 1;
  const ranked = Array.from({ length: p.dropCount }, (_, i) => i).sort((a,b) => rawCounts[b] - rawCounts[a] || model.drop(a).localeCompare(model.drop(b))).slice(0,100);
  function* rankings() { for (let i = 0; i < ranked.length; i += 1) { const d = ranked[i]; const viewers = rawCounts[d]; const interests = Math.min(p.interestsForDrop(d), viewers); yield [iso(date(p.asOf,-3*3_600_000)), i+1, model.drop(d), viewers, interests, String(viewers ? interests/viewers : 0), iso(p.asOf)]; } }
  yield plan('interest_service','interests',['id','user_id','drop_id','status','created_at','updated_at','version'],interests());
  yield plan('interest_service','drop_interest_counters',['drop_id','interest_count','updated_at'],interestCounters());
  yield plan('interest_service','drop_view_counters',['drop_id','view_count','last_viewed_at'],viewCounters());
  yield plan('interest_service','drop_views',['drop_id','user_id','viewed_at'],rawViews());
  yield plan('interest_service','drop_view_rankings',['bucket_start','rank','drop_id','viewer_count','new_interest_count','conversion_rate','computed_at'],rankings());
}

function* orderPlans(model) {
  const p=model.profile;
  function* orders() { for(let i=0;i<p.orderCount;i+=1){const f=model.orderFact(i); yield [f.orderId,f.userId,f.dropId,f.productId,f.quantity,f.amount,f.approved?'CONFIRMED':'PAYMENT_FAILED',`dataset-${model.token}-${String(i).padStart(8,'0')}`,f.paymentId,iso(f.createdAt),f.approved?iso(date(f.createdAt,10_000)):null,'NOT_STARTED',null];} for(let i=0;i<p.paymentReadyOrderCount;i+=1){const f=model.paymentReadyOrderFact(i);yield[f.orderId,f.userId,f.dropId,f.productId,f.quantity,f.amount,'PENDING_PAYMENT',`dataset-ready-${model.token}-${String(i).padStart(8,'0')}`,null,iso(f.createdAt),null,'NOT_STARTED',iso(date(p.asOf,day))];} }
  function* inventory(){const sold=model.soldByProduct(),reserved=model.reservedByProduct();yield[ORDER_SERVICE_LOADTEST_PRODUCT.dropId,ORDER_SERVICE_LOADTEST_PRODUCT.productId,p.activeInventoryPerProduct,0,0,0];for(let i=0;i<p.productCount;i+=1)yield[model.drop(Math.floor(i/p.productsPerDrop)),model.product(i),sold[i]+reserved[i]+p.activeInventoryPerProduct,reserved[i],sold[i],0];}
  yield plan('order_service','orders',['id','user_id','drop_id','product_id','quantity','amount','status','idempotency_key','payment_id','created_at','confirmed_at','fulfillment_status','expires_at'],orders());
  yield plan('order_service','inventory_items',['drop_id','product_id','total_quantity','reserved_quantity','sold_quantity','version'],inventory());
}

function* paymentPlans(model){const p=model.profile;function* known(){for(let i=0;i<p.orderCount;i+=1){const f=model.orderFact(i);yield[f.orderId,f.userId,f.amount,iso(f.createdAt)];}for(let i=0;i<p.paymentReadyOrderCount;i+=1){const f=model.paymentReadyOrderFact(i);yield[f.orderId,f.userId,f.amount,iso(f.createdAt)];}}function* payments(){for(let i=0;i<p.orderCount;i+=1){const f=model.orderFact(i),terminal=iso(date(f.createdAt,5000));yield[f.paymentId,f.orderId,f.userId,f.amount,'MOCK_CARD',f.approved?'APPROVED':'FAILED',`dataset-${model.token}-${String(i).padStart(8,'0')}`,iso(f.createdAt),f.approved?terminal:null,f.approved?null:terminal,f.approved?null:'SYNTHETIC_DECLINE'];}}yield plan('payment_service','known_orders',['order_id','user_id','amount','created_at'],known());yield plan('payment_service','payments',['id','order_id','user_id','amount','method','status','idempotency_key','created_at','approved_at','failed_at','failure_reason'],payments());}

function* notificationPlans(model){const p=model.profile;function row(i){const order=Math.floor(i/p.notificationsPerOrder),slot=i%p.notificationsPerOrder,f=model.orderFact(order),types=f.approved?['ORDER_CONFIRMED','ORDER_CONFIRMED','ORDER_CANCELED','PAYMENT_REFUNDED']:['PAYMENT_FAILED','PAYMENT_FAILED','ORDER_EXPIRED','REFUND_FAILED'],type=types[slot%types.length],at=iso(date(f.createdAt,(10+slot)*1000)),event=model.uuid('notification-event',i);return[model.notification(i),event,f.userId,f.orderId,type,type.replaceAll('_',' '),`Deterministic benchmark notification for ${f.orderId}`,at,i%5===0];}function* notifications(){for(let i=0;i<p.notificationCount;i+=1)yield row(i);}function* processed(){for(let i=0;i<p.notificationCount;i+=1){const r=row(i);yield[r[1],'notification.requested',r[7]];}}yield plan('notification_service','notifications',['id','event_id','user_id','order_id','type','title','message','created_at','read'],notifications());yield plan('notification_service','processed_events',['event_id','event_type','processed_at'],processed());}

function* couponPlans(model){
  const p=model.profile;
  const issued=Array.from({length:p.couponCampaignCount},(_,i)=>model.couponIssuedCount(i)),claims=Array.from({length:p.couponCampaignCount},(_,i)=>model.couponClaimCount(i));
  const campaignAt=(i)=>date(p.serviceStart,(i%p.days)*day);const couponAt=(i)=>date(p.serviceStart,Math.floor(i*p.days*day/Math.max(1,p.userCouponCount)));const status=(i,created)=>i<p.couponRedemptionCount?['granted','used',date(p.asOf,(30+i%30)*day)]:i%10===0&&created<date(p.asOf,-30*day)?['expired','expired',date(created,30*day)]:['granted','available',date(p.asOf,(30+i%30)*day)];
  function* campaigns(){for(let i=0;i<p.couponCampaignCount;i+=1){const at=campaignAt(i);yield[model.campaign(i),`Benchmark campaign ${String(i).padStart(4,'0')}`,`${p.name} deterministic campaign`,'active',iso(at),iso(date(p.asOf,90*day)),iso(at),iso(date(p.asOf,60*day)),1,issued[i]+claims[i],1,0,issued[i],'platform',json({type:'platform',id:'dropmong'}),'platform',json({type:'platform',id:'dropmong'}),'100.00',`dataset:${model.token}`,json({owner:'benchmark',seed:model.seed}),0,iso(at),iso(at)];}}
  function* policies(){for(let i=0;i<p.couponCampaignCount;i+=1){const at=iso(campaignAt(i));yield[model.campaign(i),1,at,json({issuerType:'platform',funderType:'platform'}),at];}}
  function* benefits(){for(let i=0;i<p.couponCampaignCount;i+=1)yield[`benefit_${model.token}_${String(i).padStart(6,'0')}`,model.campaign(i),1,'fixed_amount','5000.0000','KRW',iso(campaignAt(i))];}
  function* applicability(){for(let i=0;i<p.couponCampaignCount;i+=1){const at=iso(campaignAt(i));yield[`policy_${model.token}_${String(i).padStart(6,'0')}`,model.campaign(i),1,1,'platform','dropmong','include',at,`benchmark-${String(i).padStart(4,'0')}`,at];}}
  function* requests(){for(let i=0;i<p.userCouponCount;i+=1){const c=i%p.couponCampaignCount,u=model.couponUserIndex(i),at=iso(couponAt(i)),uc=model.userCoupon(i);yield[model.issueRequest(i),model.campaign(c),model.user(u),`dataset:${model.token}:${String(i).padStart(8,'0')}`,'bulk',`baseline-${model.token}:page-${String(Math.floor(i/1000)).padStart(5,'0')}`,'completed',uc,0,json({issuerType:'platform',funderType:'platform'}),json({policyVersion:1}),`dataset:${model.token}`,`user-coupon:${uc}`,0,at,at];}}
  function* userCoupons(){for(let i=0;i<p.userCouponCount;i+=1){const c=i%p.couponCampaignCount,u=model.couponUserIndex(i),created=couponAt(i),[state,,expires]=status(i,created),usable=new Date(Math.min(created.getTime(),expires.getTime()-1000)),at=iso(created);yield[model.userCoupon(i),model.campaign(c),1,model.user(u),model.issueRequest(i),state,iso(usable),iso(expires),json({campaignId:model.campaign(c),policyVersion:1}),`issue:${model.issueRequest(i)}`,0,at,at];}}
  function* redemptions(){for(let i=0;i<p.couponRedemptionCount;i+=1){const o=model.orderFact(i%p.orderCount),c=i%p.couponCampaignCount,u=model.couponUserIndex(i),created=couponAt(i),discount=Math.min(5000,o.amount),snapshot={orderId:o.orderId,amount:o.amount,currency:'KRW'},at=iso(created);yield[model.redemption(i),model.userCoupon(i),model.campaign(c),model.user(u),o.orderId,'confirm',`dataset:${model.token}:${o.orderId}`,'confirmed',1,json(snapshot),createHash('sha256').update(json(snapshot)).digest('hex'),at,`${discount}.0000`,`${o.amount-discount}.0000`,'KRW',json([{bearerType:'platform',amount:discount}]),iso(date(created,10_000)),json({status:'confirmed',discountAmount:discount}),json({orderId:o.orderId}),0,at,iso(date(created,10_000))];}}
  const benefit=json({type:'fixed_amount',amount:{amount:'5000.0000',currency:'KRW'}});
  function* wallet(){for(let i=0;i<p.userCouponCount;i+=1){const c=i%p.couponCampaignCount,u=model.couponUserIndex(i),created=couponAt(i),[,display,expires]=status(i,created);yield[model.user(u),model.userCoupon(i),model.campaign(c),`Benchmark campaign ${String(c).padStart(4,'0')}`,benefit,display,iso(new Date(Math.min(created.getTime(),expires.getTime()-1000))),iso(expires),model.uuid('coupon-projection-event',i),1,iso(created)];}}
  function* details(){for(let i=0;i<p.userCouponCount;i+=1){const c=i%p.couponCampaignCount,u=model.couponUserIndex(i),created=couponAt(i),[,display,expires]=status(i,created),uc=model.userCoupon(i),usable=iso(new Date(Math.min(created.getTime(),expires.getTime()-1000))),detail={userCouponId:uc,campaignId:model.campaign(c),displayName:`Benchmark campaign ${String(c).padStart(4,'0')}`,benefit:JSON.parse(benefit),status:display,usableFrom:usable,expiresAt:iso(expires),policyVersion:1,applicability:{policySchemaVersion:1,includeTargets:[],excludeTargets:[]},issuerAndFunding:{issuerType:'platform',issuerRef:{context:'coupon',type:'platform',id:'dropmong'},funderType:'platform'}};yield[uc,model.user(u),model.campaign(c),1,json(detail),model.uuid('coupon-projection-event',i),1,iso(created)];}}
  yield plan('coupon_service','coupon_campaigns',['campaign_id','display_name','description','status','starts_at','ends_at','claim_starts_at','claim_ends_at','current_policy_version','total_quantity','per_user_limit','reserved_quantity','confirmed_quantity','issuer_type','issuer_ref','funder_type','funder_ref','platform_share_percentage','approval_ref','owner_snapshot','version','created_at','updated_at'],campaigns());
  yield plan('coupon_service','coupon_campaign_policy_versions',['campaign_id','policy_version','effective_at','issuer_and_funding','created_at'],policies());yield plan('coupon_service','coupon_benefits',['benefit_id','campaign_id','policy_version','benefit_type','amount','currency','created_at'],benefits());yield plan('coupon_service','coupon_applicability_policies',['policy_id','campaign_id','policy_version','policy_schema_version','target_type','target_ref','inclusion','effective_from','snapshot_label','created_at'],applicability());yield plan('coupon_service','coupon_issue_requests',['issue_request_id','campaign_id','user_id','business_key','source_type','source_ref','status','user_coupon_id','retry_count','issuer_and_funding_snapshot','policy_snapshot','approval_ref','result_ref','version','created_at','updated_at'],requests());yield plan('coupon_service','user_coupons',['user_coupon_id','campaign_id','policy_version','user_id','issue_request_id','status','usable_from','expires_at','grant_snapshot','result_ref','version','created_at','updated_at'],userCoupons());yield plan('coupon_service','coupon_redemptions',['redemption_id','user_coupon_id','campaign_id','user_id','order_id','operation_type','business_key','status','policy_version','order_snapshot','order_snapshot_hash','evaluated_at','discount_amount','final_order_amount','currency','cost_attribution','confirmed_at','result_ref','result_snapshot','version','created_at','updated_at'],redemptions());yield plan('coupon_service','rm_user_coupon_wallet',['user_id','user_coupon_id','campaign_id','display_name','benefit','display_status','usable_from','expires_at','last_event_id','projection_version','updated_at'],wallet());yield plan('coupon_service','rm_coupon_details',['user_coupon_id','user_id','campaign_id','policy_version','detail','last_event_id','projection_version','updated_at'],details());
}

const BUILDERS={'auth-service':authPlans,'user-service':userPlans,'catalog-service':catalogPlans,'coupon-service':couponPlans,'interest-service':interestPlans,'order-service':orderPlans,'payment-service':paymentPlans,'notification-service':notificationPlans};
export function plansForService(service,model){const builder=BUILDERS[service];if(!builder)throw new TypeError(`unsupported dataset service: ${service}`);return builder(model);}
export function tableContracts(service,model){return Array.from(plansForService(service,model),({table,columns})=>({table,columns}));}
