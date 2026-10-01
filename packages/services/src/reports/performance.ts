import {
  businessMonth, businessMonthRange, dec, DomainError, isBusinessMonth, toMoney, type Money,
} from '@gsa/core';
import { schema } from '@gsa/db';
import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { cashInHand } from '../cash';
import { authorize, type Ctx } from '../context';
import type { Executor } from '../platform';
import { mySalesMonth, type SalesMonth } from '../returns';
import { getDb } from '../runtime';
import { transfersAwaitingBy } from '../stores';
import { myStanding } from '../targets';

const { cashSettlements, payments } = schema;

const ZERO = '0.00' as Money;

export type Collected = {
  readonly cash: Money; readonly bank: Money; readonly total: Money;
  /** How many payments, of either kind. */ readonly payments: number;
};

/**
 * RPT-008: what each seller collected from stores in `[from, to)`, by method.
 * Every seller asked for is in the result — at zero if they collected nothing —
 * so a caller listing sellers never has to tell "none" from "missing".
 */
export async function collectedBySeller(db: Executor, sellerIds: readonly string[], from: Date, to: Date): Promise<Map<string, Collected>> {
  const out = new Map<string, Collected>(sellerIds.map((id) => [id, { cash: ZERO, bank: ZERO, total: ZERO, payments: 0 }]));
  if (sellerIds.length === 0) return out;
  const rows = await db.select({
    sellerId: payments.receivedBy, method: payments.method,
    amount: sql<string>`coalesce(sum(${payments.amount}), 0)::numeric(14,2)`, count: sql<number>`count(*)::int`,
  }).from(payments)
    .where(and(inArray(payments.receivedBy, [...sellerIds]), gte(payments.receivedAt, from), lt(payments.receivedAt, to)))
    .groupBy(payments.receivedBy, payments.method);
  for (const row of rows) {
    const current = out.get(row.sellerId);
    if (!current) continue;
    const cash = row.method === 'CASH' ? (row.amount as Money) : current.cash;
    const bank = row.method === 'BANK_TRANSFER' ? (row.amount as Money) : current.bank;
    out.set(row.sellerId, { cash, bank, total: toMoney(dec(cash).plus(dec(bank))), payments: current.payments + Number(row.count) });
  }
  return out;
}

/**
 * CSH-002..005: cash each seller handed over in `[from, to)` — banked or given
 * to a manager — that a manager has approved. The approved amounts, which can
 * differ from those declared (ADR-0040). Attributed to the month it was handed
 * over, not the month it was approved: that is the month the seller did it.
 */
export async function handedOverBySeller(db: Executor, sellerIds: readonly string[], from: Date, to: Date): Promise<Map<string, Money>> {
  const out = new Map<string, Money>(sellerIds.map((id) => [id, ZERO]));
  if (sellerIds.length === 0) return out;
  const rows = await db.select({
    sellerId: cashSettlements.sellerId, amount: sql<string>`coalesce(sum(${cashSettlements.approvedAmount}), 0)::numeric(14,2)`,
  }).from(cashSettlements)
    .where(and(
      inArray(cashSettlements.sellerId, [...sellerIds]), eq(cashSettlements.status, 'APPROVED'),
      gte(cashSettlements.submittedAt, from), lt(cashSettlements.submittedAt, to),
    ))
    .groupBy(cashSettlements.sellerId);
  for (const row of rows) out.set(row.sellerId, row.amount as Money);
  return out;
}

export type MyPerformance = {
  readonly month: string;
  /** Right now, whichever month is shown. */
  readonly now: {
    readonly cashInHand: Money;
    /** Handed over and not yet decided by a manager, from any month. */ readonly awaitingApproval: Money;
    /** ADR-0046: collected by bank transfer and not yet confirmed, from any month — it earns nothing until it is. */
    readonly transfersAwaiting: Money;
  };
  readonly sales: SalesMonth;
  readonly collected: Collected;
  /** Handed over in the month and approved. */ readonly handedOver: Money;
  /** COM-001..008: the same figures as the Targets screen — final once the month has frozen. */
  readonly commission: { readonly base: Money; readonly rate: string | null; readonly commission: Money | null; readonly final: boolean };
};

/**
 * A seller's own month in one place: sales, collections, cash and commission,
 * which were spread across four screens. Composes what those screens already
 * use rather than counting again, so the figures cannot disagree with them.
 *
 * Seller-only, like cash in hand: `cash.submit_settlement` is held by sellers
 * alone, and the parts it composes check their own permissions too.
 */
export async function myPerformance(ctx: Ctx, input: { month?: string | undefined } = {}): Promise<MyPerformance> {
  authorize(ctx, 'cash.submit_settlement');
  if (ctx.user.role !== 'SELLER') throw new DomainError('FORBIDDEN', { permission: 'cash.submit_settlement' });
  const month = input.month ?? businessMonth(ctx.now);
  if (!isBusinessMonth(month)) throw new DomainError('INVALID_DATE', { field: 'month', value: month });
  const { from, to } = businessMonthRange(month);
  const db = ctx.tx ?? getDb();
  const me = ctx.user.id;

  // One after another, not Promise.all: `db` may be a transaction, and one
  // connection refuses overlapping queries.
  const sales = await mySalesMonth(ctx, { month });
  const standing = await myStanding(ctx, month);
  const collected = (await collectedBySeller(db, [me], from, to)).get(me) ?? { cash: ZERO, bank: ZERO, total: ZERO, payments: 0 };
  const handedOver = (await handedOverBySeller(db, [me], from, to)).get(me) ?? ZERO;
  const inHand = await cashInHand(db, me);
  const [awaiting] = await db.select({ amount: sql<string>`coalesce(sum(${cashSettlements.declaredAmount}), 0)::numeric(14,2)` })
    .from(cashSettlements).where(and(eq(cashSettlements.sellerId, me), eq(cashSettlements.status, 'SUBMITTED')));
  const transfersAwaiting = (await transfersAwaitingBy(db, [me])).get(me) ?? ZERO;

  return {
    month,
    now: { cashInHand: inHand, awaitingApproval: (awaiting?.amount ?? ZERO) as Money, transfersAwaiting },
    sales,
    collected,
    handedOver,
    commission: { base: standing.base, rate: standing.rate, commission: standing.commission, final: standing.final },
  };
}
