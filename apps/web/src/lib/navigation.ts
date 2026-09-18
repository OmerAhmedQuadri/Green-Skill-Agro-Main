import type { PermissionCode } from '@gsa/core';

/**
 * Console navigation (USR-008): an item is present only if the user holds a
 * permission that makes it useful — absent, never disabled. Later milestones
 * add their modules here.
 */
export type NavIcon = 'dashboard' | 'users' | 'catalogue' | 'vendors' | 'pricing' | 'settings';
type Can = (p: ReadonlySet<PermissionCode>) => boolean;
type NavItem = { href: string; key: NavIcon; icon: NavIcon; visible: Can };

const any = (...codes: PermissionCode[]): Can => (p) => codes.some((c) => p.has(c));

export const canAdministerUsers = any('users.manage_staff', 'users.manage_admins');
export const canSeeCatalogue = any('catalogue.view', 'catalogue.manage_structure', 'catalogue.manage_products');
export const canSeeVendors = any('vendors.view');
export const canSeePricing = any('pricing.manage_price_lists', 'pricing.set_discount_ceilings');
export const canSeeSettings = any('system.configure', 'system.manage_templates', 'system.set_limits', 'returns.set_rules', 'targets.manage');

export const CONSOLE_NAV: readonly NavItem[] = [
  { href: '/console/dashboard', key: 'dashboard', icon: 'dashboard', visible: () => true },
  { href: '/console/catalogue', key: 'catalogue', icon: 'catalogue', visible: canSeeCatalogue },
  { href: '/console/vendors', key: 'vendors', icon: 'vendors', visible: canSeeVendors },
  { href: '/console/pricing', key: 'pricing', icon: 'pricing', visible: canSeePricing },
  { href: '/console/users', key: 'users', icon: 'users', visible: canAdministerUsers },
  { href: '/console/settings', key: 'settings', icon: 'settings', visible: canSeeSettings },
];
