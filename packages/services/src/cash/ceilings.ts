import { CEILING_KINDS, isOverCeiling, reminderDue, remindersEscalate, type CeilingKind, type Money, type UserId } from '@gsa/core';
import { schema } from '@gsa/db';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { authorizeAny, type Ctx } from '../context';
import { enqueueEmail, notify } from '../notifications';
import { inTx, type Executor, type Tx } from '../platform';
import { defaultBranchId, getDb } from '../runtime';
import { readSettings } from '../system';
import { valueOf, vehicleBatches } from '../vehicles';
import { cashInHand } from './ledger';

const { ceilings, dashboardFlags, users, vehicleAssignments } = schema;

export type Exposure = {
  readonly sellerId: string; readonly name: string;
  readonly cashInHand: Money; readonly stockValue: Money;
  readonly ceiling: { readonly CASH_IN_HAND: Money | null; readonly VEHICLE_STOCK_VALUE: Money | null };
  readonly over: readonly CeilingKind[];
};

/**
 * OQ-021: the stock on each seller's vehicle, valued at the base price list —
 * the price it would sell for. A SKU with no price counts as nothing.
 */
export async function vehicleStockValues(db: Executor, sellerIds: readonly string[]): Promise<Map<string, Money>> {
  const values = new Map<string, Money>(sellerIds.map((id) => [id, '0.00' as Money]));
  if (sellerIds.length === 0) return values;
  const assignments = await db.select({ sellerId: vehicleAssignments.sellerId, vehicleId: vehicleAssignments.vehicleId })
    .from(vehicleAssignments).where(and(inArray(vehicleAssignments.sellerId, [...sellerIds]), isNull(vehicleAssignments.endedAt)));
  if (assignments.length === 0) return values;
  const batches = await vehicleBatches(db, assignments.map((a) => a.vehicleId));
  for (const a of assignments) values.set(a.sellerId, valueOf(batches.filter((b) => b.vehicleId === a.vehicleId)));
  return values;
}

/** LIM-001, OQ-005: the ceilings that apply to each seller — their own, else the global one. */
async function ceilingsFor(db: Executor, sellerIds: readonly string[]) {
  const rows = await db.select().from(ceilings);
  const of = (kind: CeilingKind, sellerId: string): Money | null => {
    const own = rows.find((r) => r.kind === kind && r.sellerId === sellerId);
    return ((own ?? rows.find((r) => r.kind === kind && r.sellerId === null))?.amount ?? null) as Money | null;
  };
  return new Map(sellerIds.map((id) => [id, { CASH_IN_HAND: of('CASH_IN_HAND', id), VEHICLE_STOCK_VALUE: of('VEHICLE_STOCK_VALUE', id) }]));
}

/** CSH-001, LIM-001: what every active seller is carrying now, and where they are over. */
export async function sellerExposure(db: Executor, sellerIds?: readonly string[]): Promise<Exposure[]> {
  const sellers = await db.select({ id: users.id, name: users.name }).from(users)
    .where(and(eq(users.role, 'SELLER'), eq(users.status, 'ACTIVE'), sellerIds ? inArray(users.id, [...sellerIds]) : undefined))
    .orderBy(asc(users.name));
  const ids = sellers.map((s) => s.id);
  const [limits, stock] = [await ceilingsFor(db, ids), await vehicleStockValues(db, ids)];
  const out: Exposure[] = [];
  for (const s of sellers) {
    const cash = await cashInHand(db, s.id);
    const stockValue = stock.get(s.id) ?? ('0.00' as Money);
    const ceiling = limits.get(s.id) ?? { CASH_IN_HAND: null, VEHICLE_STOCK_VALUE: null };
    const over: CeilingKind[] = [];
    if (isOverCeiling(cash, ceiling.CASH_IN_HAND)) over.push('CASH_IN_HAND');
    if (isOverCeiling(stockValue, ceiling.VEHICLE_STOCK_VALUE)) over.push('VEHICLE_STOCK_VALUE');
    out.push({ sellerId: s.id, name: s.name, cashInHand: cash, stockValue, ceiling, over });
  }
  return out;
}

/** LIM-001, CSH-001: the cash each seller holds, for the console. */
export async function listSellerCash(ctx: Ctx): Promise<Exposure[]> {
  authorizeAny(ctx, ['cash.view_cash_in_hand', 'cash.approve_settlement']);
  return sellerExposure(ctx.tx ?? getDb());
}

export type Flag = {
  readonly id: string; readonly kind: CeilingKind; readonly seller: { readonly id: string; readonly name: string };
  readonly amount: Money; readonly ceiling: Money; readonly openedAt: Date; readonly remindersSent: number;
};

/** LIM-004: the breaches the dashboard shows until they clear. */
export async function listFlags(ctx: Ctx): Promise<Flag[]> {
  authorizeAny(ctx, ['cash.view_cash_in_hand', 'cash.approve_settlement', 'system.set_limits']);
  const db = ctx.tx ?? getDb();
  const rows = await db.select({ f: dashboardFlags, name: users.name }).from(dashboardFlags)
    .innerJoin(users, eq(users.id, dashboardFlags.sellerId))
    .where(isNull(dashboardFlags.resolvedAt)).orderBy(asc(dashboardFlags.openedAt));
  return rows.map((r) => ({
    id: r.f.id, kind: r.f.kind, seller: { id: r.f.sellerId, name: r.name },
    amount: r.f.amount as Money, ceiling: r.f.ceiling as Money, openedAt: r.f.openedAt, remindersSent: Number(r.f.remindersSent),
  }));
}

