import { DomainError } from '../errors';
import { PERMISSION_MATRIX, PERMISSION_CODES, type Grant, type PermissionCode } from './permission-catalogue';
import type { Role } from './roles';

const COLUMN: Record<Role, 1 | 2 | 3 | 4> = { SUPER_ADMIN: 1, ADMIN: 2, MANAGER: 3, SELLER: 4 };
const GRANTS = new Map(PERMISSION_MATRIX.map((row) => [row[0], row]));

/** Per-user grants (true) and withdrawals (false) of configurable permissions. */
export type PermissionOverrides = ReadonlyMap<PermissionCode, boolean>;

export function grantFor(role: Role, code: PermissionCode): Grant {
  const row = GRANTS.get(code);
  if (!row) throw new DomainError('NOT_FOUND', { permission: code });
  return row[COLUMN[role]];
}

/** Configurable per user for this role — `Config` in the matrix. */
export function isConfigurable(role: Role, code: PermissionCode): boolean {
  const grant = grantFor(role, code);
  return grant === 'ON' || grant === 'OFF';
}

export function configurableFor(role: Role): readonly PermissionCode[] {
  return PERMISSION_CODES.filter((code) => isConfigurable(role, code));
}

/**
 * Role defaults overlaid with per-user overrides (PERMISSIONS §1). An override
 * can only move a configurable permission; FULL and NONE are fixed.
 */
export function effectivePermissions(role: Role, overrides: PermissionOverrides): ReadonlySet<PermissionCode> {
  const held = new Set<PermissionCode>();
  for (const code of PERMISSION_CODES) {
    const grant = grantFor(role, code);
    const on = grant === 'FULL' || ((grant === 'ON' || grant === 'OFF') && (overrides.get(code) ?? grant === 'ON'));
    if (on) held.add(code);
  }
  return held;
}

export function can(permissions: ReadonlySet<PermissionCode>, code: PermissionCode): boolean {
  return permissions.has(code);
}

/** Which account tiers an actor may create, modify or deactivate (PERMISSIONS §3.2). */
export function manageableRoles(actor: ReadonlySet<PermissionCode>): ReadonlySet<Role> {
  const roles = new Set<Role>();
  if (actor.has('users.manage_admins')) { roles.add('SUPER_ADMIN'); roles.add('ADMIN'); }
  if (actor.has('users.manage_staff')) { roles.add('MANAGER'); roles.add('SELLER'); }
  return roles;
}

export function assertCanManageAccount(actor: ReadonlySet<PermissionCode>, targetRole: Role): void {
  if (!manageableRoles(actor).has(targetRole)) {
    throw new DomainError('ACCOUNT_TIER_FORBIDDEN', { targetRole });
  }
}

/**
 * Validates a change to another user's Config permissions (USR-005..007,
 * PERMISSIONS §3.2): the actor must manage permissions, manage that account
 * tier, and hold every permission they grant or withdraw.
 */
export function assertCanChangePermissions(
  actor: ReadonlySet<PermissionCode>,
  targetRole: Role,
  changes: PermissionOverrides,
): void {
  if (!actor.has('users.manage_permissions')) {
    throw new DomainError('FORBIDDEN', { permission: 'users.manage_permissions' });
  }
  assertCanManageAccount(actor, targetRole);
  for (const code of changes.keys()) {
    if (!isConfigurable(targetRole, code)) {
      throw new DomainError('PERMISSION_NOT_CONFIGURABLE', { permission: code, targetRole });
    }
    if (!actor.has(code)) {
      throw new DomainError('FORBIDDEN', { permission: code, reason: 'NOT_HELD_BY_ACTOR' });
    }
  }
}
