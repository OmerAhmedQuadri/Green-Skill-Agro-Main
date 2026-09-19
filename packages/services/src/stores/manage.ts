import {
  assertCreditTerms, availableCreditModes, dec, DomainError, money, transitionStore, type CreditMode, type StoreStatus,
} from '@gsa/core';
import { schema } from '@gsa/db';
import { aliasedTable, and, asc, eq, ilike, isNull, or, type SQL } from 'drizzle-orm';
import { authorize, authorizeAny, type Ctx } from '../context';
import { notify } from '../notifications';
import { audit, inTx, likePattern, type Tx } from '../platform';
import { getDb } from '../runtime';
import { readSettings } from '../system';
import { creditStatuses, loadStore, readingAsManager, seesAllStores, summaryOf, type Store, type StoreSummary } from './access';

const { stores, storeAssignments, users, priceLists } = schema;
const seller = aliasedTable(users, 'seller');

/** A seller's portfolio (STO-006), or every store with `stores.view_all`. */
export async function listStores(
  ctx: Ctx, filter: { status?: StoreStatus | undefined; search?: string | undefined; sellerId?: string | undefined; blocked?: boolean | undefined } = {},
): Promise<StoreSummary[]> {
  authorizeAny(ctx, ['stores.onboard', 'stores.view_all']);
  const db = getDb();
  const where: SQL[] = [];
  if (filter.status) where.push(eq(stores.status, filter.status));
  if (filter.search?.trim()) {
    const q = likePattern(filter.search.trim());
    where.push(or(ilike(stores.name, q), ilike(stores.ownerName, q), ilike(stores.contactNumber, q)) as SQL);
  }
  if (!seesAllStores(ctx)) where.push(eq(storeAssignments.sellerId, ctx.user.id));
  else if (filter.sellerId) where.push(eq(storeAssignments.sellerId, filter.sellerId));
  const rows = await db.select({ s: stores, sellerId: seller.id, sellerName: seller.name }).from(stores)
    .leftJoin(storeAssignments, and(eq(storeAssignments.storeId, stores.id), isNull(storeAssignments.endedAt)))
    .leftJoin(seller, eq(seller.id, storeAssignments.sellerId))
    .where(and(...where)).orderBy(asc(stores.name)).limit(500);
  const credit = await creditStatuses(db, rows.map((r) => r.s), ctx.now);
  const out = rows.map((r) => summaryOf(r.s, r.sellerId && r.sellerName ? { id: r.sellerId, name: r.sellerName } : null, credit.get(r.s.id) ?? missing()));
  return filter.blocked === undefined ? out : out.filter((s) => s.credit.blocked === filter.blocked);
}

const missing = (): never => { throw new Error('credit status missing'); };

export async function getStore(ctx: Ctx, id: string): Promise<Store> {
  authorizeAny(ctx, ['stores.onboard', 'stores.view_all']);
  return loadStore(ctx.tx ?? getDb(), ctx, id);
}

async function lockStore(tx: Tx, id: string, version?: number) {
  const [row] = await tx.select().from(stores).where(eq(stores.id, id)).for('update');
  if (!row) throw new DomainError('NOT_FOUND', { entity: 'store', id });
  if (version !== undefined && row.version !== version) throw new DomainError('VERSION_CONFLICT', { entity: 'store', id });
  return row;
}

async function currentSellerOf(tx: Tx, storeId: string) {
  const [row] = await tx.select({ sellerId: storeAssignments.sellerId }).from(storeAssignments)
    .where(and(eq(storeAssignments.storeId, storeId), isNull(storeAssignments.endedAt)));
  return row?.sellerId ?? null;
}


/** STO-009: a manager approves — never whoever onboarded the store — or rejects with a reason. */
export async function decideStore(ctx: Ctx, id: string, action: 'approve' | 'reject', input: { version: number; reason?: string | null | undefined }): Promise<Store> {
  authorize(ctx, 'stores.approve');
  return inTx(ctx, async (tx) => {
    const current = await lockStore(tx, id, input.version);
    const status = transitionStore({ status: current.status, onboardedBy: current.createdBy ?? '' }, action, ctx.user.id, input.reason);
    await tx.update(stores).set({
      status, decidedAt: ctx.now, decidedBy: ctx.user.id, decisionReason: input.reason?.trim() || null,
      updatedAt: ctx.now, updatedBy: ctx.user.id, version: current.version + 1,
    }).where(eq(stores.id, id));
    const sellerId = await currentSellerOf(tx, id);
    if (sellerId) {
      await notify(tx, ctx, { users: [sellerId] }, action === 'approve' ? 'STORE_APPROVED' : 'STORE_REJECTED',
        { name: current.name, reason: input.reason?.trim() || null }, `/field/stores/${id}`);
    }
    await audit(tx, ctx, { action: `stores.${action === 'approve' ? 'approved' : 'rejected'}`, entityType: 'store', entityId: id, before: { status: current.status }, after: { status, reason: input.reason ?? null } });
    return loadStore(tx, readingAsManager(ctx), id);
  });
}

