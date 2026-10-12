import {
  analyticsRange, businessDate, DASHBOARD_LIST_LENGTH, Dec, dec, glanceDays, overdueOf, teamStatus, TEAM_STATUSES, toMoney, worstBand,
  type Ageing, type AgeingBand, type Money, type PermissionCode, type TeamStatus,
} from '@gsa/core';
import { schema } from '@gsa/db';
import { and, asc, eq } from 'drizzle-orm';
import { listAttendance } from '../attendance';
import { listSellerCash } from '../cash';
import type { Ctx } from '../context';
import { listExpiryFlags } from '../inventory';
import { listIncoming } from '../procurement';
import { getDb } from '../runtime';
import { listSales, type SaleSummary } from '../sales';
import { listStores } from '../stores';
import { listStandings } from '../targets';
import { salesBySeller, salesGlance, type SalesGlance } from './analytics';
import { collectionsView } from './collections';
import { listRecommendations } from './forecast';

const { users } = schema;

type Named = { readonly nameEn: string; readonly nameAr: string };
type Person = { readonly id: string; readonly name: string };

/** RPT-012 (ADR-0054): the sales block, with the latest sales for those who see every sale. */
export type DashboardSales = SalesGlance & { readonly recent: readonly SaleSummary[] | null };

/** RPT-013: one seller today. A column the reader may not see is null. */
export type TeamRow = {
  readonly seller: Person;
  readonly status: TeamStatus | null;
  /** The first check-in today, and the vehicle it was on. */ readonly since: Date | null; readonly vehicle: string | null;
  readonly sales: { readonly net: Money; readonly count: number } | null;
  readonly cash: { readonly inHand: Money; readonly ceiling: Money | null; readonly over: boolean } | null;
  /** This month's revenue target, if the seller has one: achievement in per cent, and whether they are behind the pace (TGT-006). */
  readonly target: { readonly achievement: string; readonly behindPace: boolean } | null;
};

export type TeamToday = {
  readonly columns: { readonly status: boolean; readonly sales: boolean; readonly cash: boolean; readonly target: boolean };
  readonly counts: Readonly<Record<TeamStatus, number>> | null;
  readonly rows: readonly TeamRow[];
};

/** RPT-014: what stores owe now, and what was collected this month. */
export type MoneyOwed = {
  readonly aged: Ageing; readonly overdue: Money;
  /** Stores that owe anything. */ readonly owing: number;
  readonly mostOverdue: readonly { readonly store: Person; readonly seller: Person | null; readonly overdue: Money; readonly total: Money; readonly worst: AgeingBand }[];
  readonly collected: { readonly cash: Money; readonly bank: Money; readonly total: Money; readonly payments: number };
  /** CRD-004: stores that cannot buy on credit now. */ readonly blocked: number;
};

export type ExpiringBatch = {
  readonly batchId: string; readonly skuId: string; readonly code: string; readonly product: Named; readonly lotNumber: string | null;
  readonly expiresOn: string; readonly daysLeft: number; readonly heldPacks: number;
  /** EXP-001: within its warning days; else flagged because it is selling too slowly to clear in time (EXP-002..005). */ readonly time: boolean;
  /** EXP-006 */ readonly prioritised: boolean;
};

export type DueOrder = {
  readonly poId: string; readonly number: string; readonly vendorCode: string; readonly expectedArrival: string | null;
  readonly packs: number; readonly lines: number;
};

/** RPT-015: what needs doing about stock. A part the reader may not see is null. */
export type StockAlerts = {
  readonly expiring: { readonly batches: number; readonly packs: number; readonly soonest: readonly ExpiringBatch[] } | null;
  readonly reorder: {
    readonly items: number; readonly builtAt: Date | null;
    readonly top: readonly { readonly skuId: string; readonly code: string; readonly product: Named; readonly variety: Named | null; readonly suggested: number; readonly guide: boolean }[];
  } | null;
  readonly incoming: { readonly orders: number; /** Expected before today and not yet in. */ readonly late: number; readonly next: readonly DueOrder[] } | null;
};

