import {
  assertDecisionComment, assertDeclarable, dec, DomainError, money, settlementPostings, toMoney, transitionSettlement,
  type Money, type SettlementRoute, type SettlementStatus,
} from '@gsa/core';
import { newId, schema } from '@gsa/db';
import { aliasedTable, and, asc, desc, eq, inArray, lt, or, type SQL } from 'drizzle-orm';
import { authorize, authorizeAny, type Ctx } from '../context';
import { assertOwnEvidence } from '../media';
import { notify, usersWithPermission } from '../notifications';
import { audit, decodeCursor, encodeCursor, inTx, nextDocumentNumber, pageLimit, type Executor } from '../platform';
import { getDb } from '../runtime';
import { syncFlagsFor } from './ceilings';
import { cashInHand, lockCash } from './ledger';

const { cashSettlements, cashLedgerEntries, users } = schema;

type Person = { readonly id: string; readonly name: string };

export type Settlement = {
  readonly id: string; readonly number: string; readonly status: SettlementStatus; readonly route: SettlementRoute;
  readonly seller: Person; readonly declaredAmount: Money;
  /** CSH-002 */ readonly depositedOn: string | null;
  /** CSH-003 */ readonly receivedBy: Person | null;
  readonly photoId: string; readonly note: string | null; readonly submittedAt: Date;
  readonly approvedAmount: Money | null; readonly decidedAt: Date | null; readonly decidedBy: Person | null; readonly decisionComment: string | null;
  /** CSH-006: declared but not approved — still the seller's to account for. */ readonly shortfall: Money | null;
  /** CSH-006: approved beyond what the ledger knew about. */ readonly discrepancy: Money | null;
  readonly version: number;
};

const seller = aliasedTable(users, 'settlement_seller');
const receiver = aliasedTable(users, 'settlement_receiver');
const decider = aliasedTable(users, 'settlement_decider');

/** PERMISSIONS §3.1: a seller sees their own; approvers and cash viewers see everyone's. */
function visibility(ctx: Ctx): SQL | undefined {
  if (ctx.permissions.has('cash.approve_settlement') || ctx.permissions.has('cash.view_cash_in_hand')) return undefined;
  return eq(cashSettlements.sellerId, ctx.user.id);
}

const toDto = (row: {
  s: typeof cashSettlements.$inferSelect; sellerName: string | null; receiverName: string | null; deciderName: string | null;
}): Settlement => {
  const s = row.s;
  const declared = s.declaredAmount as Money;
  const approved = s.approvedAmount as Money | null;
  const short = approved ? dec(declared).minus(dec(approved)) : null;
  return {
    id: s.id, number: s.number, status: s.status, route: s.route,
    seller: { id: s.sellerId, name: row.sellerName ?? '' }, declaredAmount: declared,
    depositedOn: s.depositedOn, receivedBy: s.receivedBy ? { id: s.receivedBy, name: row.receiverName ?? '' } : null,
    photoId: s.photoId, note: s.note, submittedAt: s.submittedAt,
    approvedAmount: approved, decidedAt: s.decidedAt, decidedBy: s.decidedBy ? { id: s.decidedBy, name: row.deciderName ?? '' } : null,
    decisionComment: s.decisionComment,
    shortfall: short?.gt(0) ? toMoney(short) : null,
    discrepancy: s.discrepancyEntryId ? toMoney(dec(approved ?? '0').minus(dec(declared))) : null,
    version: s.version,
  };
};

const selection = {
  s: cashSettlements, sellerName: seller.name, receiverName: receiver.name, deciderName: decider.name,
};
const joined = (db: Executor) => db.select(selection).from(cashSettlements)
  .leftJoin(seller, eq(seller.id, cashSettlements.sellerId))
  .leftJoin(receiver, eq(receiver.id, cashSettlements.receivedBy))
  .leftJoin(decider, eq(decider.id, cashSettlements.decidedBy));

export async function loadSettlement(db: Executor, ctx: Ctx, id: string): Promise<Settlement> {
  const [row] = await joined(db).where(and(eq(cashSettlements.id, id), visibility(ctx)));
  if (!row) throw new DomainError('NOT_FOUND', { entity: 'settlement', id });
  return toDto(row);
}

export async function getSettlement(ctx: Ctx, id: string): Promise<Settlement> {
  authorizeAny(ctx, ['cash.submit_settlement', 'cash.approve_settlement', 'cash.view_cash_in_hand']);
  return loadSettlement(ctx.tx ?? getDb(), ctx, id);
}

