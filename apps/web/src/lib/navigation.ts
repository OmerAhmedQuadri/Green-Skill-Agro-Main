import type { PermissionCode } from '@gsa/core';

/**
 * Console navigation (USR-008): an item is present only if the user holds a
 * permission that makes it useful — absent, never disabled. Later milestones
 * add their modules here.
 */
export type NavIcon = 'dashboard' | 'users';
type NavItem = { href: string; key: 'dashboard' | 'users'; icon: NavIcon; visible: (p: ReadonlySet<PermissionCode>) => boolean };

export const CONSOLE_NAV: readonly NavItem[] = [
  { href: '/console/dashboard', key: 'dashboard', icon: 'dashboard', visible: () => true },
  { href: '/console/users', key: 'users', icon: 'users', visible: (p) => p.has('users.manage_staff') || p.has('users.manage_admins') },
];

export const canAdministerUsers = (p: ReadonlySet<PermissionCode>) => p.has('users.manage_staff') || p.has('users.manage_admins');
