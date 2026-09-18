import type { Db } from '@gsa/db';
import type { Ctx } from '../context';
import { getDb } from '../runtime';

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type Executor = Db | Tx;

/**
 * Services own their transaction boundary (ADR-0017). If the caller already
 * holds one — an idempotent request — the use case joins it, so the replay
 * record and the business change commit or roll back together.
 */
export function inTx<T>(ctx: Pick<Ctx, 'tx'>, work: (tx: Tx) => Promise<T>): Promise<T> {
  return ctx.tx ? work(ctx.tx) : getDb().transaction(work);
}
