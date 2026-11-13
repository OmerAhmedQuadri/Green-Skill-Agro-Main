import { DomainError } from '@gsa/core';
import { schema } from '@gsa/db';
import { and, eq, gt, gte, sql } from 'drizzle-orm';
import type { Executor } from './transaction';

const { rateLimits } = schema;

/**
 * Fixed-window counter in Postgres, shared by every web instance
 * (SECURITY §1). Runs outside any business transaction so a failed attempt
 * still counts.
 */
export async function hitRateLimit(db: Executor, key: string, limit: number, windowMs: number, now: Date): Promise<void> {
  const staleBefore = new Date(now.getTime() - windowMs);
  const [row] = await db
    .insert(rateLimits)
    .values({ key, count: 1, windowStart: now })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        count: sql`case when ${rateLimits.windowStart} <= ${staleBefore} then 1 else ${rateLimits.count} + 1 end`,
        windowStart: sql`case when ${rateLimits.windowStart} <= ${staleBefore} then ${now} else ${rateLimits.windowStart} end`,
      },
    })
    .returning({ count: rateLimits.count });
  if ((row?.count ?? 0) > limit) {
    throw new DomainError('RATE_LIMITED', { retryAfterSeconds: Math.ceil(windowMs / 1000) });
  }
}

/**
 * Refuses once `limit` hits have landed in the current window, without counting this one — for limits that count
 * only failures, such as wrong passwords, so the check comes before the attempt and the hit after it fails.
 */
export async function assertUnderRateLimit(db: Executor, key: string, limit: number, windowMs: number, now: Date): Promise<void> {
  const [row] = await db.select({ count: rateLimits.count }).from(rateLimits)
    .where(and(eq(rateLimits.key, key), gt(rateLimits.windowStart, new Date(now.getTime() - windowMs)), gte(rateLimits.count, limit)));
  if (row) throw new DomainError('RATE_LIMITED', { retryAfterSeconds: Math.ceil(windowMs / 1000) });
}