export type SettlementFilter = {
  readonly status?: SettlementStatus | undefined; readonly sellerId?: string | undefined;
  readonly cursor?: string | undefined; readonly limit?: number | undefined;
};

/** Newest first: a seller's own, or — for approvers and cash viewers — everyone's. */
export async function listSettlements(ctx: Ctx, filter: SettlementFilter): Promise<{ items: Settlement[]; nextCursor: string | null }> {
  authorizeAny(ctx, ['cash.submit_settlement', 'cash.approve_settlement', 'cash.view_cash_in_hand']);
  const db = ctx.tx ?? getDb();
  const limit = pageLimit(filter.limit);
  const where: (SQL | undefined)[] = [visibility(ctx)];
  if (filter.status) where.push(eq(cashSettlements.status, filter.status));
  if (filter.sellerId) where.push(eq(cashSettlements.sellerId, filter.sellerId));
  if (filter.cursor) {
    const [at, id] = decodeCursor(filter.cursor, 2) as [string, string];
    where.push(or(lt(cashSettlements.submittedAt, new Date(at)), and(eq(cashSettlements.submittedAt, new Date(at)), lt(cashSettlements.id, id))));
  }
  const rows = await joined(db).where(and(...where)).orderBy(desc(cashSettlements.submittedAt), desc(cashSettlements.id)).limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map(toDto),
    nextCursor: rows.length > limit && last ? encodeCursor([last.s.submittedAt.toISOString(), last.s.id]) : null,
  };
}

/** CSH-003: the managers a seller can hand cash to — whoever may approve it. */
export async function handoverManagers(ctx: Ctx): Promise<{ id: string; name: string }[]> {
  authorize(ctx, 'cash.submit_settlement');
  const db = ctx.tx ?? getDb();
  const ids = await usersWithPermission(db, 'cash.approve_settlement');
  if (ids.length === 0) return [];
  const rows = await db.select({ id: users.id, name: users.name }).from(users)
    .where(and(inArray(users.id, ids), eq(users.status, 'ACTIVE'))).orderBy(asc(users.name));
  return rows;
}

export type SubmitSettlementInput = {
  readonly route: SettlementRoute; readonly amount: string; readonly photoId: string;
  /** CSH-002: the day the money was paid in. */ readonly depositedOn?: string | null | undefined;
  /** CSH-003: the manager taking the cash. */ readonly receivedById?: string | null | undefined;
  readonly note?: string | null | undefined;
};

/**
 * CSH-002, CSH-003, CSH-005 (STATE-MACHINES §6): the seller declares what
 * they are banking or handing over, with its photo. **Nothing is posted** —
 * the cash stays theirs until a manager approves.
 */
export async function submitSettlement(ctx: Ctx, input: SubmitSettlementInput): Promise<Settlement> {
  authorize(ctx, 'cash.submit_settlement');
  if (ctx.user.role !== 'SELLER') throw new DomainError('FORBIDDEN', { permission: 'cash.submit_settlement' });
  const declared = money(input.amount);
  const note = input.note?.trim() || null;

  return inTx(ctx, async (tx) => {
    await assertOwnEvidence(tx, ctx, input.photoId, 'DEPOSIT_SLIP');
    await lockCash(tx, ctx.user.id);
    assertDeclarable(declared, await cashInHand(tx, ctx.user.id));
    const receivedById = input.route === 'MANAGER_HANDOVER' ? (input.receivedById ?? null) : null;
    if (input.route === 'MANAGER_HANDOVER') {
      if (!receivedById) throw new DomainError('RECEIVER_REQUIRED');
      const [manager] = await tx.select({ id: users.id }).from(users)
        .where(and(eq(users.id, receivedById), eq(users.status, 'ACTIVE')));
      if (!manager) throw new DomainError('NOT_FOUND', { entity: 'manager', id: receivedById });
    }
    const depositedOn = input.route === 'BANK_DEPOSIT' ? (input.depositedOn ?? null) : null;
    if (input.route === 'BANK_DEPOSIT' && !depositedOn) throw new DomainError('INVALID_DATE', { field: 'depositedOn' });

    const id = newId();
    const number = await nextDocumentNumber(tx, 'ST', ctx.now, 6);
    await tx.insert(cashSettlements).values({
      id, number, sellerId: ctx.user.id, route: input.route, declaredAmount: declared, depositedOn, receivedBy: receivedById,
      photoId: input.photoId, note, submittedAt: ctx.now, branchId: ctx.branchId, createdBy: ctx.user.id, updatedBy: ctx.user.id,
    });
    await notify(tx, ctx, receivedById ? { users: [receivedById] } : { permission: 'cash.approve_settlement' },
      'SETTLEMENT_SUBMITTED', { number, amount: declared }, `/console/cash/${id}`);
    await audit(tx, ctx, { action: 'cash.settlement_submitted', entityType: 'cash_settlement', entityId: id, after: { number, route: input.route, declared } });
    return loadSettlement(tx, ctx, id);
  });
}

