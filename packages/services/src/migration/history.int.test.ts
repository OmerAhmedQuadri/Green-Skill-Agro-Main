import { schema } from '@gsa/db';
import { count, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { anAccount, ctxFor } from '../../test/factories';
import { aSellingSeller } from '../../test/sales';
import type { Ctx } from '../context';
import { inTx } from '../platform';
import { getDb } from '../runtime';
import { openImportBatch, recordImportedPayment, recordImportedSale, type ImportFile } from './history';

/** Synthetic throughout: client data never enters the repository, tests included (CLIENT-DATA.md). */
const pgCode = async (p: Promise<unknown>) =>
  p.then(() => 'NO_ERROR', (e: { message?: string; cause?: { code?: string } }) => e.cause?.code ?? e.message ?? 'UNKNOWN');
const FILES: ImportFile[] = [
  { name: 'Seller A Invoices.xlsx', sha256: 'a'.repeat(64), bytes: 53_861 },
  { name: 'Seller A Vouchers.xlsx', sha256: 'b'.repeat(64), bytes: 12_240 },
];
const BOOK = 'Seller A Invoices.xlsx';

async function setup() {
  const admin = await ctxFor(await anAccount('SUPER_ADMIN'));
  const selling = await aSellingSeller(admin);
  return { admin, store: selling.store, seller: selling.seller.account, sku: selling.bag };
}
const batch = (ctx: Ctx, files = FILES) => inTx(ctx, (tx) => openImportBatch(tx, ctx, { files }));
const totals = async () => {
  const db = getDb();
  const [[ledger], [pays], [cash], [stock]] = await Promise.all([
    db.select({ n: count() }).from(schema.storeLedgerEntries), db.select({ n: count() }).from(schema.payments),
    db.select({ n: count() }).from(schema.cashLedgerEntries), db.select({ n: count() }).from(schema.stockMovements),
  ]);
  return { ledger: ledger?.n, payments: pays?.n, cash: cash?.n, stock: stock?.n };
};

describe("imported history: Green Agro's books, recorded as written (ADR-0059)", () => {
  it('IMP-004: a batch keeps the files it was read from, with their checksums, numbered in order and audited', async () => {
    const { admin } = await setup();
    const first = await batch(admin);
    const second = await batch(admin, [FILES[0] as ImportFile]);
    expect(second.number).toBeGreaterThan(first.number);
    const [row] = await getDb().select().from(schema.importBatches).where(eq(schema.importBatches.id, first.id));
    expect(row).toMatchObject({ status: 'LOADED', files: FILES, createdBy: admin.user.id, undoneAt: null });
    const [entry] = await getDb().select().from(schema.auditLog).where(eq(schema.auditLog.entityId, first.id));
    expect(entry).toMatchObject({ action: 'migration.import_batch_opened', actorId: admin.user.id });
    // Undone means undone by someone, when, and why — all three or none.
    expect(await pgCode(getDb().execute(sql`update import_batches set status = 'UNDONE' where id = ${first.id}`))).toBe('23514');
    // A batch without its files cannot be told apart from another.
    await expect(batch(admin, [])).rejects.toThrow('files it was read from');
    await expect(batch(admin, [{ name: 'x.xlsx', sha256: 'not a hash', bytes: 1 }])).rejects.toThrow('SHA-256');
  });

  it('IMP-001: an invoice is kept with its lines as written — the amount charged even where packs × price differ', async () => {
    const { admin, store, seller, sku } = await setup();
    const { id: batchId } = await batch(admin);
    const sale = await inTx(admin, (tx) => recordImportedSale(tx, admin, batchId, {
      storeId: store.id, sellerId: seller.id, soldOn: '2026-07-11', book: BOOK, bookRow: 215, serial: 39, storeNameWritten: 'A Store - Town',
      discount: '3.50',
      lines: [
        { item: 'Bottle Gourd F1', pack: '200g', skuId: sku.id, packs: '5', unitPrice: '45.00', amount: '585.00' },
        { item: 'A seed nobody stocks', pack: '8 g', packs: '10', unitPrice: '30.00', amount: '300.00' },
      ],
    }));
    expect(sale).toMatchObject({ subtotal: '885.00', total: '881.50' });
    const [head] = await getDb().select().from(schema.importedSales).where(eq(schema.importedSales.id, sale.id));
    expect(head).toMatchObject({
      batchId, storeId: store.id, sellerId: seller.id, soldOn: '2026-07-11', book: BOOK, bookRow: 215, serial: 39,
      storeNameWritten: 'A Store - Town', subtotal: '885.00', discount: '3.50', total: '881.50',
    });
    const lines = await getDb().select().from(schema.importedSaleLines).where(eq(schema.importedSaleLines.importedSaleId, sale.id))
      .orderBy(schema.importedSaleLines.lineNo);
    expect(lines.map((l) => [l.lineNo, l.itemWritten, l.packWritten, l.skuId, l.packs, l.unitPrice, l.amount])).toEqual([
      [1, 'Bottle Gourd F1', '200g', sku.id, '5.000', '45.00', '585.00'],
      [2, 'A seed nobody stocks', '8 g', null, '10.000', '30.00', '300.00'],
    ]);
    // An invoice is recorded once per book; the same serial in a later batch is that batch's own record.
    const again = { storeId: store.id, sellerId: seller.id, soldOn: '2026-07-11', book: BOOK, bookRow: 215, serial: 39,
      storeNameWritten: 'A Store', lines: [{ item: 'Okra', packs: '1', unitPrice: '90.00', amount: '90.00' }] };
    expect(await pgCode(inTx(admin, (tx) => recordImportedSale(tx, admin, batchId, again)))).toBe('23505');
    const { id: later } = await batch(admin);
    expect((await inTx(admin, (tx) => recordImportedSale(tx, admin, later, again))).total).toBe('90.00');
    // The database holds the figures too: a total is the lines less the discount.
    expect(await pgCode(getDb().execute(sql`insert into imported_sales
      (id, batch_id, store_id, seller_id, sold_on, book, book_row, serial, store_name_written, subtotal, discount, total, branch_id, created_by)
      values (gen_random_uuid(), ${batchId}, ${store.id}, ${seller.id}, '2026-07-12', ${BOOK}, 300, 40, 'A Store', 100, 0, 90,
        ${admin.branchId}, ${admin.user.id})`))).toBe('23514');
  });

  it('IMP-002: a voucher, a voucher with no number, money paid at a sale, and a payment nobody could place', async () => {
    const { admin, store, seller } = await setup();
    const { id: batchId } = await batch(admin);
    const written = { book: 'Seller A Vouchers.xlsx', storeNameWritten: 'A Store', sellerId: seller.id };
    const recorded = await inTx(admin, async (tx) => [
      await recordImportedPayment(tx, admin, batchId, { ...written, bookRow: 2, storeId: store.id, paidOn: '2026-07-20', amount: '1880.00',
        kind: 'VOUCHER', method: 'CASH', voucherNumber: ' 186 ' }),
      await recordImportedPayment(tx, admin, batchId, { ...written, bookRow: 3, storeId: store.id, paidOn: '2026-02-20', amount: '2976.15',
        kind: 'VOUCHER', method: 'BANK_TRANSFER' }),
      await recordImportedPayment(tx, admin, batchId, { ...written, book: BOOK, bookRow: 108, storeId: store.id, paidOn: '2025-12-11',
        amount: '2500.00', kind: 'PAID_AT_SALE', method: 'CASH', invoiceSerial: 1, voucherNumber: '999' }),
      await recordImportedPayment(tx, admin, batchId, { ...written, bookRow: 4, storeId: null, paidOn: '2026-08-11', amount: '300.00',
        kind: 'VOUCHER', method: 'CASH', voucherNumber: '198' }),
    ]);
    const rows = await getDb().select().from(schema.importedPayments).where(eq(schema.importedPayments.batchId, batchId))
      .orderBy(schema.importedPayments.bookRow);
    expect(rows.map((r) => [r.kind, r.voucherNumber, r.invoiceSerial, r.amount, r.storeId])).toEqual([
      ['VOUCHER', '186', null, '1880.00', store.id],
      ['VOUCHER', null, null, '2976.15', store.id],
      ['VOUCHER', '198', null, '300.00', null],
      ['PAID_AT_SALE', null, 1, '2500.00', store.id],     // no voucher number on money paid at a sale
    ]);
    expect(recorded).toHaveLength(4);
    // A voucher number is used once in a book.
    expect(await pgCode(inTx(admin, (tx) => recordImportedPayment(tx, admin, batchId, {
      ...written, bookRow: 9, storeId: store.id, paidOn: '2026-07-21', amount: '10.00', kind: 'VOUCHER', method: 'CASH', voucherNumber: '186',
    })))).toBe('23505');
    await expect(inTx(admin, (tx) => recordImportedPayment(tx, admin, batchId, {
      ...written, bookRow: 10, storeId: store.id, paidOn: '2026-07-21', amount: '0', kind: 'VOUCHER', method: 'CASH',
    }))).rejects.toMatchObject({ code: 'INVALID_MONEY' });
    await expect(inTx(admin, (tx) => recordImportedPayment(tx, admin, batchId, {
      ...written, bookRow: 11, storeId: store.id, paidOn: '2026-07-21', amount: '10.00', kind: 'PAID_AT_SALE', method: 'CASH',
    }))).rejects.toThrow('names no invoice');
  });

  it('IMP-003, IMP-006: recorded history is never changed in place, and touches no account, stock or cash', async () => {
    const { admin, store, seller } = await setup();
    const before = await totals();
    const { id: batchId } = await batch(admin);
    const sale = await inTx(admin, (tx) => recordImportedSale(tx, admin, batchId, {
      storeId: store.id, sellerId: seller.id, soldOn: '2026-05-16', book: BOOK, bookRow: 15, serial: 3, storeNameWritten: 'A Store',
      lines: [{ item: 'Sweetcorn F1', pack: '50g', packs: '5', unitPrice: '20.00', amount: '100.00' }],
    }));
    const pay = await inTx(admin, (tx) => recordImportedPayment(tx, admin, batchId, {
      book: 'Seller A Vouchers.xlsx', bookRow: 4, storeNameWritten: 'A Store', storeId: store.id, sellerId: seller.id,
      paidOn: '2026-05-16', amount: '100.00', kind: 'VOUCHER', method: 'CASH', voucherNumber: '153',
    }));
    // IMP-006: recording posts nothing; the store's account, its payments, cash in hand and stock are as they were.
    expect(await totals()).toEqual(before);
    // IMP-003: what the books say is kept as recorded (SQLSTATE 42501: the app may not change or remove it).
    for (const statement of [
      sql`update imported_sales set total = 1 where id = ${sale.id}`, sql`delete from imported_sales where id = ${sale.id}`,
      sql`update imported_sale_lines set amount = 1 where imported_sale_id = ${sale.id}`, sql`delete from imported_sale_lines where imported_sale_id = ${sale.id}`,
      sql`update imported_payments set amount = 1 where id = ${pay.id}`, sql`delete from imported_payments where id = ${pay.id}`,
    ]) expect(await pgCode(getDb().execute(statement))).toBe('42501');
    // IMP-003: an entry that says it was imported must name its batch, and an app entry must not.
    const debit = (origin: string, batch: string | null) => getDb().execute(sql`insert into store_ledger_entries
      (id, store_id, occurred_at, entry_type, amount, due_on, reference_type, reference_id, origin, import_batch_id, branch_id, created_by)
      values (gen_random_uuid(), ${store.id}, now(), 'SALE', 100, '2026-06-30', 'IMPORTED_SALE', ${sale.id}, ${origin}, ${batch},
        ${admin.branchId}, ${admin.user.id})`);
    expect(await pgCode(debit('IMPORT', null))).toBe('23514');
    expect(await pgCode(debit('APP', batchId))).toBe('23514');
    // IMP-005: an imported record goes into the account once.
    expect(await pgCode(debit('IMPORT', batchId))).toBe('NO_ERROR');
    expect(await pgCode(debit('IMPORT', batchId))).toBe('23505');
    // IMP-003: a payment posted from the books names the imported payment it came from.
    expect(await pgCode(getDb().execute(sql`insert into payments
      (id, number, store_id, amount, method, received_at, received_by, origin, import_batch_id, branch_id)
      values (gen_random_uuid(), 'PM-TEST-1', null, 100, 'CASH', now(), ${seller.id}, 'IMPORT', ${batchId}, ${admin.branchId})`))).toBe('23514');
  });
});
