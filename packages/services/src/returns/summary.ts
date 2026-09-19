import { businessDayStart, businessMonth, dec, DomainError, toMoney, type Money } from '@gsa/core';
import { schema } from '@gsa/db';
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { authorize, type Ctx } from '../context';
import { getDb } from '../runtime';

const { sales, returns } = schema;

export type SalesMonth = {
  readonly month: string;
  readonly sold: Money; readonly sales: number;
  /** RET-009: credit notes on the seller's sales, in the month they were raised. */ readonly returned: Money; readonly creditNotes: number;
  readonly net: Money;
};

/** The first instant of a Riyadh month, and of the next one. */
function monthRange(month: string): { from: Date; to: Date } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return { from: businessDayStart(`${month}-01`), to: businessDayStart(`${next}-01`) };
}

/**
 * RET-009: a seller's recorded sales for a month — completed sales, less the
 * credit notes raised on their sales that month. Target progress (M11)
 * counts the same net figure. Another seller's month needs `sales.view_all`.
 */
export async function mySalesMonth(ctx: Ctx, input: { month?: string | undefined; sellerId?: string | undefined } = {}): Promise<SalesMonth> {
  authorize(ctx, 'sales.record');
  const sellerId = input.sellerId ?? ctx.user.id;
  if (sellerId !== ctx.user.id && !ctx.permissions.has('sales.view_all')) throw new DomainError('FORBIDDEN', { permission: 'sales.view_all' });
  const month = input.month ?? businessMonth(ctx.now);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new DomainError('INVALID_DATE', { field: 'month', value: month });
  const { from, to } = monthRange(month);
  const db = ctx.tx ?? getDb();
  const [sold] = await db.select({ total: sql<string>`coalesce(sum(${sales.total}), 0)::numeric(14,2)`, count: sql<number>`count(*)::int` }).from(sales)
    .where(and(eq(sales.sellerId, sellerId), eq(sales.status, 'COMPLETED'), gte(sales.completedAt, from), lt(sales.completedAt, to)));
  const [returned] = await db.select({ total: sql<string>`coalesce(sum(${returns.amount}), 0)::numeric(14,2)`, count: sql<number>`count(*)::int` }).from(returns)
    .where(and(eq(returns.sellerId, sellerId), eq(returns.kind, 'CREDIT_NOTE'), gte(returns.occurredAt, from), lt(returns.occurredAt, to)));
  const s = (sold?.total ?? '0.00') as Money;
  const r = (returned?.total ?? '0.00') as Money;
  return { month, sold: s, sales: Number(sold?.count ?? 0), returned: r, creditNotes: Number(returned?.count ?? 0), net: toMoney(dec(s).minus(dec(r))) };
}
