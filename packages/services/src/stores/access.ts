import {
  businessDate, creditStatus, DomainError, type BalanceConfirmation, type BlockReason, type CreditMode, type CreditStatus, type Money, type PermissionCode,
  type StoreStatus,
} from '@gsa/core';
import { schema } from '@gsa/db';
import { aliasedTable, and, eq, gt, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { Ctx } from '../context';
import type { Executor } from '../platform';
import { readSettings } from '../system';

const { stores, storeAssignments, storeLedgerEntries, storeReverifications, paymentAllocations, creditOverrides, priceLists, sales, users, importBatches } = schema;

/** A seller sees the stores they manage; `stores.view_all` sees every store. */
export const seesAllStores = (ctx: Ctx) => ctx.permissions.has('stores.view_all');

/**
 * For reading back a store the caller has just acted on under a permission of
 * its own (approving, adjusting, overriding) — never for deciding access.
 */
export const readingAsManager = (ctx: Ctx): Ctx => ({ ...ctx, permissions: new Set<PermissionCode>([...ctx.permissions, 'stores.view_all']) });

export type StoreSummary = {
  readonly id: string; /** DOC-009: GSA-S-0001… */ readonly code: string; readonly name: string;
  /** Null only while an imported store awaits re-verification (IMP-008), as are its terms and location. */
  readonly ownerName: string | null; readonly contactNumber: string | null; readonly category: string | null;
  readonly status: StoreStatus; readonly seller: { readonly id: string; readonly name: string } | null;
  readonly creditMode: CreditMode | null; readonly creditCycleDays: number | null; readonly creditLimit: Money;
  readonly credit: CreditStatus; readonly createdAt: Date;
  /** IMP-008: imported from Green Agro's books, rather than onboarded in the app. */
  readonly imported: boolean;
};

export type Store = StoreSummary & {
  readonly location: { readonly lat: number; readonly lng: number } | null; readonly address: string | null;
  readonly crNumber: string | null; readonly vatNumber: string | null; readonly nationalAddress: string | null;
  readonly priceList: { readonly id: string; readonly nameEn: string; readonly nameAr: string };
  readonly storefrontMediaId: string | null;
  readonly onboardedBy: { readonly id: string; readonly name: string };
  readonly decidedAt: Date | null; readonly decidedBy: string | null; readonly decisionReason: string | null;
  readonly assignments: readonly { readonly sellerId: string; readonly name: string; readonly startedAt: Date; readonly endedAt: Date | null }[];
  readonly override: { readonly reason: string; readonly grantedBy: string; readonly grantedAt: Date } | null;
  /** IMP-005, IMP-008: an imported store's re-verification — the balance shown to the store, and what it said. */
  readonly reverification: {
    readonly importedBalance: Money; readonly confirmation: BalanceConfirmation; readonly disputeNote: string | null;
    readonly at: Date; readonly by: string;
  } | null;
  readonly version: number;
};

export type OpenDebitRow = { storeId: string; id: string; dueOn: string; occurredAt: Date; open: Money };

/** Each debit's unsettled remainder: its amount less what credits settled of it (ADR-0036). */
export async function openDebits(db: Executor, storeIds: readonly string[]): Promise<OpenDebitRow[]> {
  if (storeIds.length === 0) return [];
  const settled = sql<string>`coalesce((select sum(${paymentAllocations.amount}) from ${paymentAllocations} where ${paymentAllocations.debitEntryId} = ${storeLedgerEntries.id}), 0)`;
  const rows = await db.select({
    storeId: storeLedgerEntries.storeId, id: storeLedgerEntries.id, dueOn: storeLedgerEntries.dueOn, occurredAt: storeLedgerEntries.occurredAt,
    open: sql<string>`(${storeLedgerEntries.amount} - ${settled})::numeric(14,2)`,
  }).from(storeLedgerEntries)
    .where(and(inArray(storeLedgerEntries.storeId, [...storeIds]), gt(storeLedgerEntries.amount, '0'), sql`${storeLedgerEntries.amount} > ${settled}`));
  return rows.map((r) => ({ storeId: r.storeId, id: r.id, dueOn: r.dueOn ?? '', occurredAt: r.occurredAt, open: r.open as Money }));
}

/**
 * ADR-0038: each store's dispatch orders not yet delivered — promised against
 * its credit, though not owed yet. For bill to bill, each is a bill on its way
 * (ADR-0047).
 */
async function committedByStore(db: Executor, storeIds: readonly string[]): Promise<Map<string, Money>> {
  const rows = await db.select({ storeId: sales.storeId, total: sql<string>`coalesce(sum(${sales.total}), 0)::numeric(14,2)` }).from(sales)
    .where(and(
      inArray(sales.storeId, [...storeIds]), eq(sales.channel, 'DISPATCH'),
      inArray(sales.status, ['PENDING_DISCOUNT_APPROVAL', 'DISCOUNT_APPROVED', 'PENDING_DELIVERY']),
    ))
    .groupBy(sales.storeId);
  return new Map(rows.flatMap((r) => (r.storeId ? [[r.storeId, r.total as Money] as const] : [])));
}

/** CRD-004..006: every store's credit status, derived now. */
export async function creditStatuses(
  db: Executor, rows: readonly { id: string; status: StoreStatus; creditMode: CreditMode | null; creditCycleDays: number | null; creditLimit: string }[], now: Date,
): Promise<Map<string, CreditStatus>> {
  if (rows.length === 0) return new Map();
  const ids = rows.map((r) => r.id);
  const today = businessDate(now);
  const debits = await openDebits(db, ids);
  const committed = await committedByStore(db, ids);
  const settings = await readSettings(db);
  const overrides = await db.select({ storeId: creditOverrides.storeId }).from(creditOverrides)
    .where(and(inArray(creditOverrides.storeId, ids), eq(creditOverrides.businessDate, today), isNull(creditOverrides.usedAt)));
  const overridden = new Set(overrides.map((o) => o.storeId));
  return new Map(rows.map((r) => [r.id, creditStatus({
    status: r.status, mode: r.creditMode, limit: r.creditLimit as Money, graceDays: settings['credit.grace_days'], today,
    cycleDays: r.creditCycleDays, weekClosesOn: settings['credit.week_closes_on'],
    overrideActive: overridden.has(r.id), openDebits: debits.filter((d) => d.storeId === r.id),
    committed: committed.get(r.id) ?? ('0.00' as Money),
  })]));
}

const onboarder = aliasedTable(users, 'onboarder');
const decider = aliasedTable(users, 'decider');
const seller = aliasedTable(users, 'seller');

/**
 * IMP-004: a store imported in a batch since undone is withdrawn with it — it does not exist for lists or lookups.
 * Its records stay, out of use.
 */
export const notWithdrawn = (): SQL => or(isNull(stores.importBatchId), sql`not exists (
  select 1 from ${importBatches} where ${importBatches.id} = ${stores.importBatchId} and ${importBatches.status} = 'UNDONE')`) as SQL;

/** One store, if the caller may see it — otherwise it does not exist for them (SECURITY §3). */
export async function loadStore(db: Executor, ctx: Ctx, id: string): Promise<Store> {
  const [row] = await db.select({
    s: stores, priceEn: priceLists.nameEn, priceAr: priceLists.nameAr, onboarderName: onboarder.name, deciderName: decider.name,
  }).from(stores)
    .innerJoin(priceLists, eq(priceLists.id, stores.priceListId))
    .leftJoin(onboarder, eq(onboarder.id, stores.createdBy))
    .leftJoin(decider, eq(decider.id, stores.decidedBy))
    .where(and(eq(stores.id, id), notWithdrawn()));
  if (!row) throw new DomainError('NOT_FOUND', { entity: 'store', id });
  const history = await db.select({ a: storeAssignments, name: seller.name }).from(storeAssignments)
    .innerJoin(seller, eq(seller.id, storeAssignments.sellerId))
    .where(eq(storeAssignments.storeId, id)).orderBy(sql`${storeAssignments.startedAt} desc`);
  const current = history.find((h) => h.a.endedAt === null);
  if (!seesAllStores(ctx) && current?.a.sellerId !== ctx.user.id) throw new DomainError('NOT_FOUND', { entity: 'store', id });
  const credit = (await creditStatuses(db, [row.s], ctx.now)).get(id);
  if (!credit) throw new Error('credit status missing');
  const granter = aliasedTable(users, 'granter');
  const [override] = await db.select({ o: creditOverrides, by: granter.name }).from(creditOverrides)
    .innerJoin(granter, eq(granter.id, creditOverrides.grantedBy))
    .where(and(eq(creditOverrides.storeId, id), eq(creditOverrides.businessDate, businessDate(ctx.now)), isNull(creditOverrides.usedAt)));
  const verifier = aliasedTable(users, 'verifier');
  const [reverified] = await db.select({ r: storeReverifications, by: verifier.name }).from(storeReverifications)
    .innerJoin(verifier, eq(verifier.id, storeReverifications.reverifiedBy))
    .where(eq(storeReverifications.storeId, id));
  return {
    ...summaryOf(row.s, current ? { id: current.a.sellerId, name: current.name } : null, credit),
    location: row.s.latitude !== null && row.s.longitude !== null ? { lat: Number(row.s.latitude), lng: Number(row.s.longitude) } : null,
    address: row.s.address,
    crNumber: row.s.crNumber, vatNumber: row.s.vatNumber, nationalAddress: row.s.nationalAddress,
    priceList: { id: row.s.priceListId, nameEn: row.priceEn, nameAr: row.priceAr }, storefrontMediaId: row.s.storefrontMediaId,
    onboardedBy: { id: row.s.createdBy ?? '', name: row.onboarderName ?? '' },
    decidedAt: row.s.decidedAt, decidedBy: row.deciderName, decisionReason: row.s.decisionReason,
    assignments: history.map((h) => ({ sellerId: h.a.sellerId, name: h.name, startedAt: h.a.startedAt, endedAt: h.a.endedAt })),
    override: override ? { reason: override.o.reason, grantedBy: override.by, grantedAt: override.o.grantedAt } : null,
    reverification: reverified ? {
      importedBalance: reverified.r.importedBalance as Money, confirmation: reverified.r.confirmation, disputeNote: reverified.r.disputeNote,
      at: reverified.r.reverifiedAt, by: reverified.by,
    } : null,
    version: row.s.version,
  };
}

export const summaryOf = (s: typeof stores.$inferSelect, currentSeller: { id: string; name: string } | null, credit: CreditStatus): StoreSummary => ({
  id: s.id, code: s.code, name: s.name, ownerName: s.ownerName, contactNumber: s.contactNumber, category: s.category, status: s.status,
  seller: currentSeller, creditMode: s.creditMode, creditCycleDays: s.creditCycleDays, creditLimit: s.creditLimit as Money,
  credit, createdAt: s.createdAt, imported: s.importBatchId !== null,
});

export type { BlockReason };