/**
 * LIM-002, LIM-004, CSH-007: one seller's flags brought up to date in the
 * transaction that moved their cash or stock — a breach is flagged and
 * warned about at once, and settling below the ceiling clears it. The
 * worker's sweep (below) then handles the repeats.
 */
export async function syncFlagsFor(tx: Tx, ctx: Ctx, sellerId: string): Promise<void> {
  const [exposure] = await sellerExposure(tx, [sellerId]);
  if (!exposure) return;
  const open = await tx.select().from(dashboardFlags)
    .where(and(eq(dashboardFlags.sellerId, sellerId), isNull(dashboardFlags.resolvedAt)));
  for (const kind of CEILING_KINDS) {
    const flag = open.find((f) => f.kind === kind);
    const over = exposure.over.includes(kind);
    const ceiling = exposure.ceiling[kind];
    const amount = kind === 'CASH_IN_HAND' ? exposure.cashInHand : exposure.stockValue;
    if (!over && flag) await tx.update(dashboardFlags).set({ resolvedAt: ctx.now, updatedAt: ctx.now }).where(eq(dashboardFlags.id, flag.id));
    if (!over || !ceiling) continue;
    if (flag) {
      await tx.update(dashboardFlags).set({ amount, ceiling, updatedAt: ctx.now }).where(eq(dashboardFlags.id, flag.id));
      continue;
    }
    await tx.insert(dashboardFlags).values({
      kind, sellerId, amount, ceiling, openedAt: ctx.now, lastNotifiedAt: ctx.now, remindersSent: '0', branchId: ctx.branchId,
    });
    await warn(tx, ctx, sellerId, kind, amount, ceiling, false);
  }
}

/**
 * LIM-002..005 (ADR-0040): the worker's sweep. A seller over a ceiling is
 * flagged for the dashboard and told in the app and by email; the warning
 * repeats every `ceilings.reminder_interval_hours`, and from the second
 * reminder their managers hear too (OQ-021). Back under, the flag clears.
 * Nothing here blocks anyone from working (LIM-005).
 */
export async function checkCeilings(ctx: Ctx): Promise<{ raised: number; reminded: number; cleared: number }> {
  return inTx(ctx, async (tx) => {
    const settings = await readSettings(tx);
    const interval = settings['ceilings.reminder_interval_hours'];
    const exposure = await sellerExposure(tx);
    const open = await tx.select().from(dashboardFlags).where(isNull(dashboardFlags.resolvedAt));
    let raised = 0; let reminded = 0; let cleared = 0;

    for (const seller of exposure) {
      for (const kind of ['CASH_IN_HAND', 'VEHICLE_STOCK_VALUE'] as const) {
        const ceiling = seller.ceiling[kind];
        const amount = kind === 'CASH_IN_HAND' ? seller.cashInHand : seller.stockValue;
        const flag = open.find((f) => f.sellerId === seller.sellerId && f.kind === kind);
        if (!seller.over.includes(kind)) {
          if (flag) {
            await tx.update(dashboardFlags).set({ resolvedAt: ctx.now, updatedAt: ctx.now }).where(eq(dashboardFlags.id, flag.id));
            cleared += 1;
          }
          continue;
        }
        if (!ceiling) continue;
        if (!flag) {
          await syncFlagsFor(tx, ctx, seller.sellerId);
          raised += 1;
          continue;
        }
        await tx.update(dashboardFlags).set({ amount, ceiling, updatedAt: ctx.now }).where(eq(dashboardFlags.id, flag.id));
        if (!reminderDue(flag.lastNotifiedAt, ctx.now, interval)) continue;
        const sent = Number(flag.remindersSent) + 1;
        await tx.update(dashboardFlags).set({ lastNotifiedAt: ctx.now, remindersSent: String(sent), updatedAt: ctx.now }).where(eq(dashboardFlags.id, flag.id));
        await warn(tx, ctx, seller.sellerId, kind, amount, ceiling, remindersEscalate(sent - 1));
        reminded += 1;
      }
    }
    return { raised, reminded, cleared };
  });
}

/** LIM-002, OQ-021: the seller in the app and by email; their managers once it has been repeated. */
async function warn(tx: Tx, ctx: Ctx, sellerId: string, kind: CeilingKind, amount: Money, ceiling: Money, escalate: boolean): Promise<void> {
  const params = { kind, amount, ceiling };
  await notify(tx, ctx, { users: [sellerId] }, 'CEILING_BREACHED', params, '/field/cash');
  const [seller] = await tx.select({ email: users.email, name: users.name, locale: users.locale }).from(users).where(eq(users.id, sellerId));
  if (seller?.email) {
    await enqueueEmail(tx, {
      to: seller.email, template: 'ceiling-breached', locale: seller.locale,
      params: { name: seller.name, kind, amount, ceiling }, branchId: ctx.branchId,
    }, ctx.now);
  }
  if (escalate) await notify(tx, ctx, { permission: 'cash.view_cash_in_hand' }, 'CEILING_BREACHED', { ...params, seller: seller?.name ?? '' }, '/console/cash');
}

/**
 * The worker's sweep (LIM-003): runs as the system, with no actor of its own,
 * so every manager and seller who should hear does.
 */
export async function sweepCeilings(now: Date): Promise<{ raised: number; reminded: number; cleared: number }> {
  return checkCeilings({
    user: { id: '00000000-0000-4000-8000-000000000000' as UserId, role: 'ADMIN' },
    permissions: new Set(), now, requestId: 'worker', locale: 'en', branchId: await defaultBranchId(), ip: null,
  });
}

export const flagCount = async (db: Executor): Promise<number> => {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(dashboardFlags).where(isNull(dashboardFlags.resolvedAt));
  return Number(row?.n ?? 0);
};
