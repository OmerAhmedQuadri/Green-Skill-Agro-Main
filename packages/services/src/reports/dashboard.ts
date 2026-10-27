import {
  analyticsRange, businessDate, comparisonRange, dashboardTabs, DASHBOARD_LIST_LENGTH, daysBetween, Dec, dec, DomainError, overdueOf, percentChange,
  teamStatus, TEAM_STATUSES, toMoney, worstBand,
  type Ageing, type AgeingBand, type DashboardTab, type Money, type PermissionCode, type QuietDays, type StoreStatus, type TeamStatus,
} from '@gsa/core';
import { schema } from '@gsa/db';
import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';
import { listAttendance } from '../attendance';
import { listSellerCash } from '../cash';
import type { Ctx } from '../context';
import { DISPATCH_READERS, listDispatchOrders, type DispatchSummary } from '../dispatch';
import { listExpiryFlags } from '../inventory';
import { listIncoming } from '../procurement';
import { getDb } from '../runtime';
import { listSales, type SaleSummary } from '../sales';
import { listStores } from '../stores';
import { listStandings } from '../targets';
import { listVehicles } from '../vehicles';
import { salesAnalytics, salesBySeller, salesTotals, type AnalyticsFilter, type Figures, type SalesAnalytics } from './analytics';
import { collectionsView, type CollectedRow } from './collections';
import { listRecommendations } from './forecast';

const { users, stores, storeAssignments, sales, cashSettlements, payments, transferDecisions, skus, products, categories, vehicles } = schema;

type Named = { readonly nameEn: string; readonly nameAr: string };
type Person = { readonly id: string; readonly name: string };
type StoreRef = { readonly id: string; readonly code: string; readonly name: string };

const can = (ctx: Ctx, ...any: PermissionCode[]) => any.some((p) => ctx.permissions.has(p));
const ZERO = toMoney(new Dec(0));
const sum = (values: readonly Money[]): Money => toMoney(values.reduce((t, v) => t.plus(dec(v)), new Dec(0)));

/**
 * ADR-0054: a tab for whoever may see some of its figures — refused, as any
 * use case refuses (ADR-0005), to anyone else. The use cases each part reads
 * check their own permissions again; a part the reader may not see is null.
 */
function authorizeTab(ctx: Ctx, tab: DashboardTab): void {
  if (!dashboardTabs(ctx.permissions).includes(tab)) throw new DomainError('FORBIDDEN', { tab });
}

// ---------------------------------------------------------------- Sales

/** RPT-012: a period's sales as the analytics count them, what they are compared with, and the latest sales. */
export type SalesTab = SalesAnalytics & {
  readonly previous: { readonly from: string; readonly to: string; readonly totals: Figures };
  /** Net against the comparison, in per cent to one place; null when it sold nothing. */ readonly change: string | null;
  /** For those who see every sale. */ readonly latest: readonly SaleSummary[] | null;
};

/**
 * RPT-012 (ADR-0054): the sales tab — every filter of the sales analytics, the
 * period against its comparison (a month so far against the same days of
 * last month; any other period against as many days before it), and the
 * latest sales under the same filters.
 */
export async function dashboardSales(ctx: Ctx, filter: AnalyticsFilter): Promise<SalesTab> {
  authorizeTab(ctx, 'sales');
  const view = await salesAnalytics(ctx, filter);
  const before = comparisonRange(view.range.from, view.range.to);
  const totals = await salesTotals(ctx, { ...filter, ...before });
  // The latest are the app's own sales: imported sales were never made in it (IMP-007).
  const channel = filter.channel === 'VEHICLE' || filter.channel === 'DISPATCH' ? filter.channel : undefined;
  const latest = !can(ctx, 'sales.view_all') ? null : filter.channel === 'IMPORTED' ? [] : (await listSales(ctx, {
    status: 'COMPLETED', from: filter.from, to: filter.to, sellerId: filter.sellerId, storeId: filter.storeId, vehicleId: filter.vehicleId,
    channel, productId: filter.productId, categoryId: filter.categoryId, limit: DASHBOARD_LIST_LENGTH,
  })).items;
  return { ...view, previous: { ...before, totals }, change: percentChange(view.totals.net, totals.net), latest };
}

