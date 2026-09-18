/**
 * The scope §05 capability matrix as data (docs/PERMISSIONS.md §2). This is the
 * single source: the database `permissions` table is seeded from it, and
 * `PermissionCode` is derived from it.
 *
 *   FULL — always held by the role, cannot be withdrawn
 *   ON   — configurable per user, granted by default
 *   OFF  — configurable per user, withheld by default
 *   NONE — never held
 */
export type Grant = 'FULL' | 'ON' | 'OFF' | 'NONE';

type Row = readonly [code: string, sa: Grant, admin: Grant, manager: Grant, seller: Grant];

const F = 'FULL', ON = 'ON', OFF = 'OFF', NO = 'NONE';

export const PERMISSION_MATRIX = [
  // Users
  ['users.manage_admins',             F, NO, NO,  NO],
  ['users.manage_staff',              F, F,  OFF, NO],
  ['users.manage_permissions',        F, F,  NO,  NO],
  // System
  ['system.configure',                F, F,  NO,  NO],
  ['system.manage_templates',         F, F,  NO,  NO],
  ['system.set_limits',               F, F,  NO,  NO],
  ['system.view_audit_log',           F, F,  NO,  NO],
  // Catalogue, pricing, vendors
  ['catalogue.view',                  F, F,  OFF, NO],
  ['catalogue.manage_structure',      F, F,  OFF, NO],
  ['catalogue.manage_products',       F, F,  OFF, NO],
  ['pricing.manage_price_lists',      F, F,  OFF, NO],
  ['pricing.set_discount_ceilings',   F, F,  OFF, NO],
  ['vendors.manage',                  F, F,  NO,  NO],   // OQ-013: Admin too
  ['vendors.view',                    F, F,  OFF, NO],
  // Procurement
  ['procurement.view',                F, F,  OFF, NO],
  ['procurement.manage_po',           F, F,  OFF, NO],
  ['procurement.approve_po',          F, F,  NO,  NO],
  // Inventory and vehicles
  ['inventory.view_all_stock',        F, F,  OFF, NO],
  ['inventory.view_own_vehicle',      F, F,  F,   F],
  ['inventory.receive_goods',         F, F,  OFF, NO],
  ['inventory.bulk_import',           F, F,  OFF, NO],
  ['inventory.convert',               F, F,  OFF, OFF],  // CNV-009
  ['inventory.submit_write_off',      F, F,  OFF, ON],   // workflow E
  ['inventory.approve_write_off',     F, F,  OFF, NO],
  ['inventory.issue_to_vehicle',      F, F,  OFF, NO],
  ['inventory.audit_vehicle',         F, F,  OFF, NO],
  ['inventory.manage_expiry',         F, F,  OFF, NO],
  ['vehicles.manage',                 F, F,  OFF, NO],
  // Stores
  ['stores.onboard',                  F, F,  F,   F],
  ['stores.set_credit_cycle',         F, F,  F,   F],   // OQ-010
  ['stores.view_all',                 F, F,  OFF, NO],
  ['stores.approve',                  F, F,  OFF, NO],
  ['stores.edit_terms',               F, F,  OFF, NO],
  ['stores.reassign',                 F, F,  OFF, NO],
  ['stores.override_credit_block',    F, F,  OFF, NO],
  // Sales and dispatch
  ['sales.record',                    F, F,  F,   F],
  ['sales.apply_discount',            F, F,  F,   F],
  ['sales.approve_discount',          F, F,  OFF, NO],   // OQ-001
  ['sales.view_all',                  F, F,  OFF, NO],
  ['sales.request_dispatch',          F, F,  F,   F],
  ['sales.fulfil_dispatch',           F, F,  OFF, NO],
  ['sales.create_order_for_seller',   F, F,  OFF, NO],
  ['sales.confirm_dispatch_receipt',  F, F,  F,   F],
  ['sales.approve_lost_order',        F, F,  OFF, NO],
  // Returns, cash, attendance, targets, reports
  ['returns.process',                 F, F,  OFF, ON],   // workflow L
  ['returns.set_rules',               F, F,  OFF, NO],
  ['cash.view_cash_in_hand',          F, F,  OFF, NO],
  ['cash.approve_settlement',         F, F,  OFF, NO],
  ['attendance.view',                 F, F,  OFF, NO],
  ['attendance.manage',               F, F,  OFF, NO],
  ['targets.manage',                  F, F,  OFF, NO],
  ['targets.view_own',                F, F,  F,   F],
  ['targets.view_commission',         F, F,  OFF, ON],   // TGT-004
  ['reports.view_trends',             F, F,  OFF, NO],
  ['reports.view_forecast',           F, F,  OFF, NO],
  // Field self-service — the seller of record only (PERMISSIONS §2)
  ['attendance.self',                 NO, NO, NO, F],
  ['inventory.confirm_load',          NO, NO, NO, F],
  ['inventory.declare_closing_stock', NO, NO, NO, F],
  ['cash.submit_settlement',          NO, NO, NO, F],
] as const satisfies readonly Row[];

export type PermissionCode = (typeof PERMISSION_MATRIX)[number][0];

export const PERMISSION_CODES: readonly PermissionCode[] = PERMISSION_MATRIX.map(([code]) => code);

export function moduleOf(code: PermissionCode): string {
  return code.slice(0, code.indexOf('.'));
}

const KNOWN = new Set<string>(PERMISSION_CODES);

/** Narrows an untrusted string (e.g. validated API input) to a PermissionCode. */
export function isPermissionCode(value: string): value is PermissionCode {
  return KNOWN.has(value);
}
