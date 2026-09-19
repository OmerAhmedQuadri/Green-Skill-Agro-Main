import { dec, DomainError, money, percent, type Money, type Percent, type UserId } from '@gsa/core';
import { schema } from '@gsa/db';
import { and, asc, eq, isNull, or } from 'drizzle-orm';
import { authorize, type Ctx } from '../context';
import { audit, inTx, type Executor } from '../platform';
import { getDb } from '../runtime';

const { ceilings, commissionRates, users } = schema;

export type CeilingKind = 'CASH_IN_HAND' | 'VEHICLE_STOCK_VALUE';
type Pair = { readonly CASH_IN_HAND: Money | null; readonly VEHICLE_STOCK_VALUE: Money | null };

export type Ceilings = {
  readonly global: Pair;
  readonly sellers: readonly { readonly sellerId: UserId; readonly name: string; readonly own: Pair; readonly effective: Pair }[];
};

async function activeSellers(db: Executor) {
  return db.select({ id: users.id, name: users.name }).from(users)
    .where(and(eq(users.role, 'SELLER'), eq(users.status, 'ACTIVE'))).orderBy(asc(users.name));
}

async function assertSeller(db: Executor, sellerId: string) {
  const [row] = await db.select({ role: users.role }).from(users).where(eq(users.id, sellerId));
  if (row?.role !== 'SELLER') throw new DomainError('NOT_FOUND', { entity: 'seller', id: sellerId });
}

/** LIM-001, OQ-005: a seller's own ceiling overrides the global one. */
export async function getCeilings(ctx: Ctx): Promise<Ceilings> {
  authorize(ctx, 'system.set_limits');
  const db = ctx.tx ?? getDb(); // after a change, the request's transaction sees it
  const rows = await db.select().from(ceilings);
  const sellers = await activeSellers(db);
  const find = (kind: CeilingKind, sellerId: string | null) =>
    (rows.find((r) => r.kind === kind && r.sellerId === sellerId)?.amount ?? null) as Money | null;
  const global: Pair = { CASH_IN_HAND: find('CASH_IN_HAND', null), VEHICLE_STOCK_VALUE: find('VEHICLE_STOCK_VALUE', null) };
  return {
    global,
    sellers: sellers.map((s) => {
      const own: Pair = { CASH_IN_HAND: find('CASH_IN_HAND', s.id), VEHICLE_STOCK_VALUE: find('VEHICLE_STOCK_VALUE', s.id) };
      return {
        sellerId: s.id as UserId, name: s.name, own,
        effective: { CASH_IN_HAND: own.CASH_IN_HAND ?? global.CASH_IN_HAND, VEHICLE_STOCK_VALUE: own.VEHICLE_STOCK_VALUE ?? global.VEHICLE_STOCK_VALUE },
      };
    }),
  };
}

/** Sets a ceiling; a null amount removes it (a seller then falls back to the global one). */
export async function setCeiling(
  ctx: Ctx, input: { kind: CeilingKind; sellerId: string | null; amount: string | null },
): Promise<Ceilings> {
  authorize(ctx, 'system.set_limits');
  const amount = input.amount === null ? null : money(input.amount);
  if (amount !== null && !dec(amount).gt(0)) throw new DomainError('INVALID_MONEY', { value: amount });
  await inTx(ctx, async (tx) => {
    if (input.sellerId) await assertSeller(tx, input.sellerId);
    const match = and(eq(ceilings.kind, input.kind), input.sellerId ? eq(ceilings.sellerId, input.sellerId) : isNull(ceilings.sellerId));
    const [current] = await tx.select({ amount: ceilings.amount }).from(ceilings).where(match);
    if (amount === null) await tx.delete(ceilings).where(match);
    else if (current) await tx.update(ceilings).set({ amount, updatedAt: ctx.now, updatedBy: ctx.user.id }).where(match);
    else await tx.insert(ceilings).values({ kind: input.kind, sellerId: input.sellerId, amount, updatedAt: ctx.now, updatedBy: ctx.user.id });
    await audit(tx, ctx, {
      action: 'system.ceiling_changed', entityType: 'ceiling', entityId: input.sellerId,
      before: { kind: input.kind, amount: current?.amount ?? null }, after: { kind: input.kind, amount },
    });
  });
  return getCeilings(ctx);
}

export type CommissionRate = {
  readonly sellerId: UserId; readonly name: string; readonly onTarget: Percent | null; readonly belowTarget: Percent | null;
};

/** SYS-008: each seller's commission rates, on target and below target. */
export async function getCommissionRates(ctx: Ctx): Promise<CommissionRate[]> {
  authorize(ctx, 'targets.manage');
  const db = ctx.tx ?? getDb();
  const rates = await db.select().from(commissionRates);
  const sellers = await activeSellers(db);
  return sellers.map((s) => {
    const rate = rates.find((r) => r.sellerId === s.id);
    return { sellerId: s.id as UserId, name: s.name, onTarget: (rate?.onTargetPercent ?? null) as Percent | null, belowTarget: (rate?.belowTargetPercent ?? null) as Percent | null };
  });
}

export async function setCommissionRate(
  ctx: Ctx, sellerId: string, input: { onTarget: string; belowTarget: string } | null,
): Promise<CommissionRate[]> {
  authorize(ctx, 'targets.manage');
  const values = input && { onTargetPercent: percent(input.onTarget), belowTargetPercent: percent(input.belowTarget) };
  await inTx(ctx, async (tx) => {
    await assertSeller(tx, sellerId);
    const [current] = await tx.select().from(commissionRates).where(eq(commissionRates.sellerId, sellerId));
    if (!values) await tx.delete(commissionRates).where(eq(commissionRates.sellerId, sellerId));
    else {
      await tx.insert(commissionRates).values({ sellerId, ...values, updatedAt: ctx.now, updatedBy: ctx.user.id })
        .onConflictDoUpdate({ target: commissionRates.sellerId, set: { ...values, updatedAt: ctx.now, updatedBy: ctx.user.id } });
    }
    await audit(tx, ctx, {
      action: 'system.commission_rate_changed', entityType: 'commission_rate', entityId: sellerId,
      before: current ? { onTarget: current.onTargetPercent, belowTarget: current.belowTargetPercent } : null,
      after: values ? { onTarget: values.onTargetPercent, belowTarget: values.belowTargetPercent } : null,
    });
  });
  return getCommissionRates(ctx);
}

/** OQ-005: a seller's own ceiling, else the global one, else none. */
export async function effectiveCeiling(db: Executor, kind: CeilingKind, sellerId: string): Promise<Money | null> {
  const rows = await db.select({ sellerId: ceilings.sellerId, amount: ceilings.amount }).from(ceilings)
    .where(and(eq(ceilings.kind, kind), or(eq(ceilings.sellerId, sellerId), isNull(ceilings.sellerId))));
  const own = rows.find((r) => r.sellerId === sellerId) ?? rows.find((r) => r.sellerId === null);
  return (own?.amount ?? null) as Money | null;
}
