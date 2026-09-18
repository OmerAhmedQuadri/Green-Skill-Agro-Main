import { DomainError } from '@gsa/core';
import { schema } from '@gsa/db';
import { and, eq } from 'drizzle-orm';
import type { Ctx } from '../context';
import { getDb } from '../runtime';

const { idempotencyKeys } = schema;

export type Outcome<T> = {
  readonly status: number;
  readonly body: T;
  /** What a replay returns, when the live body carries a secret that must not be persisted (e.g. a temporary password). */
  readonly replayBody?: T;
};

/**
 * Exactly-once mutations over unreliable networks (ADR-0009, NFR-006). The key
 * row is written in the **same transaction** as the business change: a
 * concurrent duplicate blocks on it, then replays the stored response; a
 * failed attempt rolls the key back so a retry runs afresh.
 */
export async function runIdempotent<T>(
  ctx: Ctx,
  request: { readonly key: string; readonly hash: string },
  work: (ctx: Ctx) => Promise<Outcome<T>>,
): Promise<Outcome<T> & { readonly replayed: boolean }> {
  return getDb().transaction(async (tx) => {
    const inserted = await tx
      .insert(idempotencyKeys)
      .values({ userId: ctx.user.id, key: request.key, requestHash: request.hash })
      .onConflictDoNothing()
      .returning({ key: idempotencyKeys.key });

    if (inserted.length === 0) {
      const [stored] = await tx
        .select()
        .from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.userId, ctx.user.id), eq(idempotencyKeys.key, request.key)));
      if (!stored || stored.responseStatus === null) throw new Error('idempotency record missing its response');
      if (stored.requestHash !== request.hash) throw new DomainError('IDEMPOTENCY_KEY_REUSED', { key: request.key });
      return { status: stored.responseStatus, body: stored.responseBody as T, replayed: true };
    }

    const outcome = await work({ ...ctx, tx });
    await tx
      .update(idempotencyKeys)
      .set({ responseStatus: outcome.status, responseBody: outcome.replayBody ?? outcome.body })
      .where(and(eq(idempotencyKeys.userId, ctx.user.id), eq(idempotencyKeys.key, request.key)));
    return { status: outcome.status, body: outcome.body, replayed: false };
  });
}
