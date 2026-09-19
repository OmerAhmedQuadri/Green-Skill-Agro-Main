import { schema } from '@gsa/db';
import { and, desc, eq, like, lt, or, type SQL } from 'drizzle-orm';
import { authorize, type Ctx } from '../context';
import { decodeCursor, encodeCursor, likePattern, pageLimit } from '../platform';
import { getDb } from '../runtime';

const { auditLog, users } = schema;

export type AuditEntryView = {
  readonly id: string; readonly occurredAt: Date; readonly actor: { readonly id: string; readonly name: string } | null;
  readonly action: string; readonly entityType: string; readonly entityId: string | null;
  readonly before: unknown; readonly after: unknown; readonly ip: string | null;
};

export type AuditFilter = {
  readonly action?: string | undefined; readonly entityType?: string | undefined; readonly entityId?: string | undefined;
  readonly actorId?: string | undefined; readonly cursor?: string | undefined; readonly limit?: number | undefined;
};

/**
 * AUD-001..004: who did what, and when — newest first. Super Admin and Admin
 * only (AUD-003); the records themselves can never be changed (AUD-004).
 */
export async function listAuditLog(ctx: Ctx, filter: AuditFilter = {}): Promise<{ items: AuditEntryView[]; nextCursor: string | null }> {
  authorize(ctx, 'system.view_audit_log');
  const limit = pageLimit(filter.limit);
  const where: (SQL | undefined)[] = [];
  if (filter.action) where.push(like(auditLog.action, likePattern(filter.action)));
  if (filter.entityType) where.push(eq(auditLog.entityType, filter.entityType));
  if (filter.entityId) where.push(eq(auditLog.entityId, filter.entityId));
  if (filter.actorId) where.push(eq(auditLog.actorId, filter.actorId));
  if (filter.cursor) {
    const [at, id] = decodeCursor(filter.cursor, 2) as [string, string];
    where.push(or(lt(auditLog.occurredAt, new Date(at)), and(eq(auditLog.occurredAt, new Date(at)), lt(auditLog.id, id))));
  }
  const rows = await getDb().select({ a: auditLog, actorName: users.name }).from(auditLog).leftJoin(users, eq(users.id, auditLog.actorId))
    .where(and(...where)).orderBy(desc(auditLog.occurredAt), desc(auditLog.id)).limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map((r) => ({
      id: r.a.id, occurredAt: r.a.occurredAt, actor: r.a.actorId && r.actorName ? { id: r.a.actorId, name: r.actorName } : null,
      action: r.a.action, entityType: r.a.entityType, entityId: r.a.entityId, before: r.a.before, after: r.a.after, ip: r.a.ip,
    })),
    nextCursor: rows.length > limit && last ? encodeCursor([last.a.occurredAt.toISOString(), last.a.id]) : null,
  };
}