export type DecideSettlementInput = {
  readonly version: number; readonly approve: boolean;
  /** CSH-006: what the manager actually counted; the declared amount by default. */ readonly amount?: string | null | undefined;
  readonly comment?: string | null | undefined;
};

/**
 * CSH-004..007 (STATE-MACHINES §6): a manager approves — and only then does
 * the cash leave the seller's hands — or rejects with a comment. A different
 * amount is kept as well as the declared one, never instead of it.
 */
export async function decideSettlement(ctx: Ctx, id: string, input: DecideSettlementInput): Promise<Settlement> {
  authorize(ctx, 'cash.approve_settlement');
  const comment = input.comment?.trim() || null;

  return inTx(ctx, async (tx) => {
    const [row] = await tx.select().from(cashSettlements).where(eq(cashSettlements.id, id)).for('update');
    if (!row) throw new DomainError('NOT_FOUND', { entity: 'settlement', id });
    if (row.version !== input.version) throw new DomainError('VERSION_CONFLICT', { expected: row.version, given: input.version });
    if (row.sellerId === ctx.user.id) throw new DomainError('FOUR_EYES', { entity: 'cash_settlement' });
    // ADR-0040: a handover is approved by the manager it was handed to.
    if (row.route === 'MANAGER_HANDOVER' && row.receivedBy !== ctx.user.id) throw new DomainError('FORBIDDEN', { permission: 'cash.approve_settlement' });
    const status = transitionSettlement(row.status, input.approve ? 'approve' : 'reject');
    const declared = row.declaredAmount as Money;
    const approved = input.approve ? money(input.amount?.trim() || declared) : null;
    assertDecisionComment(declared, approved, comment);

    let cashEntryId: string | null = null;
    let discrepancyId: string | null = null;
    if (approved) {
      await lockCash(tx, row.sellerId);
      const postings = settlementPostings(declared, approved, await cashInHand(tx, row.sellerId));
      const entry = async (entryType: 'SETTLEMENT_APPROVED' | 'DISCREPANCY', amount: Money) => {
        const [e] = await tx.insert(cashLedgerEntries).values({
          sellerId: row.sellerId, occurredAt: ctx.now, entryType, amount,
          referenceType: 'CASH_SETTLEMENT', referenceId: id, branchId: ctx.branchId, createdBy: ctx.user.id,
        }).returning({ id: cashLedgerEntries.id });
        if (!e) throw new Error('cash ledger insert returned nothing');
        return e.id;
      };
      // CSH-006: the discrepancy first, so cash in hand never dips below zero on the way.
      if (postings.discrepancy) discrepancyId = await entry('DISCREPANCY', postings.discrepancy);
      cashEntryId = await entry('SETTLEMENT_APPROVED', postings.settlement);
    }
    await tx.update(cashSettlements).set({
      status, approvedAmount: approved, decidedAt: ctx.now, decidedBy: ctx.user.id, decisionComment: comment,
      cashLedgerEntryId: cashEntryId, discrepancyEntryId: discrepancyId, version: row.version + 1, updatedAt: ctx.now, updatedBy: ctx.user.id,
    }).where(eq(cashSettlements.id, id));

    // CSH-007: settling can take the seller back under their ceiling.
    if (approved) await syncFlagsFor(tx, ctx, row.sellerId);
    await notify(tx, ctx, { users: [row.sellerId] }, input.approve ? 'SETTLEMENT_APPROVED' : 'SETTLEMENT_REJECTED',
      { number: row.number, amount: approved ?? declared }, `/field/cash/${id}`);
    await audit(tx, ctx, {
      action: input.approve ? 'cash.settlement_approved' : 'cash.settlement_rejected', entityType: 'cash_settlement', entityId: id,
      before: { status: row.status }, after: { status, approved, comment },
    });
    return loadSettlement(tx, ctx, id);
  });
}
