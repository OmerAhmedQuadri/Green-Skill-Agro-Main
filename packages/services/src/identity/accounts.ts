import {
  assertCanChangePermissions, assertCanManageAccount, configurableFor, DomainError, effectivePermissions,
  manageableRoles, normaliseEmail, normalisePhone, presetOverrides, PERMISSION_CODES,
  type PermissionCode, type PermissionOverrides, type Role, type UserId,
} from '@gsa/core';
import { schema } from '@gsa/db';
import { and, asc, eq, gt, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { Ctx } from '../context';
import { audit, inTx, type Executor } from '../platform';
import { getDb } from '../runtime';
import { hashPassword } from './password';
import { loadOverrides } from './permission-store';
import { revokeAllSessions } from './sessions';
import { newTemporaryPassword } from './tokens';

const { users, userPermissions, permissionPresetGrants } = schema;

export type AccountSummary = {
  readonly id: UserId;
  readonly role: Role;
  readonly name: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly status: 'ACTIVE' | 'DEACTIVATED';
  readonly locale: 'en' | 'ar';
  readonly mustChangePassword: boolean;
  readonly version: number;
};

export type AccountDetail = AccountSummary & {
  readonly permissions: readonly PermissionCode[];
  readonly overrides: readonly { readonly permission: PermissionCode; readonly granted: boolean }[];
  readonly configurable: readonly PermissionCode[];
};

const summaryColumns = {
  id: users.id, role: users.role, name: users.name, email: users.email, phone: users.phone,
  status: users.status, locale: users.locale, mustChangePassword: users.mustChangePassword, version: users.version,
};

const toSummary = (row: { id: string } & Omit<AccountSummary, 'id'>): AccountSummary => ({ ...row, id: row.id as UserId });
const sorted = (set: ReadonlySet<PermissionCode>) => [...set].sort();

function assertManagesAnyone(ctx: Ctx): readonly Role[] {
  const roles = [...manageableRoles(ctx.permissions)];
  if (roles.length === 0) throw new DomainError('FORBIDDEN', { permission: 'users.manage_staff' });
  return roles;
}

/** Loads an account the actor may manage. Others are reported as not found, never forbidden (SECURITY §3). */
async function loadManageable(db: Executor, ctx: Ctx, id: string) {
  const [row] = await db.select().from(users).where(eq(users.id, id));
  if (!row || !manageableRoles(ctx.permissions).has(row.role)) throw new DomainError('NOT_FOUND', { entity: 'user', id });
  return row;
}

async function detail(db: Executor, row: { id: string } & Omit<AccountSummary, 'id'>): Promise<AccountDetail> {
  const id = row.id as UserId;
  const overrides = await loadOverrides(db, id);
  return {
    ...toSummary(row),
    permissions: sorted(effectivePermissions(row.role, overrides)),
    overrides: [...overrides].map(([permission, granted]) => ({ permission, granted })),
    configurable: configurableFor(row.role),
  };
}

function identifiers(input: { email?: string | null | undefined; phone?: string | null | undefined }) {
  const email = input.email ? normaliseEmail(input.email) : null;
  const phone = input.phone ? normalisePhone(input.phone) : null;
  return { email, phone };
}

async function assertIdentifiersFree(db: Executor, ids: { email: string | null; phone: string | null }, exceptId?: string) {
  // The unique indexes are the real guarantee; this turns a clash into a clear error.
  if (ids.email) {
    const rows = await db.select({ id: users.id }).from(users).where(eq(users.email, ids.email));
    if (rows.some((r) => r.id !== exceptId)) throw new DomainError('DUPLICATE_EMAIL', { email: ids.email });
  }
  if (ids.phone) {
    const rows = await db.select({ id: users.id }).from(users).where(eq(users.phone, ids.phone));
    if (rows.some((r) => r.id !== exceptId)) throw new DomainError('DUPLICATE_PHONE', { phone: ids.phone });
  }
}

// ---------------------------------------------------------------- queries

export async function listAccounts(
  ctx: Ctx,
  filter: {
    role?: Role | undefined; status?: 'ACTIVE' | 'DEACTIVATED' | undefined;
    search?: string | undefined; cursor?: string | undefined; limit?: number | undefined;
  } = {},
): Promise<{ items: AccountSummary[]; nextCursor: string | null }> {
  const roles = assertManagesAnyone(ctx);
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const where: SQL[] = [inArray(users.role, filter.role ? roles.filter((r) => r === filter.role) : roles)];
  if (filter.status) where.push(eq(users.status, filter.status));
  if (filter.search) {
    const q = `%${filter.search.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    where.push(or(ilike(users.name, q), ilike(users.email, q), ilike(users.phone, q)) as SQL);
  }
  if (filter.cursor) where.push(gt(users.id, filter.cursor));
  const rows = await getDb().select(summaryColumns).from(users).where(and(...where)).orderBy(asc(users.id)).limit(limit + 1);
  const page = rows.slice(0, limit).map(toSummary);
  return { items: page, nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null };
}

export async function getAccount(ctx: Ctx, id: string): Promise<AccountDetail> {
  assertManagesAnyone(ctx);
  const db = getDb();
  return detail(db, await loadManageable(db, ctx, id));
}

// ---------------------------------------------------------------- commands

/** USR-002/003: provisions an account with a temporary password that must be changed. */
export async function createAccount(
  ctx: Ctx,
  input: { role: Role; name: string; email?: string | null | undefined; phone?: string | null | undefined; locale?: 'en' | 'ar' | undefined },
): Promise<{ account: AccountDetail; temporaryPassword: string }> {
  assertCanManageAccount(ctx.permissions, input.role);
  const ids = identifiers(input);
  if (!ids.email && !ids.phone) throw new DomainError('SIGN_IN_IDENTIFIER_REQUIRED');
  const temporaryPassword = newTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  return inTx(ctx, async (tx) => {
    await assertIdentifiersFree(tx, ids);
    const [row] = await tx.insert(users).values({
      branchId: ctx.branchId, role: input.role, name: input.name.trim(), ...ids, passwordHash,
      mustChangePassword: true, locale: input.locale ?? 'en', createdBy: ctx.user.id, updatedBy: ctx.user.id,
    }).returning(summaryColumns);
    if (!row) throw new Error('account insert returned nothing');
    await audit(tx, ctx, {
      action: 'identity.account_created', entityType: 'user', entityId: row.id,
      after: { role: row.role, name: row.name, email: row.email, phone: row.phone },
    });
    return { account: await detail(tx, row), temporaryPassword };
  });
}

export async function updateAccount(
  ctx: Ctx,
  id: string,
  input: {
    version: number; name?: string | undefined; email?: string | null | undefined;
    phone?: string | null | undefined; locale?: 'en' | 'ar' | undefined;
  },
): Promise<AccountDetail> {
  return inTx(ctx, async (tx) => {
    const current = await loadManageable(tx, ctx, id);
    const ids = identifiers({
      email: input.email === undefined ? current.email : input.email,
      phone: input.phone === undefined ? current.phone : input.phone,
    });
    if (!ids.email && !ids.phone) throw new DomainError('SIGN_IN_IDENTIFIER_REQUIRED');
    await assertIdentifiersFree(tx, ids, id);
    const [row] = await tx.update(users)
      .set({ name: input.name?.trim() ?? current.name, ...ids, locale: input.locale ?? current.locale,
        updatedAt: ctx.now, updatedBy: ctx.user.id, version: current.version + 1 })
      .where(and(eq(users.id, id), eq(users.version, input.version)))
      .returning(summaryColumns);
    if (!row) throw new DomainError('VERSION_CONFLICT', { entity: 'user', id });
    await audit(tx, ctx, {
      action: 'identity.account_updated', entityType: 'user', entityId: id,
      before: { name: current.name, email: current.email, phone: current.phone, locale: current.locale },
      after: { name: row.name, email: row.email, phone: row.phone, locale: row.locale },
    });
    return detail(tx, row);
  });
}

/** Deactivation ends every session immediately (ADR-0018). */
export async function setAccountStatus(
  ctx: Ctx, id: string, status: 'ACTIVE' | 'DEACTIVATED', version: number,
): Promise<AccountDetail> {
  if (status === 'DEACTIVATED' && id === ctx.user.id) throw new DomainError('CANNOT_DEACTIVATE_SELF');
  return inTx(ctx, async (tx) => {
    const current = await loadManageable(tx, ctx, id);
    const [row] = await tx.update(users)
      .set({ status, updatedAt: ctx.now, updatedBy: ctx.user.id, version: current.version + 1 })
      .where(and(eq(users.id, id), eq(users.version, version)))
      .returning(summaryColumns);
    if (!row) throw new DomainError('VERSION_CONFLICT', { entity: 'user', id });
    if (status === 'DEACTIVATED') await revokeAllSessions(tx, id as UserId);
    await audit(tx, ctx, {
      action: status === 'DEACTIVATED' ? 'identity.account_deactivated' : 'identity.account_reactivated',
      entityType: 'user', entityId: id, before: { status: current.status }, after: { status },
    });
    return detail(tx, row);
  });
}

/** A temporary password, shown once; the account must change it at next sign-in (ADR-0018). */
export async function resetAccountPassword(ctx: Ctx, id: string): Promise<{ temporaryPassword: string }> {
  const temporaryPassword = newTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  return inTx(ctx, async (tx) => {
    await loadManageable(tx, ctx, id);
    await tx.update(users)
      .set({ passwordHash, mustChangePassword: true, failedSignIns: 0, lockedUntil: null, updatedAt: ctx.now, updatedBy: ctx.user.id })
      .where(eq(users.id, id));
    await revokeAllSessions(tx, id as UserId);
    await audit(tx, ctx, { action: 'identity.password_reset', entityType: 'user', entityId: id });
    return { temporaryPassword };
  });
}

/**
 * The value this row carried into the statement, for an upsert's `set`. The
 * name comes from the schema because a Drizzle field and its column need not
 * agree — `grantedAt` is the column `created_at` — and a guess compiles.
 */
const excluded = (column: { name: string }) => sql.raw(`excluded."${column.name}"`);

/**
 * One statement, not one per permission. A preset carries around forty
 * overrides, and inserting them in a loop meant forty sequential round trips
 * inside the transaction — enough to take seventeen seconds on a busy machine,
 * which is how it was found.
 */
async function replaceOverrides(tx: Executor, ctx: Ctx, userId: string, overrides: PermissionOverrides, replaceAll: boolean) {
  if (replaceAll) await tx.delete(userPermissions).where(eq(userPermissions.userId, userId));
  const rows = [...overrides].map(([permission, granted]) => ({
    userId, permission, granted, grantedBy: ctx.user.id, grantedAt: ctx.now,
  }));
  if (rows.length === 0) return;
  await tx.insert(userPermissions).values(rows).onConflictDoUpdate({
    target: [userPermissions.userId, userPermissions.permission],
    // `excluded` is the row this statement tried to insert, so every row takes
    // its own value rather than the last one's (a plain object would).
    set: {
      granted: excluded(userPermissions.granted),
      grantedBy: excluded(userPermissions.grantedBy),
      grantedAt: excluded(userPermissions.grantedAt),
    },
  });
}

/** USR-005..007, USR-011: grant or withdraw individual Config permissions, audited before/after. */
export async function changeAccountPermissions(
  ctx: Ctx, id: string, changes: readonly { permission: PermissionCode; granted: boolean }[],
): Promise<AccountDetail> {
  return inTx(ctx, async (tx) => {
    const target = await loadManageable(tx, ctx, id);
    const requested: PermissionOverrides = new Map(changes.map((c) => [c.permission, c.granted]));
    assertCanChangePermissions(ctx.permissions, target.role, requested);
    const before = effectivePermissions(target.role, await loadOverrides(tx, id as UserId));
    await replaceOverrides(tx, ctx, id, requested, false);
    const after = effectivePermissions(target.role, await loadOverrides(tx, id as UserId));
    await audit(tx, ctx, {
      action: 'identity.permissions_changed', entityType: 'user', entityId: id,
      before: { permissions: sorted(before) }, after: { permissions: sorted(after), changes },
    });
    return detail(tx, target);
  });
}

/** USR-014: a preset replaces every Config grant on a Manager account. */
export async function applyPresetToAccount(ctx: Ctx, id: string, presetCode: string): Promise<AccountDetail> {
  return inTx(ctx, async (tx) => {
    const target = await loadManageable(tx, ctx, id);
    if (target.role !== 'MANAGER') throw new DomainError('PRESET_NOT_APPLICABLE', { role: target.role });
    const grants = await tx.select({ permission: permissionPresetGrants.permission })
      .from(permissionPresetGrants).where(eq(permissionPresetGrants.presetCode, presetCode));
    if (grants.length === 0) throw new DomainError('NOT_FOUND', { entity: 'permission_preset', code: presetCode });
    const known = new Set<string>(PERMISSION_CODES);
    const overrides = presetOverrides(grants.map((g) => g.permission).filter((p): p is PermissionCode => known.has(p)));
    assertCanChangePermissions(ctx.permissions, target.role, overrides);
    const before = effectivePermissions(target.role, await loadOverrides(tx, id as UserId));
    await replaceOverrides(tx, ctx, id, overrides, true);
    await audit(tx, ctx, {
      action: 'identity.preset_applied', entityType: 'user', entityId: id,
      before: { permissions: sorted(before) }, after: { preset: presetCode, permissions: sorted(effectivePermissions(target.role, overrides)) },
    });
    return detail(tx, target);
  });
}

export async function listPresets(ctx: Ctx): Promise<{ code: string; permissions: PermissionCode[] }[]> {
  if (!ctx.permissions.has('users.manage_permissions')) throw new DomainError('FORBIDDEN', { permission: 'users.manage_permissions' });
  const rows = await getDb().select().from(permissionPresetGrants).orderBy(asc(permissionPresetGrants.presetCode));
  const byPreset = new Map<string, PermissionCode[]>();
  for (const r of rows) byPreset.set(r.presetCode, [...(byPreset.get(r.presetCode) ?? []), r.permission as PermissionCode]);
  return [...byPreset].map(([code, permissions]) => ({ code, permissions: permissions.sort() }));
}
