import {
  effectivePermissions, isPermissionCode, PROVISIONAL_OUTCOMES,
  type NotificationKind, type PermissionCode, type RequestKind, type RequestOutcome, type RequestOutcomes,
} from '@gsa/core';
import { schema } from '@gsa/db';
import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { Ctx } from '../context';
import { inTx, type Executor } from '../platform';
import { getDb } from '../runtime';

const { notifications, users, userPermissions } = schema;

export type Recipients =
  | { readonly users: readonly string[]; /** LIM-002: the message is about them, whoever set it off. */ readonly includeActor?: boolean }
  | { readonly permission: PermissionCode };
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
 * notifies nobody. The actor is never notified of their own action, unless
 * the message is about them rather than about what they did — a ceiling
 * breach a seller's own sale caused, for instance (LIM-002).
 *
 * ADR-0051: a request names the record it is about, so that when it ends,
 * every copy can say so (`endRequest`).
 */
export async function notify(
  tx: Executor, ctx: Ctx, to: Recipients, kind: RequestKind, params: NotificationParams, link: string | null, subjectId: string,
): Promise<void>;
export async function notify(
  tx: Executor, ctx: Ctx, to: Recipients, kind: Exclude<NotificationKind, RequestKind>, params: NotificationParams, link?: string | null,
): Promise<void>;
export async function notify(
  tx: Executor, ctx: Ctx, to: Recipients, kind: NotificationKind, params: NotificationParams, link: string | null = null, subjectId: string | null = null,
): Promise<void> {
  const ids = 'users' in to ? [...new Set(to.users)] : await usersWithPermission(tx, to.permission);
  const recipients = 'includeActor' in to && to.includeActor ? ids : ids.filter((id) => id !== ctx.user.id);
  if (recipients.length === 0) return;
  await tx.insert(notifications).values(recipients.map((userId) => ({
    userId, kind, params, link, subjectId, createdAt: ctx.now, branchId: ctx.branchId,
  })));
}

/**
 * ADR-0051: a request has ended — decided, expired, withdrawn, cancelled. Every
 * copy of it records how, when and by whom (nobody, for the system), and stops
 * counting as unread, in the caller's transaction. A copy that has ended keeps
 * its outcome, unless that was only provisional: a dispatch request taken.
 */
export async function endRequest<K extends RequestKind>(
  db: Executor, kind: K, subjectIds: readonly string[], outcome: RequestOutcomes[K], by: string | null, at: Date,
): Promise<void> {
  if (subjectIds.length === 0) return;
  await db.update(notifications).set({ resolvedAt: at, resolvedBy: by, outcome })
    .where(and(
      eq(notifications.kind, kind), inArray(notifications.subjectId, [...subjectIds]),
      or(isNull(notifications.resolvedAt), inArray(notifications.outcome, [...PROVISIONAL_OUTCOMES])),
    ));
}

/**
 * DSP-005, ADR-0051: a dispatch request handed back waits again — new to
 * everyone but whoever handed it back.
 */
export async function reopenRequest(db: Executor, kind: RequestKind, subjectId: string, by: string, at: Date): Promise<void> {
  await db.update(notifications).set({
    resolvedAt: null, resolvedBy: null, outcome: null,
    readAt: sql`case when ${notifications.userId} = ${by} then ${at.toISOString()}::timestamptz else null end`,
  }).where(and(eq(notifications.kind, kind), eq(notifications.subjectId, subjectId), inArray(notifications.outcome, [...PROVISIONAL_OUTCOMES])));
}

/** ADR-0051: how a request ended, and who ended it — null when nobody did; `byYou` when the reader did. */
export type Resolution = {
  readonly outcome: RequestOutcome; readonly at: Date; readonly by: { readonly id: string; readonly name: string } | null; readonly byYou: boolean;
};

export type Notification = {
  readonly id: string; readonly kind: NotificationKind; readonly params: NotificationParams; readonly link: string | null;
  readonly createdAt: Date; readonly read: boolean;
  /** Null for news, and for a request still waiting. */
  readonly resolution: Resolution | null;
};

/** What counts on the bell: unread, and not a request that has ended (ADR-0051). */
const unreadOf = (userId: string) => and(eq(notifications.userId, userId), isNull(notifications.readAt), isNull(notifications.resolvedAt));

/** The bell: my latest notifications and how many are unread. Polled every 30 s. */
export async function listMyNotifications(
  ctx: Ctx, filter: { before?: string | undefined; limit?: number | undefined } = {},
): Promise<{ items: Notification[]; unread: number }> {
  const db = getDb();
  const limit = Math.min(Math.max(filter.limit ?? 20, 1), 50);
  const [rows, [count]] = await Promise.all([
    db.select({ n: notifications, by: users.name }).from(notifications).leftJoin(users, eq(users.id, notifications.resolvedBy))
      .where(and(eq(notifications.userId, ctx.user.id), filter.before ? lt(notifications.id, filter.before) : undefined))
      .orderBy(desc(notifications.createdAt), desc(notifications.id)).limit(limit),
    db.select({ n: sql<number>`count(*)::int` }).from(notifications).where(unreadOf(ctx.user.id)),
  ]);
  return {
    items: rows.map(({ n: r, by }) => ({
      id: r.id, kind: r.kind, params: r.params as NotificationParams, link: r.link, createdAt: r.createdAt, read: r.readAt !== null,
      resolution: r.resolvedAt && r.outcome
        ? {
          outcome: r.outcome, at: r.resolvedAt, by: r.resolvedBy && by !== null ? { id: r.resolvedBy, name: by } : null,
          byYou: r.resolvedBy === ctx.user.id,
        }
        : null,
    })),
    unread: count?.n ?? 0,
  };
}

/** Marks some, or all, of my notifications read. Someone else's are untouched. */
export async function markNotificationsRead(ctx: Ctx, input: { ids?: readonly string[] | undefined }): Promise<{ unread: number }> {
  await inTx(ctx, (tx) => tx.update(notifications).set({ readAt: ctx.now }).where(and(
    eq(notifications.userId, ctx.user.id), isNull(notifications.readAt),
    input.ids ? inArray(notifications.id, [...input.ids]) : undefined,
  )));
  const [count] = await (ctx.tx ?? getDb()).select({ n: sql<number>`count(*)::int` }).from(notifications).where(unreadOf(ctx.user.id));
  return { unread: count?.n ?? 0 };
}
