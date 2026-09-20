import {
  businessMonth, Dec, dec, settledByPeriod, toMoney,
  type CashFlow, type Money, type SettlementApproval, type TargetActuals,
} from '@gsa/core';
import { schema } from '@gsa/db';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Executor } from '../platform';
import { readSettings } from '../system';

const { cashLedgerEntries, returns, sales, stores } = schema;

/**
 * The four figures a target is measured against (TGT-003), for one month, plus
 * the credit the business gave away in it. `COLLECTED` is the settled cash
 * COM-001 pays commission on, so a seller's collections figure and their
 * commission can never tell different stories.
 */
export type Actuals = TargetActuals & { readonly creditAgainstOtherDebts: Money };

const EMPTY: Actuals = { REVENUE: '0.00', PACKS_SOLD: '0', NEW_STORES: '0', COLLECTED: '0.00', creditAgainstOtherDebts: '0.00' as Money };

/** The Riyadh month of a timestamp, as the database sees it. */
const monthOf = (column: unknown) => sql`to_char(${column} at time zone 'Asia/Riyadh', 'YYYY-MM')`;

const byId = <T extends { sellerId: string }>(rows: readonly T[]) => new Map(rows.map((r) => [r.sellerId, r]));

/**
 * RET-009: a credit note reduces the seller's recorded sales and target
 * progress. Revenue and packs are net of what came back, in the month the
 * credit note was raised — never by reopening the month of the sale.
 *
 * Grouped by seller rather than run per seller: the console's targets page
 * shows every seller at once, and a query each would be a few hundred.
 */
async function salesFigures(db: Executor, sellerIds: readonly string[], period: string) {
  const ids = [...sellerIds];
  const sold = await db.select({
    sellerId: sales.sellerId,
    revenue: sql<string>`coalesce(sum(${sales.total}), 0)::text`,
    packs: sql<string>`coalesce(sum((select coalesce(sum(l.packs), 0) from sale_lines l where l.sale_id = ${sales.id})), 0)::text`,
  }).from(sales)
    .where(and(inArray(sales.sellerId, ids), eq(sales.status, 'COMPLETED'), eq(monthOf(sales.completedAt), period)))
    .groupBy(sales.sellerId);

  const credited = await db.select({
    sellerId: returns.sellerId,
    amount: sql<string>`coalesce(sum(${returns.amount}), 0)::text`,
    packs: sql<string>`coalesce(sum((select coalesce(sum(l.packs), 0) from return_lines l where l.return_id = ${returns.id})), 0)::text`,
    otherDebts: sql<string>`coalesce(sum(${returns.toOtherDebts}), 0)::text`,
  }).from(returns)
    .where(and(inArray(returns.sellerId, ids), eq(returns.kind, 'CREDIT_NOTE'), eq(monthOf(returns.occurredAt), period)))
    .groupBy(returns.sellerId);

  const [soldBy, creditedBy] = [byId(sold), byId(credited)];
  return new Map(ids.map((id) => {
    const s = soldBy.get(id);
    const c = creditedBy.get(id);
    return [id, {
      revenue: Dec.max(dec(s?.revenue ?? '0').minus(dec(c?.amount ?? '0')), 0).toFixed(2),
      packs: Dec.max(dec(s?.packs ?? '0').minus(dec(c?.packs ?? '0')), 0).toString(),
      creditAgainstOtherDebts: toMoney(dec(c?.otherDebts ?? '0')),
    }];
  }));
}

/**
 * TGT-003: stores the seller onboarded in the month. Counted by when the seller
 * did the work, not by when a manager got to it — but only where the onboarding
 * actually produced a customer, so a store still awaiting approval, or rejected
 * as a duplicate (STO-008), is not a new store to anybody's credit.
 */
async function newStoreCounts(db: Executor, sellerIds: readonly string[], period: string): Promise<Map<string, string>> {
  const rows = await db.select({ sellerId: stores.createdBy, total: sql<string>`count(*)::text` }).from(stores)
    .where(and(
      inArray(stores.createdBy, [...sellerIds]),
      inArray(stores.status, ['ACTIVE', 'INACTIVE']),
      eq(monthOf(stores.createdAt), period),
    ))
    .groupBy(stores.createdBy);
  // `created_by` is nullable on every mutable row; a store with no creator is nobody's credit.
  return new Map(rows.flatMap((r) => (r.sellerId === null ? [] : [[r.sellerId, r.total] as const])));
}

/**
 * COM-001, COM-005 (ADR-0042): the settled cash attributed to each month, by
 * walking each seller's cash in hand as a queue. Which month an approved
 * settlement paid for cannot be known from the settlement alone, so the whole
 * ledger is read — once for all the sellers asked about, then grouped.
 */
export async function settledCashByPeriod(
  db: Executor, sellerIds: readonly string[], closeAfterDays: number,
): Promise<Map<string, ReadonlyMap<string, Money>>> {
  const entries = await db.select({
    sellerId: cashLedgerEntries.sellerId, entryType: cashLedgerEntries.entryType,
    amount: cashLedgerEntries.amount, occurredAt: cashLedgerEntries.occurredAt,
  }).from(cashLedgerEntries)
    .where(inArray(cashLedgerEntries.sellerId, [...sellerIds]))
    .orderBy(asc(cashLedgerEntries.sellerId), asc(cashLedgerEntries.occurredAt));

  const perSeller = new Map<string, { inflows: CashFlow[]; outflows: CashFlow[]; approvals: SettlementApproval[] }>(
    sellerIds.map((id) => [id, { inflows: [], outflows: [], approvals: [] }]),
  );
  for (const entry of entries) {
    const bucket = perSeller.get(entry.sellerId);
    if (!bucket) continue;
    const period = businessMonth(entry.occurredAt);
    const amount = dec(entry.amount);
    // The ledger signs money by direction (CSH-005): into the seller's hands positive, out negative.
    if (entry.entryType === 'SETTLEMENT_APPROVED') bucket.approvals.push({ at: entry.occurredAt, period, amount: toMoney(amount.abs()) });
    else if (amount.gt(0)) bucket.inflows.push({ period, amount: toMoney(amount) });
    else bucket.outflows.push({ period, amount: toMoney(amount.abs()) });
  }
  return new Map([...perSeller].map(([id, b]) => [id, settledByPeriod(b.inflows, b.outflows, b.approvals, closeAfterDays)]));
}

/** Every figure for a set of sellers in one month (TGT-003, COM-001). */
export async function actualsForMany(db: Executor, sellerIds: readonly string[], period: string): Promise<Map<string, Actuals>> {
  if (sellerIds.length === 0) return new Map();
  const closeAfterDays = (await readSettings(db))['period.close_after_days'];
  const [figures, newStores, settled] = await Promise.all([
    salesFigures(db, sellerIds, period),
    newStoreCounts(db, sellerIds, period),
    settledCashByPeriod(db, sellerIds, closeAfterDays),
  ]);
  return new Map(sellerIds.map((id) => {
    const f = figures.get(id);
    return [id, {
      REVENUE: f?.revenue ?? '0.00',
      PACKS_SOLD: f?.packs ?? '0',
      NEW_STORES: newStores.get(id) ?? '0',
      COLLECTED: settled.get(id)?.get(period) ?? '0.00',
      creditAgainstOtherDebts: f?.creditAgainstOtherDebts ?? ('0.00' as Money),
    }];
  }));
}

/** One seller's figures for one month. */
export async function actualsFor(db: Executor, sellerId: string, period: string): Promise<Actuals> {
  return (await actualsForMany(db, [sellerId], period)).get(sellerId) ?? EMPTY;
}