export type Dashboard = {
  readonly today: string;
  readonly sales: DashboardSales | null; readonly team: TeamToday | null; readonly owed: MoneyOwed | null; readonly stock: StockAlerts | null;
};

const can = (ctx: Ctx, ...any: PermissionCode[]) => any.some((p) => ctx.permissions.has(p));

/**
 * RPT-012..015 (ADR-0054): the dashboard's blocks — sales at a glance, the
 * team today, the money stores owe, and stock that needs attention. Each is
 * read through the use case that owns its figures, which checks its own
 * permission; a block — or a part of one — the reader may not see is null
 * rather than refused, so everyone gets the dashboard their permissions allow.
 */
export async function getDashboard(ctx: Ctx): Promise<Dashboard> {
  const blocks = [() => dashboardSales(ctx), () => teamToday(ctx), () => moneyOwed(ctx), () => stockAlerts(ctx)] as const;
  // Outside a transaction the four read side by side; inside one, one after another.
  const [sales, team, owed, stock] = ctx.tx
    ? [await blocks[0](), await blocks[1](), await blocks[2](), await blocks[3]()]
    : await Promise.all([blocks[0](), blocks[1](), blocks[2](), blocks[3]()]);
  return { today: businessDate(ctx.now), sales, team, owed, stock };
}

async function dashboardSales(ctx: Ctx): Promise<DashboardSales | null> {
  if (!can(ctx, 'reports.view_trends')) return null;
  const glance = await salesGlance(ctx);
  const recent = can(ctx, 'sales.view_all') ? (await listSales(ctx, { status: 'COMPLETED', limit: DASHBOARD_LIST_LENGTH })).items : null;
  return { ...glance, recent };
}

async function teamToday(ctx: Ctx): Promise<TeamToday | null> {
  const columns = {
    status: can(ctx, 'attendance.view', 'attendance.manage'),
    sales: can(ctx, 'reports.view_trends'),
    cash: can(ctx, 'cash.view_cash_in_hand', 'cash.approve_settlement'),
    // Every seller's standing needs both; with only the first, a manager sees their own.
    target: can(ctx, 'targets.view_commission') && can(ctx, 'targets.manage'),
  };
  if (!columns.status && !columns.sales && !columns.cash && !columns.target) return null;
  const db = ctx.tx ?? getDb();
  const today = businessDate(ctx.now);
  const sellers = await db.select({ id: users.id, name: users.name }).from(users)
    .where(and(eq(users.role, 'SELLER'), eq(users.status, 'ACTIVE'))).orderBy(asc(users.name));

  const days = columns.status ? new Map((await listAttendance(ctx, { from: today, to: today })).map((d) => [d.seller.id, d])) : null;
  const sold = columns.sales ? await salesBySeller(db, analyticsRange(today, today)) : null;
  const cash = columns.cash ? new Map((await listSellerCash(ctx)).map((e) => [e.sellerId, e])) : null;
  const standings = columns.target ? new Map((await listStandings(ctx)).map((s) => [s.seller.id, s])) : null;

  const rows: TeamRow[] = sellers.map((seller) => {
    const day = days?.get(seller.id);
    const sessions = (day?.sessions ?? []).filter((s) => s.status !== 'WITHDRAWN');
    const first = sessions.reduce<Date | null>((at, s) => (at === null || s.checkedInAt < at ? s.checkedInAt : at), null);
    const figures = sold?.get(seller.id);
    const exposure = cash?.get(seller.id);
    const revenue = standings?.get(seller.id)?.progress.metrics.find((m) => m.metric === 'REVENUE');
    return {
      seller,
      status: days ? teamStatus(day?.status ?? null, sessions.some((s) => s.awaitingAuthorisation)) : null,
      since: first, vehicle: day?.vehicle?.registration ?? null,
      sales: sold ? { net: figures?.net ?? toMoney(new Dec(0)), count: figures?.sales ?? 0 } : null,
      cash: cash ? {
        inHand: exposure?.cashInHand ?? toMoney(new Dec(0)), ceiling: exposure?.ceiling.CASH_IN_HAND ?? null,
        over: exposure?.over.includes('CASH_IN_HAND') ?? false,
      } : null,
      target: revenue ? { achievement: revenue.achievement, behindPace: standings?.get(seller.id)?.behindPace ?? false } : null,
    };
  });
  // Who is out working first, then whoever is waiting or done; by name within each.
  const order = (r: TeamRow) => (r.status ? TEAM_STATUSES.indexOf(r.status) : 0);
  rows.sort((a, b) => order(a) - order(b) || a.seller.name.localeCompare(b.seller.name));
  const counts = days ? Object.fromEntries(TEAM_STATUSES.map((s) => [s, rows.filter((r) => r.status === s).length])) as Record<TeamStatus, number> : null;
  return { columns, counts, rows };
}