// ---------------------------------------------------------------- Team

/** RPT-013: one seller on the day. A column the reader may not see is null. */
export type TeamRow = {
  readonly seller: Person;
  readonly status: TeamStatus | null;
  /** The first check-in of the day, and the vehicle it was on. */ readonly since: Date | null; readonly vehicle: string | null;
  readonly sales: { readonly net: Money; readonly count: number } | null;
  /** What the seller carries now — on today's view only. */
  readonly cash: { readonly inHand: Money; readonly ceiling: Money | null; readonly over: boolean } | null;
  readonly stock: { readonly value: Money; readonly ceiling: Money | null; readonly over: boolean } | null;
  /** The month's revenue target, if any: achievement in per cent, the pace (TGT-006), and the commission so far (COM-007). */
  readonly target: { readonly achievement: string; readonly behindPace: boolean; readonly commission: Money | null } | null;
};

export type TeamTab = {
  readonly date: string; readonly today: boolean;
  readonly columns: { readonly status: boolean; readonly sales: boolean; readonly carrying: boolean; readonly target: boolean };
  readonly counts: Readonly<Record<TeamStatus, number>> | null;
  readonly totals: {
    readonly sales: Money | null; readonly cash: Money | null; readonly stock: Money | null;
    /** COM-007: the month's commission so far, across the sellers; final once the month has frozen (COM-008). */
    readonly commission: { readonly amount: Money; readonly final: boolean } | null;
  };
  readonly rows: readonly TeamRow[];
};

/**
 * RPT-013 (ADR-0054): every active seller on a day — today unless asked —
 * with the columns the reader's permissions allow. What a seller carries is
 * a figure of now, so it shows on today's view only.
 */
export async function dashboardTeam(ctx: Ctx, input: { date?: string | undefined } = {}): Promise<TeamTab> {
  authorizeTab(ctx, 'team');
  const todayDate = businessDate(ctx.now);
  const date = input.date ?? todayDate;
  const range = analyticsRange(date, date);
  if (date > todayDate) throw new DomainError('INVALID_DATE', { field: 'date', value: date });
  const today = date === todayDate;
  const columns = {
    status: can(ctx, 'attendance.view', 'attendance.manage'),
    sales: can(ctx, 'reports.view_trends'),
    carrying: today && can(ctx, 'cash.view_cash_in_hand', 'cash.approve_settlement'),
    // Every seller's standing needs both; with only the first, a manager sees their own.
    target: can(ctx, 'targets.view_commission') && can(ctx, 'targets.manage'),
  };
  const db = ctx.tx ?? getDb();
  const sellers = await db.select({ id: users.id, name: users.name }).from(users)
    .where(and(eq(users.role, 'SELLER'), eq(users.status, 'ACTIVE'))).orderBy(asc(users.name));

  const days = columns.status ? new Map((await listAttendance(ctx, { from: date, to: date })).map((d) => [d.seller.id, d])) : null;
  const sold = columns.sales ? await salesBySeller(db, range) : null;
  const carrying = columns.carrying ? new Map((await listSellerCash(ctx)).map((e) => [e.sellerId, e])) : null;
  const standings = columns.target ? new Map((await listStandings(ctx, date.slice(0, 7))).map((s) => [s.seller.id, s])) : null;

  const rows: TeamRow[] = sellers.map((seller) => {
    const day = days?.get(seller.id);
    const sessions = (day?.sessions ?? []).filter((s) => s.status !== 'WITHDRAWN');
    const first = sessions.reduce<Date | null>((at, s) => (at === null || s.checkedInAt < at ? s.checkedInAt : at), null);
    const figures = sold?.get(seller.id);
    const held = carrying?.get(seller.id);
    const standing = standings?.get(seller.id);
    const revenue = standing?.progress.metrics.find((m) => m.metric === 'REVENUE');
    return {
      seller,
      status: days ? teamStatus(day?.status ?? null, sessions.some((s) => s.awaitingAuthorisation)) : null,
      since: first, vehicle: day?.vehicle?.registration ?? null,
      sales: sold ? { net: figures?.net ?? ZERO, count: figures?.sales ?? 0 } : null,
      cash: carrying ? { inHand: held?.cashInHand ?? ZERO, ceiling: held?.ceiling.CASH_IN_HAND ?? null, over: held?.over.includes('CASH_IN_HAND') ?? false } : null,
      stock: carrying ? { value: held?.stockValue ?? ZERO, ceiling: held?.ceiling.VEHICLE_STOCK_VALUE ?? null, over: held?.over.includes('VEHICLE_STOCK_VALUE') ?? false } : null,
      target: revenue ? { achievement: revenue.achievement, behindPace: standing?.behindPace ?? false, commission: standing?.commission ?? null } : null,
    };
  });
  // Who is out working first, then whoever is waiting or done; by name within each.
  const order = (r: TeamRow) => (r.status ? TEAM_STATUSES.indexOf(r.status) : 0);
  rows.sort((a, b) => order(a) - order(b) || a.seller.name.localeCompare(b.seller.name));
  const all = [...(standings?.values() ?? [])];
  return {
    date, today, columns,
    counts: days ? Object.fromEntries(TEAM_STATUSES.map((s) => [s, rows.filter((r) => r.status === s).length])) as Record<TeamStatus, number> : null,
    totals: {
      sales: sold ? sum(rows.map((r) => r.sales?.net ?? ZERO)) : null,
      cash: carrying ? sum(rows.map((r) => r.cash?.inHand ?? ZERO)) : null,
      stock: carrying ? sum(rows.map((r) => r.stock?.value ?? ZERO)) : null,
      commission: standings ? { amount: sum(all.map((s) => s.commission ?? ZERO)), final: all.length > 0 && all.every((s) => s.final) } : null,
    },
    rows,
  };
}

