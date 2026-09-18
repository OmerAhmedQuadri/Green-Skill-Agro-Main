import pg from 'pg';
import { syncReferenceData } from '../src/reference-data';

// The owner connection exists only to reset state between tests — the code
// under test always runs as the runtime role.
let owner: pg.Pool | undefined;
const ownerPool = () => (owner ??= new pg.Pool({ connectionString: process.env.DATABASE_OWNER_URL, max: 2 }));

const TABLES = [
  'users', 'sessions', 'user_permissions', 'audit_log', 'idempotency_keys', 'rate_limits', 'media_assets', 'email_outbox',
  'password_reset_tokens', 'vendors', 'categories', 'sub_categories', 'product_types', 'product_type_attributes', 'products',
  'varieties', 'skus', 'price_lists', 'price_list_items', 'sku_discount_ceilings', 'system_settings', 'feature_toggles',
  'ceilings', 'commission_rates', 'batches', 'stock_movements', 'purchase_orders', 'purchase_order_lines',
  'purchase_order_events', 'goods_receipts', 'goods_receipt_lines', 'document_sequences',
];

/**
 * Clears everything except fixed reference data (branches, warehouses,
 * permissions, presets). Product types and the base price list are editable,
 * so they are cleared and re-synced to their defaults for every test.
 */
export async function resetDatabase(): Promise<void> {
  await ownerPool().query(`TRUNCATE ${TABLES.join(', ')} CASCADE`);
  await syncReferenceData();
}

export async function ownerQuery<T extends pg.QueryResultRow>(text: string, values: unknown[] = []): Promise<T[]> {
  return (await ownerPool().query<T>(text, values)).rows;
}

export async function closeOwner(): Promise<void> {
  await owner?.end();
  owner = undefined;
}