/** STATE-MACHINES §4: an active store is deactivated or reactivated (`stores.edit_terms`). */
export async function setStoreActive(ctx: Ctx, id: string, input: { version: number; active: boolean }): Promise<Store> {
  authorize(ctx, 'stores.edit_terms');
  return inTx(ctx, async (tx) => {
    const current = await lockStore(tx, id, input.version);
    const status = transitionStore({ status: current.status, onboardedBy: current.createdBy ?? '' }, input.active ? 'reactivate' : 'deactivate', ctx.user.id);
    await tx.update(stores).set({ status, updatedAt: ctx.now, updatedBy: ctx.user.id, version: current.version + 1 }).where(eq(stores.id, id));
    await audit(tx, ctx, { action: input.active ? 'stores.reactivated' : 'stores.deactivated', entityType: 'store', entityId: id });
    return loadStore(tx, readingAsManager(ctx), id);
  });
}

/** STO-005: credit limit and price list after onboarding (`stores.edit_terms`). */
export async function updateStoreTerms(ctx: Ctx, id: string, input: { version: number; creditLimit?: string | undefined; priceListId?: string | undefined }): Promise<Store> {
  authorize(ctx, 'stores.edit_terms');
  return inTx(ctx, async (tx) => {
    const current = await lockStore(tx, id, input.version);
    const creditLimit = input.creditLimit === undefined ? current.creditLimit : money(input.creditLimit);
    if (dec(creditLimit).isNegative()) throw new DomainError('INVALID_MONEY', { value: creditLimit });
    const priceListId = input.priceListId ?? current.priceListId;
    const [list] = await tx.select({ active: priceLists.isActive }).from(priceLists).where(eq(priceLists.id, priceListId));
    if (!list) throw new DomainError('NOT_FOUND', { entity: 'price_list', id: priceListId });
    if (!list.active) throw new DomainError('REFERENCE_INACTIVE', { entity: 'price_list', id: priceListId });
    await tx.update(stores).set({ creditLimit, priceListId, updatedAt: ctx.now, updatedBy: ctx.user.id, version: current.version + 1 }).where(eq(stores.id, id));
    await audit(tx, ctx, {
      action: 'stores.terms_changed', entityType: 'store', entityId: id,
      before: { creditLimit: current.creditLimit, priceListId: current.priceListId }, after: { creditLimit, priceListId },
    });
    return loadStore(tx, readingAsManager(ctx), id);
  });
}

/**
 * CRD-001, OQ-010: the credit cycle — sellers for the stores they manage,
 * `stores.view_all` for any. Existing debts keep their due dates (ADR-0036).
 */
export async function setCreditCycle(ctx: Ctx, id: string, input: { version: number; creditMode: CreditMode; creditCycleDays?: number | null | undefined }): Promise<Store> {
  authorize(ctx, 'stores.set_credit_cycle');
  return inTx(ctx, async (tx) => {
    await loadStore(tx, ctx, id); // visibility: the seller's own store, or view_all
    const current = await lockStore(tx, id, input.version);
    const days = assertCreditTerms(input.creditMode, input.creditCycleDays, availableCreditModes(await readSettings(tx)));
    await tx.update(stores).set({ creditMode: input.creditMode, creditCycleDays: days, updatedAt: ctx.now, updatedBy: ctx.user.id, version: current.version + 1 })
      .where(eq(stores.id, id));
    await audit(tx, ctx, {
      action: 'stores.credit_cycle_changed', entityType: 'store', entityId: id,
      before: { creditMode: current.creditMode, creditCycleDays: current.creditCycleDays }, after: { creditMode: input.creditMode, creditCycleDays: days },
    });
    return loadStore(tx, ctx, id);
  });
}

/** STO-007: another seller takes the account; who held it and when is kept. */
export async function reassignStore(ctx: Ctx, id: string, input: { sellerId: string; note?: string | null | undefined }): Promise<Store> {
  authorize(ctx, 'stores.reassign');
  return inTx(ctx, async (tx) => {
    const current = await lockStore(tx, id);
    const [target] = await tx.select({ role: users.role, status: users.status }).from(users).where(eq(users.id, input.sellerId));
    if (target?.role !== 'SELLER' || target.status !== 'ACTIVE') throw new DomainError('NOT_FOUND', { entity: 'seller', id: input.sellerId });
    const previous = await currentSellerOf(tx, id);
    if (previous === input.sellerId) throw new DomainError('INVALID_TRANSITION', { reason: 'ALREADY_ASSIGNED' });
    await tx.update(storeAssignments).set({ endedAt: ctx.now }).where(and(eq(storeAssignments.storeId, id), isNull(storeAssignments.endedAt)));
    await tx.insert(storeAssignments).values({
      storeId: id, sellerId: input.sellerId, startedAt: ctx.now, assignedBy: ctx.user.id, note: input.note?.trim() || null, branchId: ctx.branchId,
    });
    await notify(tx, ctx, { users: [input.sellerId] }, 'STORE_ASSIGNED', { name: current.name }, `/field/stores/${id}`);
    await audit(tx, ctx, { action: 'stores.reassigned', entityType: 'store', entityId: id, before: { sellerId: previous }, after: { sellerId: input.sellerId } });
    return loadStore(tx, readingAsManager(ctx), id);
  });
}
