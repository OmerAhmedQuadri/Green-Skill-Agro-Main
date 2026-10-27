import type { imports } from '@gsa/contracts';
import type { DomainError } from '@gsa/core';
import { schema } from '@gsa/db';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { aCatalogueBase } from '../../test/catalogue';
import { anAccount, ctxFor, PASSWORD } from '../../test/factories';
import { aPhoto } from '../../test/media';
import { basePriceListId, SHOP } from '../../test/stores';
import { createProduct, createSku, createVariety } from '../catalogue';
import { listImportWarnings, openCorrectionSession, resolveImportWarning } from '../corrections';
import { waitingForDecision } from '../notifications';
import { getDb } from '../runtime';
import { getStore, listStores, reverifyStore } from '../stores';
import { loadHistoryImport, planHistoryImport, undoImportBatch } from './index';

/** Synthetic throughout: client data never enters the repository, tests included (CLIENT-DATA.md). */
const codeOf = async (p: Promise<unknown>) => p.then(() => 'NO_ERROR', (e: DomainError) => e.code ?? String(e));
const pgCode = async (p: Promise<unknown>) =>
  p.then(() => 'NO_ERROR', (e: { message?: string; cause?: { code?: string } }) => e.cause?.code ?? e.message ?? 'UNKNOWN');
let n = 0;
const unique = () => `${Date.now() % 1_000_000}-${(n += 1)}`;
const INVOICES = 'Seller A Invoices.xlsx';
const VOUCHERS = 'Seller A Vouchers.xlsx';

/** A Super Admin, a seller, and a catalogue product of a name no other test uses: what a file can name. */
async function setup() {
  const owner = await ctxFor(await anAccount('SUPER_ADMIN'));
  const seller = await anAccount('SELLER');
  const base = await aCatalogueBase(owner);
  const name = `Snake Gourd ${unique()}`;
  const product = await createProduct(owner, {
    productTypeId: base.seeds.id, categoryId: base.category.id, subCategoryId: base.sub.id, nameEn: name, nameAr: 'قرع',
    hybrid: 'NON_HYBRID', countryOfOrigin: 'IN', vendorId: base.vendor.id, shelfLifeMonths: 24,
  });
  const variety = (await createVariety(owner, product.id, { nameEn: 'Long Green', nameAr: 'أخضر طويل' })).varieties[0];
  if (!variety) throw new Error('variety missing');
  await createSku(owner, product.id, { varietyId: variety.id, size: { measure: 'WEIGHT', value: '5', unit: 'KG' }, packaging: 'BAG' });
  const [sku] = await getDb().select({ id: schema.skus.id }).from(schema.skus).where(eq(schema.skus.productId, product.id));
  return { owner, seller, product: { name, variety: 'Long Green', packGrams: 5000 }, skuId: sku?.id ?? '' };
}

/** Two stores of one seller's books: three invoices, three payments (one placed nowhere), and three warnings. */
function aFile(product: { name: string; variety: string; packGrams: number }): imports.HistoryImportFile {
  const k = unique();
  const written = { storeNameWritten: 'As written' };
  return {
    format: 'gsa-history/1',
    files: [{ name: INVOICES, sha256: 'a'.repeat(64), bytes: 1000 }, { name: VOUCHERS, sha256: 'b'.repeat(64), bytes: 500 }],
    note: 'A rehearsal',
    stores: [{ key: 'S1', name: `Al Noor ${k}`, seller: 'Haneef' }, { key: 'S2', name: `Al Fajr ${k}`, seller: 'Haneef' }],
    sales: [
      { store: 'S1', seller: 'Haneef', soldOn: '2026-09-10', serial: 1, book: INVOICES, bookRow: 2, ...written,
        lines: [{ item: `${product.name} Long Green`, pack: '5kg', product, packs: '2', unitPrice: '150.00', amount: '300.00' }] },
      { store: 'S1', seller: 'Haneef', soldOn: '2026-10-01', serial: 2, book: INVOICES, bookRow: 3, discount: '10.00', ...written,
        lines: [{ item: 'A seed nobody stocks', pack: '100g', product: null, packs: '1', unitPrice: '110.00', amount: '110.00' }] },
      { store: 'S2', seller: 'Haneef', soldOn: '2026-10-02', serial: 3, book: INVOICES, bookRow: 4, ...written,
        lines: [{ item: `${product.name} Long Green`, pack: '5kg', product, packs: '1', unitPrice: '150.00', amount: '150.00' }] },
    ],
    payments: [
      { store: 'S1', seller: 'Haneef', paidOn: '2026-09-20', amount: '200.00', kind: 'VOUCHER', method: 'CASH', voucherNumber: `V${k}1`, book: VOUCHERS, bookRow: 2, ...written },
      { store: 'S2', seller: 'Haneef', paidOn: '2026-10-05', amount: '50.00', kind: 'VOUCHER', method: 'CASH', voucherNumber: null, book: VOUCHERS, bookRow: 3, ...written },
      { store: null, seller: 'Haneef', paidOn: '2026-10-06', amount: '75.00', kind: 'VOUCHER', method: 'CASH', voucherNumber: `V${k}3`, book: VOUCHERS, bookRow: 4, ...written },
    ],
    warnings: [
      { kind: 'VOUCHER_MISSING', payment: { book: VOUCHERS, bookRow: 3 }, params: {} },
      { kind: 'PAYMENT_NO_STORE', payment: { book: VOUCHERS, bookRow: 4 }, params: { written: 'Somebody' } },
      { kind: 'LINE_NOT_IN_CATALOGUE', sale: { book: INVOICES, bookRow: 3 }, params: { line: 1, item: 'A seed nobody stocks' } },
    ],
  };
}