async function moneyOwed(ctx: Ctx): Promise<MoneyOwed | null> {
  // Store balances are store data: the reports permission and every store (as RPT-008's view).
  if (!can(ctx, 'reports.view_trends') || !can(ctx, 'stores.view_all')) return null;
  const { month } = glanceDays(businessDate(ctx.now));
  const view = await collectionsView(ctx, month);
  const blocked = (await listStores(ctx, { blocked: true })).length;
  const mostOverdue = view.owed.byStore
    .map((r) => ({ store: r.store, seller: r.seller, overdue: overdueOf(r.aged), total: r.aged.total, worst: worstBand(r.aged) ?? 'NOT_DUE' }))
    .filter((r) => dec(r.overdue).gt(0))
    .sort((a, b) => dec(b.overdue).comparedTo(dec(a.overdue)) || a.store.name.localeCompare(b.store.name))
    .slice(0, DASHBOARD_LIST_LENGTH);
  const { cash, bank, total, payments } = view.collected;
  return {
    aged: view.owed.aged, overdue: overdueOf(view.owed.aged), owing: view.owed.byStore.filter((r) => dec(r.aged.total).gt(0)).length,
    mostOverdue, collected: { cash, bank, total, payments }, blocked,
  };
}

async function stockAlerts(ctx: Ctx): Promise<StockAlerts | null> {
  const parts = {
    expiring: can(ctx, 'inventory.view_all_stock', 'inventory.manage_expiry'),
    reorder: can(ctx, 'reports.view_forecast'),
    incoming: can(ctx, 'procurement.view', 'procurement.manage_po', 'procurement.approve_po', 'inventory.view_all_stock', 'inventory.receive_goods'),
  };
  if (!parts.expiring && !parts.reorder && !parts.incoming) return null;
  const today = businessDate(ctx.now);

  const flags = parts.expiring ? await listExpiryFlags(ctx, { onlyFlagged: true }) : null;
  const forecast = parts.reorder ? await listRecommendations(ctx) : null;
  const lines = parts.incoming ? await listIncoming(ctx) : null;

  const orders = new Map<string, DueOrder>();
  for (const l of lines ?? []) {
    const o = orders.get(l.poId);
    orders.set(l.poId, o
      ? { ...o, packs: o.packs + l.outstandingPacks, lines: o.lines + 1 }
      : { poId: l.poId, number: l.number, vendorCode: l.vendorCode, expectedArrival: l.expectedArrival, packs: l.outstandingPacks, lines: 1 });
  }
  // Soonest expected first; an order with no date at the end.
  const due = [...orders.values()].sort((a, b) => (a.expectedArrival ?? '9999').localeCompare(b.expectedArrival ?? '9999') || a.number.localeCompare(b.number));
  const toOrder = (forecast?.items ?? []).filter((r) => r.suggested > 0);

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
  };
}
