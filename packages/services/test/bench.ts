import { businessDate } from '@gsa/core';
import { listCategories, listProducts, listSkus } from '../src/catalogue';
import type { Ctx } from '../src/context';
import { listMyNotifications } from '../src/notifications';
import { getSkuStock, listExpiryFlags, listStock } from '../src/inventory';
import { listRecommendations, salesTrends } from '../src/reports';
import { listSales } from '../src/sales';
import { listStores } from '../src/stores';
import { getCreditStatus, listStoreLedger, recordPayment } from '../src/stores';
import { cashInHand, listSellerCash, listSettlements } from '../src/cash';
import { listStandings } from '../src/targets';
import { confirmLoad, getMyVehicle, issueLoad } from '../src/vehicles';
import { closeDb, getDb, setBlobStore, setMailer } from '../src/runtime';
import { blobs } from './blobs';
import { closeOwner, ownerQuery, resetDatabase } from './db';
import { mailer } from './mailer';
import { anAccount, ctxFor } from './factories';
import { aSellingSeller } from './sales';
import { aStore } from './stores';
import { moreBags } from './stock';
import { recordSale } from '../src/sales';
import { setPriceListItems } from '../src/pricing';
import { basePriceListId } from './stores';
import { decideStore } from '../src/stores';
import { rebuildRollup } from '../src/reports';

/**
 * The performance check (M12): a year of trading, then every hot read path
 * timed and counted.
 *
 * Phase 1 is a small business — two sellers, seventy-odd stores, forty SKUs —
 * so a year is tens of thousands of rows, not millions. The risk is therefore
 * not raw volume but **work that grows with the rows**: a query per row, or a
 * scan of a whole ledger to answer one question. Counting the queries a call
 * makes catches the first; timing against a year's data catches the second.
 *
 * Nothing here writes through anything but the ordinary use cases, so the
 * ledgers it measures are ones the system could actually have produced.
 */

const DAYS = Number(process.env.BENCH_DAYS ?? 250);
const SELLERS = Number(process.env.BENCH_SELLERS ?? 2);
const STORES_PER_SELLER = Number(process.env.BENCH_STORES ?? 38);
const SALES_PER_DAY = Number(process.env.BENCH_SALES_PER_DAY ?? 8);

const DAY_MS = 86_400_000;

/** Counts the statements a call makes, by wrapping the pool for its duration. */
async function counted<T>(run: () => Promise<T>): Promise<{ value: T; queries: number; ms: number }> {
  const client = getDb().$client as unknown as { query: (...args: unknown[]) => unknown };
  const original = client.query.bind(client);
  let queries = 0;
  client.query = (...args: unknown[]) => { queries += 1; return original(...args); };
  const started = performance.now();
  try {
    const value = await run();
    return { value, queries, ms: performance.now() - started };
  } finally {
    client.query = original;
  }
}

type Row = { path: string; ms: number; queries: number; note: string };

async function measure(rows: Row[], path: string, run: () => Promise<unknown>, describe: (value: never) => string = () => '') {
  // Twice: the first call pays for whatever the pool and planner cache.
  await run();
  const { value, queries, ms } = await counted(run);
  rows.push({ path, ms, queries, note: describe(value as never) });
}

async function build(admin: Ctx) {
  const startedAt = Date.now() - DAYS * DAY_MS;
  const sellers: { ctx: Ctx; id: string; stores: { id: string; cash: boolean }[] }[] = [];

  for (let s = 0; s < SELLERS; s += 1) {
    const setup = await aSellingSeller(admin, { packs: 20, creditLimit: '5000000.00' });
    // One consignment big enough for the year, received into the warehouse and
    // then loaded onto the vehicle, so it never runs dry mid-year.
    const packs = DAYS * SALES_PER_DAY * 3;
    await moreBags(admin, setup, { packs, lotNumber: `BENCH-${s}`, expiresOn: '2028-12-31' });
    const batch = (await getSkuStock(admin, setup.bag.id)).batches.find((b) => b.lotNumber === `BENCH-${s}`);
    if (!batch) throw new Error('the bench consignment did not land');
    const load = await issueLoad(admin, { vehicleId: setup.vehicle.id, lines: [{ batchId: batch.batchId, packs }] });
    await confirmLoad(setup.seller.ctx, load.id, { version: load.version });
    const stores: { id: string; cash: boolean }[] = [{ id: setup.store.id, cash: false }];
    for (let i = 1; i < STORES_PER_SELLER; i += 1) {
      // Alternating, so both ledgers fill: a bill-to-bill store pays at the
      // till (cash), a weekly store goes on account (store credit).
      const cash = i % 2 === 1;
      const created = await aStore(setup.seller.ctx, {
        creditLimit: '5000000.00', ...(cash ? { creditMode: 'BILL_TO_BILL' as const } : {}),
      });
      const approved = await decideStore(admin, created.id, 'approve', { version: created.version });
      stores.push({ id: approved.id, cash });
    }
    sellers.push({ ctx: setup.seller.ctx, id: setup.seller.account.id, stores });
    await setPriceListItems(admin, await basePriceListId(), [{ skuId: setup.bag.id, price: '90.00' }]);
    process.stdout.write(`  seller ${s + 1}/${SELLERS} ready with ${stores.length} stores\n`);
  }
  return { sellers, startedAt };
}