// ---------------------------------------------------------------- Stores

export type QuietStore = {
  readonly store: StoreRef; readonly seller: Person | null;
  /** The Riyadh day of the last purchase, and the days since; null for a store that has never bought. */ readonly lastSale: string | null; readonly days: number | null;
};
export type NewStore = { readonly store: StoreRef; readonly seller: Person | null; readonly createdAt: Date; readonly status: StoreStatus };

/** RPT-016: the stores — how many of each kind, which have gone quiet, and which are new. */
export type StoresTab = {
  readonly counts: { readonly active: number; readonly pending: number; readonly inactive: number; readonly blocked: number };
  readonly quiet: { readonly days: QuietDays; readonly count: number; readonly stores: readonly QuietStore[] };
  readonly fresh: { readonly from: string; readonly to: string; readonly count: number; readonly stores: readonly NewStore[] };
};

/**
 * RPT-016 (ADR-0054): the stores tab — active, awaiting approval, inactive and
 * blocked; the active stores that have bought nothing for the chosen days
 * (one never served counts once it is that old), longest quiet first; and
 * the stores onboarded in the period, newest first. One seller's, if chosen.
 */
export async function dashboardStores(ctx: Ctx, filter: { from: string; to: string; sellerId?: string | undefined; quietDays: QuietDays }): Promise<StoresTab> {
  authorizeTab(ctx, 'stores');
  const db = ctx.tx ?? getDb();
  const range = analyticsRange(filter.from, filter.to);
  const today = businessDate(ctx.now);
  const last = db.select({ storeId: sales.storeId, at: sql<string>`max(${sales.completedAt})`.as('at') }).from(sales)
    .where(and(eq(sales.status, 'COMPLETED'), sql`${sales.storeId} is not null`)).groupBy(sales.storeId).as('last_sale');
  const rows = await db.select({ s: stores, sellerId: users.id, sellerName: users.name, lastAt: last.at }).from(stores)
    .leftJoin(storeAssignments, and(eq(storeAssignments.storeId, stores.id), isNull(storeAssignments.endedAt)))
    .leftJoin(users, eq(users.id, storeAssignments.sellerId))
    .leftJoin(last, eq(last.storeId, stores.id))
    .where(and(ne(stores.status, 'REJECTED'), filter.sellerId ? eq(storeAssignments.sellerId, filter.sellerId) : undefined));
  const ref = (s: typeof stores.$inferSelect): StoreRef => ({ id: s.id, code: s.code, name: s.name });
  const sellerOf = (r: (typeof rows)[number]) => (r.sellerId && r.sellerName ? { id: r.sellerId, name: r.sellerName } : null);

  const quiet = rows.filter((r) => r.s.status === 'ACTIVE').map((r) => {
    const lastSale = r.lastAt ? businessDate(new Date(r.lastAt)) : null;
    return { row: r, lastSale, days: lastSale ? daysBetween(lastSale, today) : null, age: daysBetween(businessDate(r.s.createdAt), today) };
  }).filter((q) => (q.days ?? q.age) >= filter.quietDays)
    // Longest quiet first; a store never served after those that once were.
    .sort((a, b) => Number(a.days === null) - Number(b.days === null) || (b.days ?? b.age) - (a.days ?? a.age) || a.row.s.name.localeCompare(b.row.s.name));
  const fresh = rows.filter((r) => r.s.createdAt >= range.start && r.s.createdAt < range.end)
    .sort((a, b) => b.s.createdAt.getTime() - a.s.createdAt.getTime());
  // CRD-004: active stores held back by their debts or limit — one awaiting approval is counted as that.
  const blocked = (await listStores(ctx, { blocked: true, sellerId: filter.sellerId })).filter((s) => s.status === 'ACTIVE').length;
  return {
    counts: {
      active: rows.filter((r) => r.s.status === 'ACTIVE').length, pending: rows.filter((r) => r.s.status === 'PENDING_APPROVAL').length,
      inactive: rows.filter((r) => r.s.status === 'INACTIVE').length, blocked,
    },
    quiet: {
      days: filter.quietDays, count: quiet.length,
      stores: quiet.slice(0, DASHBOARD_LIST_LENGTH).map((q) => ({ store: ref(q.row.s), seller: sellerOf(q.row), lastSale: q.lastSale, days: q.days })),
    },
    fresh: {
      from: range.from, to: range.to, count: fresh.length,
      stores: fresh.slice(0, DASHBOARD_LIST_LENGTH).map((r) => ({ store: ref(r.s), seller: sellerOf(r), createdAt: r.s.createdAt, status: r.s.status })),
    },
  };
}

