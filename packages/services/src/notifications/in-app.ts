import { effectivePermissions, isPermissionCode, type NotificationKind, type PermissionCode } from '@gsa/core';
import { schema } from '@gsa/db';
import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Ctx } from '../context';
import { inTx, type Executor } from '../platform';
import { getDb } from '../runtime';

const { notifications, users, userPermissions } = schema;

export type Recipients = { readonly users: readonly string[] } | { readonly permission: PermissionCode };
export type NotificationParams = Readonly<Record<string, string | number | null>>;

/** Every active account holding a permission, by role default or override. */
export async function usersWithPermission(db: Executor, permission: PermissionCode): Promise<string[]> {
  // One after the other: `db` is usually a transaction — a single connection.
  const accounts = await db.select({ id: users.id, role: users.role }).from(users).where(eq(users.status, 'ACTIVE'));
  const overrides = await db.select({ userId: userPermissions.userId, permission: userPermissions.permission, granted: userPermissions.granted })
    .from(userPermissions).where(eq(userPermissions.permission, permission));
  return accounts
    .filter((a) => {
      const own = overrides.filter((o) => o.userId === a.id && isPermissionCode(o.permission))
        .map((o) => [o.permission as PermissionCode, o.granted] as const);
      return effectivePermissions(a.role, new Map(own)).has(permission);
    })
    .map((a) => a.id);
}

/**
 * ADR-0034: written in the caller's transaction, so a rolled-back change
 * notifies nobody. The actor is never notified of their own action.
 */
export async function notify(
  tx: Executor, ctx: Ctx, to: Recipients, kind: NotificationKind, params: NotificationParams, link: string | null = null,
): Promise<void> {
  const ids = 'users' in to ? [...new Set(to.users)] : await usersWithPermission(tx, to.permission);
  const recipients = ids.filter((id) => id !== ctx.user.id);
  if (recipients.length === 0) return;
  await tx.insert(notifications).values(recipients.map((userId) => ({
    userId, kind, params, link, createdAt: ctx.now, branchId: ctx.branchId,
  })));
}

export type Notification = {
  readonly id: string; readonly kind: NotificationKind; readonly params: NotificationParams; readonly link: string | null;
  readonly createdAt: Date; readonly read: boolean;
};

/** The bell: my latest notifications and how many are unread. Polled every 30 s. */
export async function listMyNotifications(
  ctx: Ctx, filter: { before?: string | undefined; limit?: number | undefined } = {},
): Promise<{ items: Notification[]; unread: number }> {
  const db = getDb();
  const limit = Math.min(Math.max(filter.limit ?? 20, 1), 50);
  const [rows, [count]] = await Promise.all([
    db.select().from(notifications)
      .where(and(eq(notifications.userId, ctx.user.id), filter.before ? lt(notifications.id, filter.before) : undefined))
      .orderBy(desc(notifications.createdAt), desc(notifications.id)).limit(limit),
    db.select({ n: sql<number>`count(*)::int` }).from(notifications).where(and(eq(notifications.userId, ctx.user.id), isNull(notifications.readAt))),
  ]);
  return {
    items: rows.map((r) => ({ id: r.id, kind: r.kind, params: r.params as NotificationParams, link: r.link, createdAt: r.createdAt, read: r.readAt !== null })),
    unread: count?.n ?? 0,
  };
}

/** Marks some, or all, of my notifications read. Someone else's are untouched. */
export async function markNotificationsRead(ctx: Ctx, input: { ids?: readonly string[] | undefined }): Promise<{ unread: number }> {
  await inTx(ctx, (tx) => tx.update(notifications).set({ readAt: ctx.now }).where(and(
    eq(notifications.userId, ctx.user.id), isNull(notifications.readAt),
    input.ids ? inArray(notifications.id, [...input.ids]) : undefined,
  )));
  const [count] = await getDb().select({ n: sql<number>`count(*)::int` }).from(notifications)
    .where(and(eq(notifications.userId, ctx.user.id), isNull(notifications.readAt)));
  return { unread: count?.n ?? 0 };
}
