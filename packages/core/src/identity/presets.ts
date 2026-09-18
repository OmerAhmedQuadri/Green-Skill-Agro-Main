import { configurableFor } from './permissions';
import type { PermissionCode } from './permission-catalogue';
import type { PermissionOverrides } from './permissions';

/**
 * Seed definitions for Manager presets (PERMISSIONS §4, USR-014). The database
 * copy is editable by holders of `system.configure`; these are the defaults.
 */
export const PRESET_DEFAULTS = {
  WAREHOUSE: [
    'catalogue.view', 'procurement.view', 'inventory.view_all_stock', 'inventory.receive_goods',
    'inventory.bulk_import', 'inventory.convert', 'inventory.submit_write_off',
    'inventory.issue_to_vehicle', 'inventory.manage_expiry', 'sales.fulfil_dispatch',
  ],
  SALES_MANAGER: [
    'catalogue.view', 'inventory.view_all_stock', 'inventory.audit_vehicle', 'inventory.approve_write_off',
    'vehicles.manage', 'stores.view_all', 'stores.approve', 'stores.edit_terms', 'stores.reassign',
    'stores.override_credit_block', 'sales.view_all', 'sales.approve_discount',
    'sales.create_order_for_seller', 'sales.approve_lost_order', 'returns.process',
    'cash.view_cash_in_hand', 'cash.approve_settlement', 'attendance.view', 'attendance.manage',
    'targets.view_commission', 'reports.view_trends',
  ],
  OPERATIONS_MANAGER: configurableFor('MANAGER'),
} as const satisfies Record<string, readonly PermissionCode[]>;

export type PresetCode = keyof typeof PRESET_DEFAULTS;

/**
 * Applying a preset **replaces** the account's Config grants — every
 * configurable permission is set explicitly on or off (PERMISSIONS §4).
 */
export function presetOverrides(grants: readonly PermissionCode[]): PermissionOverrides {
  const on = new Set(grants);
  return new Map(configurableFor('MANAGER').map((code) => [code, on.has(code)]));
}