// ---------------------------------------------------------------- Money

export type OverdueStore = { readonly store: Person; readonly seller: Person | null; readonly overdue: Money; readonly total: Money; readonly worst: AgeingBand };

/** RPT-014: what stores owe, what came in, and the money between the two. A part the reader may not see is null. */
export type MoneyTab = {
  readonly owed: {
    readonly aged: Ageing; readonly overdue: Money; /** Stores that owe anything. */ readonly owing: number;
    /** CRD-004: stores that cannot buy on credit now. */ readonly blocked: number; readonly mostOverdue: readonly OverdueStore[];
  } | null;
  readonly collected: {
    readonly from: string; readonly to: string; readonly cash: Money; readonly bank: Money; readonly total: Money; readonly payments: number;
    readonly bySeller: readonly CollectedRow[];
  } | null;
  /** Taken from stores but not yet banked or confirmed. */
  readonly motion: {
    readonly withSellers: { readonly amount: Money; /** Sellers holding any. */ readonly sellers: number; /** LIM-004 */ readonly over: number };
    /** CSH-002: handed in, waiting for an approver. */ readonly settlements: { readonly count: number; readonly amount: Money };
    /** ADR-0046: for approvers — transfers nobody has checked against the bank yet. */ readonly transfers: { readonly count: number; readonly amount: Money } | null;
  } | null;
};

/**
 * RPT-014 (ADR-0054): the money tab — RPT-008's owed and collected (the
 * reports permission and every store), and the money in motion (the cash
 * permissions): with sellers, in settlements waiting, in transfers
 * unchecked. One seller's or one store's, if chosen.
 */