describe("the history import: Green Agro's books, checked, loaded as a batch, undone (ADR-0059)", () => {
  it('IMP-004: the dry run checks the file against this database and writes nothing', async () => {
    const { owner, seller, product, skuId } = await setup();
    const file = aFile(product);
    const sellers = new Map([['Haneef', seller.email]]);
    const plan = await planHistoryImport(getDb(), file, sellers);
    expect(plan.problems).toEqual([]);
    expect(plan.counts).toMatchObject({ stores: 2, sales: 3, lines: 3, linesInCatalogue: 2, payments: 3, paymentsWithNoStore: 1 });
    expect(plan.counts.warnings).toEqual({ VOUCHER_MISSING: 1, PAYMENT_NO_STORE: 1, LINE_NOT_IN_CATALOGUE: 1 });
    expect(plan).toMatchObject({ billed: '550.00', paid: '325.00' });
    expect([...plan.products.values()]).toEqual([skuId]);
    expect((await listStores(owner, { search: file.stores[0]?.name })).length).toBe(0);

    // What stops a load: a seller not given, a store nobody listed, an invoice twice, more paid than billed, a warning about nothing.
    const broken: imports.HistoryImportFile = {
      ...file,
      sales: [...file.sales, { ...file.sales[0]!, bookRow: 9 }, { ...file.sales[2]!, store: 'S9', serial: 7, bookRow: 10 }],
      payments: [...file.payments, { ...file.payments[1]!, amount: '900.00', bookRow: 11 }],
      warnings: [...file.warnings, { kind: 'VOUCHER_MISSING', payment: { book: VOUCHERS, bookRow: 99 }, params: {} }],
    };
    const problems = (await planHistoryImport(getDb(), broken, new Map())).problems;
    expect(problems).toEqual(expect.arrayContaining([
      'seller "Haneef": not given — add --seller "Haneef=<email>"',
      `${INVOICES} row 10: no store "S9"`,
      `${INVOICES} row 9: Haneef's invoice 1 appears twice`,
      'store "S2": paid 950.00, more than billed 150.00',
      `warning VOUCHER_MISSING: no payment at ${VOUCHERS}#99`,
    ]));
    expect(await codeOf(loadHistoryImport(owner, broken, await planHistoryImport(getDb(), broken, new Map()), file.files))).toContain('problem');
  });

  it('IMP-001, IMP-002, IMP-009: loaded as one batch — stores awaiting re-verification, records as written, warnings for the Super Admin', async () => {
    const { owner, seller, product, skuId } = await setup();
    const file = aFile(product);
    const plan = await planHistoryImport(getDb(), file, new Map([['Haneef', seller.email]]));
    const admin = await ctxFor(await anAccount('ADMIN'));
    expect(await codeOf(loadHistoryImport(admin, file, plan, file.files))).toBe('FORBIDDEN');
    const loaded = await loadHistoryImport(owner, file, plan, file.files);
    expect(loaded).toMatchObject({ stores: 2, sales: 3, payments: 3, warnings: 3 });
    const [batch] = await getDb().select().from(schema.importBatches).where(eq(schema.importBatches.id, loaded.batch.id));
    expect(batch).toMatchObject({ status: 'LOADED', files: file.files, note: 'A rehearsal' });
    const imported = await listStores(owner, { search: file.stores[0]?.name });
    expect(imported.map((s) => [s.status, s.imported, s.seller?.id])).toEqual([['AWAITING_REVERIFICATION', true, seller.id]]);
    const lines = await getDb().select({ sku: schema.importedSaleLines.skuId }).from(schema.importedSaleLines)
      .innerJoin(schema.importedSales, eq(schema.importedSales.id, schema.importedSaleLines.importedSaleId))
      .where(eq(schema.importedSales.batchId, loaded.batch.id));
    expect(lines.map((l) => l.sku).sort()).toEqual([skuId, skuId, null].sort());

    // IMP-009: on the Super Admin's dashboard, and on the Corrections page with what each is about.
    expect((await waitingForDecision(owner)).find((q) => q.queue === 'IMPORT_WARNINGS')?.count).toBeGreaterThanOrEqual(3);
    const warnings = (await listImportWarnings(owner)).filter((w) => w.batch === loaded.batch.number);
    expect(warnings.map((w) => w.kind).sort()).toEqual(['LINE_NOT_IN_CATALOGUE', 'PAYMENT_NO_STORE', 'VOUCHER_MISSING']);
    const line = warnings.find((w) => w.kind === 'LINE_NOT_IN_CATALOGUE');
    expect(line).toMatchObject({ params: { line: 1, item: 'A seed nobody stocks' }, sale: { serial: 2, total: '100.00', store: { name: file.stores[0]?.name } } });

    // Kept with a note; corrected only in a session; each once.
    const missing = warnings.find((w) => w.kind === 'VOUCHER_MISSING');
    const placed = warnings.find((w) => w.kind === 'PAYMENT_NO_STORE');
    if (!missing || !placed || !line) throw new Error('warnings missing');
    expect(await codeOf(resolveImportWarning(owner, missing.id, { resolution: 'KEPT', note: ' ' }))).toBe('REASON_REQUIRED');
    await resolveImportWarning(owner, missing.id, { resolution: 'KEPT', note: 'The seller confirmed the store paid in cash, no slip' });
    expect(await codeOf(resolveImportWarning(owner, missing.id, { resolution: 'KEPT', note: 'Again' }))).toBe('ALREADY_DECIDED');
    expect(await codeOf(resolveImportWarning(owner, placed.id, { resolution: 'CORRECTED', note: 'Attached to its store' }))).toBe('NO_CORRECTION_SESSION');
    await openCorrectionSession(owner, { password: PASSWORD, reason: 'Settling the import warnings' });
    await resolveImportWarning(owner, placed.id, { resolution: 'CORRECTED', note: 'Attached to its store' });
    const resolved = (await listImportWarnings(owner, { resolved: true })).filter((w) => w.batch === loaded.batch.number);
    expect(resolved.map((w) => [w.kind, w.resolution?.as, w.resolution?.session === null])).toEqual(expect.arrayContaining([
      ['VOUCHER_MISSING', 'KEPT', true], ['PAYMENT_NO_STORE', 'CORRECTED', false],
    ]));
    // A resolution stands: the database refuses another (SQLSTATE 23514).
    expect(await pgCode(getDb().execute(sql`update import_warnings set resolution = 'CORRECTED' where id = ${missing.id}`))).toBe('23514');
  });

  it('IMP-004: a batch is undone whole, with a reason — its stores withdrawn — only while nothing of it is in an account', async () => {
    const { owner, seller, product } = await setup();
    const sellers = new Map([['Haneef', seller.email]]);
    const first = aFile(product);
    const loaded = await loadHistoryImport(owner, first, await planHistoryImport(getDb(), first, sellers), first.files);
    const [store] = await listStores(owner, { search: first.stores[0]?.name });
    if (!store) throw new Error('store missing');
    expect(await codeOf(undoImportBatch(owner, loaded.batch.number, ' '))).toBe('REASON_REQUIRED');
    await undoImportBatch(owner, loaded.batch.number, 'Green Agro sent corrected books');
    expect(await listStores(owner, { search: first.stores[0]?.name })).toEqual([]);
    expect(await codeOf(getStore(owner, store.id))).toBe('NOT_FOUND');
    expect((await listImportWarnings(owner)).filter((w) => w.batch === loaded.batch.number)).toEqual([]);
    expect(await codeOf(undoImportBatch(owner, loaded.batch.number, 'Again'))).toBe('INVALID_TRANSITION');

    // Once a store of it is re-verified, its history is in an account: the batch stays.
    const second = aFile(product);
    const again = await loadHistoryImport(owner, second, await planHistoryImport(getDb(), second, sellers), second.files);
    const [verified] = await listStores(owner, { search: second.stores[1]?.name });
    const sellerCtx = await ctxFor(seller);
    await reverifyStore(sellerCtx, verified?.id ?? '', {
      name: second.stores[1]?.name ?? '', ownerName: 'Owner', contactNumber: '0501234567',
      location: { lat: SHOP.lat + 5 + Math.random(), lng: SHOP.lng + Math.random() }, creditMode: 'WEEKLY', creditLimit: '1000.00',
      priceListId: await basePriceListId(), storefrontPhotoId: await aPhoto(sellerCtx, 'STOREFRONT'),
      balance: { shown: '100.00', confirmation: 'AGREED' },
    });
    expect(await codeOf(undoImportBatch(owner, again.batch.number, 'Green Agro sent corrected books'))).toBe('INVALID_TRANSITION');
  });
});
