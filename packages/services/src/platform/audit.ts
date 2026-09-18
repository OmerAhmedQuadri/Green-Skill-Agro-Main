import { schema } from '@gsa/db';
import type { Ctx } from '../context';
import type { Executor } from './transaction';

export type AuditEntry = {
  readonly action: string;
  readonly entityType: string;
  readonly entityId?: string | null;
  readonly before?: unknown;
  readonly after?: unknown;
};

type Origin = { actorId: string | null; branchId: string; requestId: string | null; ip: string | null };

/** Append-only (AUD-004). Write in the same transaction as the change it records. */
export async function writeAudit(db: Executor, origin: Origin, entry: AuditEntry): Promise<void> {
  await db.insert(schema.auditLog).values({
    ...origin,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
  });
}

export function audit(db: Executor, ctx: Ctx, entry: AuditEntry): Promise<void> {
  return writeAudit(db, { actorId: ctx.user.id, branchId: ctx.branchId, requestId: ctx.requestId, ip: ctx.ip }, entry);
}