export async function dashboardMoney(ctx: Ctx, filter: { from: string; to: string; sellerId?: string | undefined; storeId?: string | undefined }): Promise<MoneyTab> {
  authorizeTab(ctx, 'money');
  const db = ctx.tx ?? getDb();
  const books = can(ctx, 'reports.view_trends') && can(ctx, 'stores.view_all');
  const view = books ? await collectionsView(ctx, filter) : null;
  // CRD-004: active stores held back by their debts or limit — one awaiting approval is not yet trading.
  const blockedStores = books ? (await listStores(ctx, { blocked: true, sellerId: filter.sellerId })).filter((s) => s.status === 'ACTIVE') : [];

  let motion: MoneyTab['motion'] = null;
  if (can(ctx, 'cash.view_cash_in_hand', 'cash.approve_settlement')) {
    const held = (await listSellerCash(ctx)).filter((e) => !filter.sellerId || e.sellerId === filter.sellerId);
    const [waiting] = await db.select({ count: sql<number>`count(*)::int`, amount: sql<string>`coalesce(sum(${cashSettlements.declaredAmount}), 0)::numeric(14,2)::text` })
      .from(cashSettlements).where(and(eq(cashSettlements.status, 'SUBMITTED'), filter.sellerId ? eq(cashSettlements.sellerId, filter.sellerId) : undefined));
    const [unchecked] = can(ctx, 'cash.approve_settlement')
      ? await db.select({ count: sql<number>`count(*)::int`, amount: sql<string>`coalesce(sum(${payments.amount}), 0)::numeric(14,2)::text` }).from(payments)
        .leftJoin(transferDecisions, eq(transferDecisions.paymentId, payments.id))
        .where(and(
          eq(payments.method, 'BANK_TRANSFER'), isNull(transferDecisions.id), isNull(payments.supersededBy), eq(payments.origin, 'APP'),
          filter.sellerId ? eq(payments.receivedBy, filter.sellerId) : undefined, filter.storeId ? eq(payments.storeId, filter.storeId) : undefined,
        ))
      : [];
    motion = {
      withSellers: {
        amount: sum(held.map((e) => e.cashInHand)), sellers: held.filter((e) => dec(e.cashInHand).gt(0)).length,
        over: held.filter((e) => e.over.includes('CASH_IN_HAND')).length,
      },
      settlements: { count: Number(waiting?.count ?? 0), amount: (waiting?.amount ?? ZERO) as Money },
      transfers: unchecked ? { count: Number(unchecked.count), amount: unchecked.amount as Money } : null,
    };
  }

  return {
    owed: view ? {
      aged: view.owed.aged, overdue: overdueOf(view.owed.aged), owing: view.owed.byStore.length,
      blocked: blockedStores.filter((s) => !filter.storeId || s.id === filter.storeId).length,
      mostOverdue: view.owed.byStore
        .map((r) => ({ store: r.store, seller: r.seller, overdue: overdueOf(r.aged), total: r.aged.total, worst: worstBand(r.aged) ?? 'NOT_DUE' }))
        .filter((r) => dec(r.overdue).gt(0))
        .sort((a, b) => dec(b.overdue).comparedTo(dec(a.overdue)) || a.store.name.localeCompare(b.store.name))
        .slice(0, DASHBOARD_LIST_LENGTH),
    } : null,
    collected: view ? { ...view.range, ...view.collected, bySeller: view.collected.bySeller.slice(0, DASHBOARD_LIST_LENGTH) } : null,
    motion,
  };
}

// ---------------------------------------------------------------- Stock

export type ExpiringBatch = {
  readonly batchId: string; readonly skuId: string; readonly code: string; readonly product: Named; readonly lotNumber: string | null;
  readonly expiresOn: string; readonly daysLeft: number; readonly heldPacks: number;
  /** EXP-001: within its warning days; else flagged as selling too slowly to clear in time (EXP-002..005). */ readonly time: boolean;
  /** EXP-006 */ readonly prioritised: boolean;
};

export type DueOrder = {
  readonly poId: string; readonly number: string; readonly vendorCode: string; readonly expectedArrival: string | null;
  readonly packs: number; readonly lines: number;
};

export type VehicleStock = {
  readonly id: string; readonly registration: string; readonly seller: Person | null; readonly packs: number;
  /** OQ-021: at the base price list. */ readonly value: Money; /** Loads issued and not yet confirmed. */ readonly outstandingLoads: number;
};