async function trade(sellers: Awaited<ReturnType<typeof build>>['sellers'], startedAt: number) {
  let sales = 0;
  let collections = 0;
  for (let day = 0; day < DAYS; day += 1) {
    const now = new Date(startedAt + day * DAY_MS);
    for (const seller of sellers) {
      const ctx = { ...seller.ctx, now };
      const vehicle = await getMyVehicle(ctx);
      const batch = vehicle.batches.find((b) => b.packs > 0);
      if (!batch) throw new Error(`seller ran out of stock on day ${day}`);
      for (let i = 0; i < SALES_PER_DAY; i += 1) {
        const store = seller.stores[(day * SALES_PER_DAY + i) % seller.stores.length];
        if (!store) continue;
        const sale = await recordSale(ctx, {
          storeId: store.id, lines: [{ skuId: batch.skuId, packs: 1 + ((day + i) % 3) }],
          ...(store.cash ? { payment: { method: 'CASH' as const, reference: null } } : {}),
        });
        sales += 1;
        // A credit store that never pays goes past due and is refused the next
        // sale (CRD-005) — correctly. Collecting is part of the round anyway,
        // and it is what fills the cash ledger for a weekly store.
        if (!store.cash) {
          await recordPayment(ctx, { storeId: store.id, amount: sale.total, method: 'CASH' });
          collections += 1;
        }
      }
    }
    if (day % 25 === 0) process.stdout.write(`  day ${day}/${DAYS} (${sales} sales, ${collections} collections)\n`);
  }
  return { sales, collections };
}

// Photographs and email never leave the machine for a benchmark (TESTING §3).
setBlobStore(blobs);
setMailer(mailer);

// A benchmark writes a year of invented trading, so it starts from nothing and
// refuses to do that anywhere but a local database.
const url = process.env.DATABASE_URL ?? '';
if (!/localhost|127\.0\.0\.1/.test(url)) throw new Error('the benchmark only runs against a local database');
if (process.env.NODE_ENV === 'production') throw new Error('refusing to run the benchmark with NODE_ENV=production');
await resetDatabase();

const admin = await ctxFor(await anAccount('SUPER_ADMIN'));
console.log(`building ${DAYS} days × ${SELLERS} sellers × ${SALES_PER_DAY} sales…`);
const built = await build(admin);
const { sales, collections } = await trade(built.sellers, built.startedAt);

const TABLES = ['sales', 'sale_lines', 'stock_movements', 'cash_ledger_entries', 'store_ledger_entries', 'stores', 'audit_log'];
const counts = await Promise.all(TABLES.map(async (t) => {
  const [row] = await ownerQuery<{ n: number }>(`select count(*)::int as n from ${t}`);
  return `${t} ${row?.n ?? 0}`;
}));
console.log(`\nbuilt: ${sales} sales, ${collections} collections — ${counts.join(', ')}\n`);

// The rollup is a nightly job; measure it, then measure what reads it.
const rebuild = await counted(() => rebuildRollup(admin, businessDate(new Date(built.startedAt)), businessDate(new Date())));
console.log(`rollup rebuild over ${DAYS} days: ${rebuild.ms.toFixed(0)}ms, ${rebuild.queries} queries, ${JSON.stringify(rebuild.value)}\n`);

const rows: Row[] = [];
const seller = built.sellers[0];
if (!seller) throw new Error('no seller');

await measure(rows, 'catalogue.listProducts', () => listProducts(admin));
await measure(rows, 'catalogue.listSkus', () => listSkus(admin));
await measure(rows, 'catalogue.listCategories', () => listCategories(admin));
await measure(rows, 'inventory.listStock', () => listStock(admin));
await measure(rows, 'inventory.listExpiryFlags', () => listExpiryFlags(admin));
await measure(rows, 'stores.listStores (admin)', () => listStores(admin));
await measure(rows, 'stores.listStores (seller)', () => listStores(seller.ctx));
await measure(rows, 'sales.listSales (admin, page 1)', () => listSales(admin, {}));
await measure(rows, 'sales.listSales (seller, page 1)', () => listSales(seller.ctx, {}));
await measure(rows, 'vehicles.getMyVehicle', () => getMyVehicle(seller.ctx));
await measure(rows, 'cash.cashInHand (seller)', () => cashInHand(getDb(), seller.id));
await measure(rows, 'cash.listSellerCash (admin)', () => listSellerCash(admin));
await measure(rows, 'cash.listSettlements', () => listSettlements(admin, {}));
await measure(rows, 'stores.getCreditStatus', () => getCreditStatus(admin, seller.stores[0]?.id ?? ''));
await measure(rows, 'stores.listStoreLedger', () => listStoreLedger(admin, seller.stores[0]?.id ?? ''));
await measure(rows, 'targets.listStandings', () => listStandings(admin));
await measure(rows, 'reports.salesTrends', () => salesTrends(admin, { dimension: 'SKU' }));
await measure(rows, 'reports.listRecommendations', () => listRecommendations(admin));
await measure(rows, 'notifications.listMyNotifications', () => listMyNotifications(seller.ctx, {}));

console.log('path                                 ms   queries');
console.log('------------------------------------ ----- -------');
for (const r of rows.sort((a, b) => b.ms - a.ms)) {
  console.log(`${r.path.padEnd(36)} ${r.ms.toFixed(0).padStart(5)} ${String(r.queries).padStart(7)}`);
}
await closeDb();
await closeOwner();
