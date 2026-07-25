import { createHash } from 'node:crypto';
import { canonicalJson } from './profile.js';
import { copyGeneratedTable, sqlIdentifier } from './copy.js';
import { plansForService } from './plans.js';

export async function databaseCompatibility(client) {
  const version = await client.query("SELECT current_setting('server_version_num')::integer AS version");
  return { postgresMajor: Math.floor(Number(version.rows[0].version) / 10_000) };
}

export async function liveSchemaHash(client, contracts) {
  const tables = contracts.map(({ table }) => table);
  const result = await client.query(`SELECT table_name,column_name,data_type,udt_name,is_nullable,ordinal_position FROM information_schema.columns WHERE table_schema='public' AND table_name = ANY($1::text[]) ORDER BY table_name,ordinal_position`, [tables]);
  const missing = tables.filter((table) => !result.rows.some((row) => row.table_name === table));
  if (missing.length) throw new TypeError(`schema tables are missing: ${missing.join(', ')}`);
  return createHash('sha256').update(canonicalJson(result.rows)).digest('hex');
}

const AUTH_PRESERVED_TABLES = new Set(['auth_policies', 'auth_verification_policy_rules', 'auth_session_revocation_policy_rules', 'auth_policy_global_snapshots']);

export function isMigrationMetadataTable(table) {
  return table === 'alembic_version' || table === 'goose_db_version' || table.endsWith('_goose_db_version');
}

export async function truncateService(client, contracts, service) {
  const allowed = new Set(contracts.map(({ table }) => table));
  const tables = [...allowed]
    .filter((table) => !isMigrationMetadataTable(table) && !(service === 'auth-service' && AUTH_PRESERVED_TABLES.has(table)))
    .map(sqlIdentifier)
    .reverse();
  if (tables.length) await client.query(`TRUNCATE TABLE ${tables.join(', ')} RESTART IDENTITY CASCADE`);
}

export async function generateService(client, model, service, { batchRows = 10_000 } = {}) {
  const metrics = {}; let totalRows = 0; let copySeconds = 0; let generationSeconds = 0;
  for (const { table, columns, rows } of plansForService(service, model)) {
    let rowGenerationMs = 0;
    const timedRows = { [Symbol.iterator]() { const iterator = rows[Symbol.iterator](); return { next() { const started = performance.now(); const value = iterator.next(); rowGenerationMs += performance.now() - started; return value; } }; } };
    const started = performance.now(); const count = await copyGeneratedTable(client, table, columns, timedRows, { batchRows }); const total = (performance.now() - started) / 1000; const generation = rowGenerationMs / 1000; const copy = Math.max(0, total - generation);
    metrics[table] = { rows: count, generationSeconds: generation, copySeconds: copy }; totalRows += count; generationSeconds += generation; copySeconds += copy;
  }
  return { rows: totalRows, copySeconds, generationSeconds, tables: metrics };
}

const INVARIANTS = {
  'auth-service': [
    ['identity_graph', "SELECT count(*)::bigint AS count FROM auth_identities i LEFT JOIN auth_password_credentials p ON p.identity_id=i.identity_id AND p.password_status='active' LEFT JOIN auth_identity_links l ON l.identity_id=i.identity_id AND l.link_status='active' LEFT JOIN auth_user_auth_states s ON s.user_id=l.user_id WHERE p.identity_id IS NULL OR l.identity_id IS NULL OR s.user_id IS NULL"],
  ],
  'user-service': [['users_without_agreements', 'SELECT count(*)::bigint AS count FROM users u WHERE NOT EXISTS (SELECT 1 FROM user_agreement_acceptances a WHERE a.user_id=u.user_id)']],
  'catalog-service': [['products_without_inventory', 'SELECT count(*)::bigint AS count FROM products p LEFT JOIN inventory_projections i ON i.product_id=p.id WHERE i.product_id IS NULL']],
  'interest-service': [['interest_counter_mismatch', "SELECT count(*)::bigint AS count FROM (SELECT c.drop_id FROM drop_interest_counters c LEFT JOIN interests i ON i.drop_id=c.drop_id AND i.status='active' GROUP BY c.drop_id,c.interest_count HAVING c.interest_count <> count(i.id)) mismatch"]],
  // Outboxes are service-operational metadata. Dataset jobs neither truncate nor
  // interpret them: normal asynchronous delivery must not block a later seed.
  'order-service': [['inventory_inconsistent', 'SELECT count(*)::bigint AS count FROM inventory_items WHERE reserved_quantity + sold_quantity > total_quantity']],
  'payment-service': [['payments_without_orders', 'SELECT count(*)::bigint AS count FROM payments p LEFT JOIN known_orders o ON o.order_id=p.order_id WHERE o.order_id IS NULL OR o.user_id <> p.user_id OR o.amount <> p.amount'], ['duplicate_terminal_payment', 'SELECT count(*)::bigint AS count FROM (SELECT order_id FROM payments GROUP BY order_id HAVING count(*) > 1) d']],
  'notification-service': [['notification_processed_event_mismatch', 'SELECT count(*)::bigint AS count FROM notifications n FULL JOIN processed_events p ON p.event_id=n.event_id WHERE n.event_id IS NULL OR p.event_id IS NULL']],
  'coupon-service': [['coupon_issue_graph', 'SELECT count(*)::bigint AS count FROM coupon_issue_requests r LEFT JOIN user_coupons c ON c.issue_request_id=r.issue_request_id LEFT JOIN rm_user_coupon_wallet w ON w.user_coupon_id=c.user_coupon_id AND w.user_id=c.user_id LEFT JOIN rm_coupon_details d ON d.user_coupon_id=c.user_coupon_id AND d.user_id=c.user_id WHERE c.user_coupon_id IS NULL OR w.user_coupon_id IS NULL OR d.user_coupon_id IS NULL'], ['redemption_without_coupon', 'SELECT count(*)::bigint AS count FROM coupon_redemptions r LEFT JOIN user_coupons c ON c.user_coupon_id=r.user_coupon_id WHERE c.user_coupon_id IS NULL']],
};

export async function validateService(client, service, expectedRows) {
  const actual = {}; const failures = [];
  for (const [table, expected] of Object.entries(expectedRows)) { const result = await client.query(`SELECT count(*)::bigint AS count FROM ${sqlIdentifier(table)}`); const count = Number(result.rows[0].count); actual[table] = count; if (count !== expected) failures.push(`${table}: expected ${expected}, got ${count}`); }
  if (failures.length) throw new TypeError(`dataset row validation failed: ${failures.join('; ')}`);
  for (const [name, statement] of INVARIANTS[service] ?? []) { const result = await client.query(statement); const count = Number(result.rows[0].count); if (count !== 0) throw new TypeError(`${service} dataset invariant failed (${name}): ${count}`); }
  return actual;
}

export async function analyzeService(client, _contracts) { const started = performance.now(); await client.query('ANALYZE'); return (performance.now() - started) / 1000; }