/** RPT-015: stock that needs someone. A part the reader may not see is null. */
export type StockTab = {
  readonly expiring: { readonly batches: number; readonly packs: number; readonly soonest: readonly ExpiringBatch[] } | null;
  readonly reorder: {
    readonly items: number; readonly builtAt: Date | null;
    readonly top: readonly { readonly skuId: string; readonly code: string; readonly product: Named; readonly variety: Named | null; readonly suggested: number; readonly guide: boolean }[];
  } | null;
  readonly incoming: { readonly orders: number; /** Expected before today and not yet in. */ readonly late: number; readonly next: readonly DueOrder[] } | null;
  readonly vehicles: { readonly value: Money; readonly packs: number; readonly loaded: number; readonly list: readonly VehicleStock[] } | null;
  /** RPT-009: dispatch orders asked for and on their way. */
  readonly dispatch: { readonly requested: number; readonly onTheRoad: number; readonly unconfirmed: number; readonly value: Money; readonly oldest: readonly DispatchSummary[] } | null;
};

/**
 * RPT-015 (ADR-0054): the stock tab — batches flagged for expiry, what the
 * forecast says to order, purchase orders due in (each narrowed to a product
 * or category, if chosen), the stock on each vehicle and the dispatch orders
 * on their way (never narrowed: they are whole loads and orders).
 */
export async function dashboardStock(ctx: Ctx, filter: { categoryId?: string | undefined; productId?: string | undefined } = {}): Promise<StockTab> {
  authorizeTab(ctx, 'stock');
  const db = ctx.tx ?? getDb();
  const today = businessDate(ctx.now);
  const chosen = filter.categoryId || filter.productId
    ? new Set((await db.select({ id: skus.id }).from(skus).innerJoin(products, eq(products.id, skus.productId))
      .where(and(filter.productId ? eq(products.id, filter.productId) : undefined, filter.categoryId ? eq(products.categoryId, filter.categoryId) : undefined)))
      .map((r) => r.id))
    : null;
  const keep = (skuId: string) => !chosen || chosen.has(skuId);

  const flags = can(ctx, 'inventory.view_all_stock', 'inventory.manage_expiry') ? (await listExpiryFlags(ctx, { onlyFlagged: true })).filter((f) => keep(f.skuId)) : null;
  const forecast = can(ctx, 'reports.view_forecast') ? await listRecommendations(ctx) : null;
  const lines = can(ctx, 'procurement.view', 'procurement.manage_po', 'procurement.approve_po', 'inventory.view_all_stock', 'inventory.receive_goods')
    ? (await listIncoming(ctx)).filter((l) => keep(l.skuId)) : null;
  const fleet = can(ctx, 'vehicles.manage', 'inventory.view_all_stock', 'inventory.issue_to_vehicle') ? await listVehicles(ctx) : null;
  const dispatching = can(ctx, ...DISPATCH_READERS);
  const released = dispatching ? (await listDispatchOrders(ctx, { status: 'RELEASED', limit: 200 })).items : null;
  const requested = dispatching ? (await listDispatchOrders(ctx, { status: 'REQUESTED', limit: 200 })).items.length : 0;

  const orders = new Map<string, DueOrder>();
  for (const l of lines ?? []) {
    const o = orders.get(l.poId);
    orders.set(l.poId, o
      ? { ...o, packs: o.packs + l.outstandingPacks, lines: o.lines + 1 }
      : { poId: l.poId, number: l.number, vendorCode: l.vendorCode, expectedArrival: l.expectedArrival, packs: l.outstandingPacks, lines: 1 });
  }
  // Soonest expected first; an order with no date at the end.
  const due = [...orders.values()].sort((a, b) => (a.expectedArrival ?? '9999').localeCompare(b.expectedArrival ?? '9999') || a.number.localeCompare(b.number));
  const toOrder = (forecast?.items ?? []).filter((r) => r.suggested > 0 && keep(r.skuId));
  const loaded = (fleet ?? []).filter((v) => v.packs > 0)
    .map((v) => ({
      id: v.id, registration: v.registration, seller: v.seller ? { id: v.seller.id, name: v.seller.name } : null,
      packs: v.packs, value: v.value, outstandingLoads: v.outstandingLoads,
    }))
    .sort((a, b) => dec(b.value).comparedTo(dec(a.value)) || a.registration.localeCompare(b.registration));

  return {
    expiring: flags ? {
      batches: flags.length, packs: flags.reduce((n, f) => n + f.heldPacks, 0),
      soonest: flags.slice(0, DASHBOARD_LIST_LENGTH).map((f) => ({
        batchId: f.batchId, skuId: f.skuId, code: f.code, product: f.product, lotNumber: f.lotNumber,
        expiresOn: f.expiresOn, daysLeft: f.daysLeft, heldPacks: f.heldPacks, time: f.time, prioritised: f.prioritised,
      })),
    } : null,
    reorder: forecast ? {
      items: toOrder.length, builtAt: forecast.builtAt,
      top: toOrder.slice(0, DASHBOARD_LIST_LENGTH).map((r) => ({ skuId: r.skuId, code: r.code, product: r.product, variety: r.variety, suggested: r.suggested, guide: r.guide })),
    } : null,
    incoming: lines ? {
      orders: due.length, late: due.filter((o) => o.expectedArrival !== null && o.expectedArrival < today).length, next: due.slice(0, DASHBOARD_LIST_LENGTH),
    } : null,
    vehicles: fleet ? {
      value: sum(loaded.map((v) => v.value)), packs: loaded.reduce((n, v) => n + v.packs, 0), loaded: loaded.length, list: loaded.slice(0, DASHBOARD_LIST_LENGTH),
    } : null,
    dispatch: released ? {
      requested, onTheRoad: released.length, unconfirmed: released.filter((o) => o.unconfirmed).length, value: sum(released.map((o) => o.total)),
      // Longest on the road first.
      oldest: [...released].sort((a, b) => (a.releasedAt?.getTime() ?? 0) - (b.releasedAt?.getTime() ?? 0)).slice(0, DASHBOARD_LIST_LENGTH),
    } : null,
  };
}

