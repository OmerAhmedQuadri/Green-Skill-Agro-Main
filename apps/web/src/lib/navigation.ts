import type { PermissionCode } from '@gsa/core';

/**
 * Console navigation (USR-008): an item is present only if the user holds a
 * permission that makes it useful — absent, never disabled. Later milestones
 * add their modules here.
 */
export type NavIcon =
  | 'dashboard' | 'users' | 'catalogue' | 'vendors' | 'pricing' | 'settings' | 'purchaseOrders' | 'incoming' | 'stock' | 'writeOffs' | 'expiry'
  | 'vehicles' | 'attendance' | 'closingStock';
type Can = (p: ReadonlySet<PermissionCode>) => boolean;
type NavItem = { href: string; key: NavIcon; icon: NavIcon; visible: Can };

const any = (...codes: PermissionCode[]): Can => (p) => codes.some((c) => p.has(c));

export const canAdministerUsers = any('users.manage_staff', 'users.manage_admins');
export const canSeeCatalogue = any('catalogue.view', 'catalogue.manage_structure', 'catalogue.manage_products');
export const canSeeVendors = any('vendors.view');
export const canSeePricing = any('pricing.manage_price_lists', 'pricing.set_discount_ceilings');
export const canSeePurchaseOrders = any('procurement.view', 'procurement.manage_po', 'procurement.approve_po', 'inventory.receive_goods');
export const canSeeIncoming = any('procurement.view', 'procurement.manage_po', 'procurement.approve_po', 'inventory.view_all_stock', 'inventory.receive_goods');
export const canSeeStock = any('inventory.view_all_stock');
export const canSeeWriteOffs = any('inventory.submit_write_off', 'inventory.approve_write_off');
export const canSeeExpiry = any('inventory.view_all_stock', 'inventory.manage_expiry');
export const canSeeVehicles = any('vehicles.manage', 'inventory.issue_to_vehicle', 'inventory.view_all_stock');
export const canSeeAttendance = any('attendance.view', 'attendance.manage');
export const canSeeClosingStock = any('inventory.audit_vehicle');
export const canSeeSettings = any('system.configure', 'system.manage_templates', 'system.set_limits', 'returns.set_rules', 'targets.manage');

export const CONSOLE_NAV: readonly NavItem[] = [
  { href: '/console/dashboard', key: 'dashboard', icon: 'dashboard', visible: () => true },
  { href: '/console/catalogue', key: 'catalogue', icon: 'catalogue', visible: canSeeCatalogue },
  { href: '/console/vendors', key: 'vendors', icon: 'vendors', visible: canSeeVendors },
  { href: '/console/pricing', key: 'pricing', icon: 'pricing', visible: canSeePricing },
  { href: '/console/purchase-orders', key: 'purchaseOrders', icon: 'purchaseOrders', visible: canSeePurchaseOrders },
  { href: '/console/incoming', key: 'incoming', icon: 'incoming', visible: canSeeIncoming },
  { href: '/console/stock', key: 'stock', icon: 'stock', visible: canSeeStock },
  { href: '/console/write-offs', key: 'writeOffs', icon: 'writeOffs', visible: canSeeWriteOffs },
  { href: '/console/expiry', key: 'expiry', icon: 'expiry', visible: canSeeExpiry },
  { href: '/console/vehicles', key: 'vehicles', icon: 'vehicles', visible: canSeeVehicles },
  { href: '/console/closing-stock', key: 'closingStock', icon: 'closingStock', visible: canSeeClosingStock },
  { href: '/console/attendance', key: 'attendance', icon: 'attendance', visible: canSeeAttendance },
  { href: '/console/users', key: 'users', icon: 'users', visible: canAdministerUsers },
  { href: '/console/settings', key: 'settings', icon: 'settings', visible: canSeeSettings },
];