// ---------------------------------------------------------------- Options

/** What the filters offer — each list for the tabs that use it. */
export type DashboardOptions = {
  readonly tabs: readonly DashboardTab[];
  readonly sellers: readonly Person[];
  readonly stores: readonly StoreRef[];
  readonly vehicles: readonly { readonly id: string; readonly registration: string }[];
  readonly categories: readonly (Named & { readonly id: string })[];
  readonly products: readonly (Named & { readonly id: string; readonly categoryId: string })[];
};

/** ADR-0054: the reader's tabs, and what their filters can choose from. */
export async function dashboardOptions(ctx: Ctx): Promise<DashboardOptions> {
  const tabs = dashboardTabs(ctx.permissions);
  if (tabs.length === 0) throw new DomainError('FORBIDDEN', { tab: null });
  const db = ctx.tx ?? getDb();
  const uses = (...those: DashboardTab[]) => those.some((t) => tabs.includes(t));
  return {
    tabs,
    sellers: uses('sales', 'team', 'stores', 'money')
      ? await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.role, 'SELLER')).orderBy(asc(users.name)) : [],
    stores: uses('sales', 'money')
      ? await db.select({ id: stores.id, code: stores.code, name: stores.name }).from(stores).where(ne(stores.status, 'REJECTED')).orderBy(asc(stores.name)) : [],
    vehicles: uses('sales') ? await db.select({ id: vehicles.id, registration: vehicles.registration }).from(vehicles).orderBy(asc(vehicles.registration)) : [],
    categories: uses('sales', 'stock')
      ? await db.select({ id: categories.id, nameEn: categories.nameEn, nameAr: categories.nameAr }).from(categories).orderBy(asc(categories.nameEn)) : [],
    products: uses('sales', 'stock')
      ? await db.select({ id: products.id, nameEn: products.nameEn, nameAr: products.nameAr, categoryId: products.categoryId }).from(products).orderBy(asc(products.nameEn)) : [],
  };
}
