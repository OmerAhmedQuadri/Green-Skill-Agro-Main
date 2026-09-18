import type { DomainError, PermissionCode } from '@gsa/core';
import { readSheet } from 'read-excel-file/node';
import { describe, expect, it } from 'vitest';
import writeXlsxFile from 'write-excel-file/node';
import { ownerQuery } from '../../test/db';
import { anAccount, ctxFor } from '../../test/factories';
import { advance, anOrderInTransit, okraSkus } from '../../test/procurement';
import { createPurchaseOrder } from './index';
import { getSkuStock, listStock, searchLots } from '../inventory';
import { previewReceiptImport, receiptTemplate, receiveGoods, RECEIPT_COLUMNS, type ReceiptColumn } from './receiving';

const code = async (p: Promise<unknown>) => p.then(() => 'NO_ERROR', (e: DomainError) => e.code ?? String(e));
const admin = async () => ctxFor(await anAccount('ADMIN'));
const manager = async (grants: PermissionCode[]) => ctxFor(await anAccount('MANAGER'), { overrides: new Map(grants.map((g) => [g, true])) });
const LABELS = Object.fromEntries(RECEIPT_COLUMNS.map((c) => [c, c.toUpperCase()])) as Record<ReceiptColumn, string>;
type Cell = string | number | Date | null;
const xlsx = async (rows: Cell[][]) => (await writeXlsxFile(rows, { dateFormat: 'yyyy-mm-dd' }).toBuffer()).toString('base64');

describe('goods receipt (RCV-003..008)', () => {
  it('RCV-003, RCV-008, STK-005: each line becomes a batch with its LOT and dates, in the warehouse', async () => {
    const ctx = await admin();
    const { po, bagLine, bag } = await anOrderInTransit(ctx);
    const after = await receiveGoods(ctx, po.id, { version: po.version, lines: [
      { purchaseOrderLineId: bagLine.id, packs: 12, lotNumber: '8251', manufacturedOn: '2026-01-10', expiresOn: '2027-12-31', unitCost: '69.50' },
    ] });
    expect(after.status).toBe('PARTIALLY_RECEIVED');
    const { sku, batches } = await getSkuStock(ctx, bag.id);
    expect(batches).toEqual([expect.objectContaining({ lotNumber: '8251', manufacturedOn: '2026-01-10', expiresOn: '2027-12-31', positions: { warehouse: 12, vehicles: 0, dispatched: 0, total: 12 } })]);
    expect(sku.positions.warehouse).toBe(12);
    expect(after.receipts).toEqual([expect.objectContaining({ source: 'MANUAL', packs: 12 })]);
  });

  it('STK-014: stock is stored in grams and shown as packs', async () => {
    const ctx = await admin();
    const { po, bagLine } = await anOrderInTransit(ctx);
    await receiveGoods(ctx, po.id, { version: po.version, lines: [{ purchaseOrderLineId: bagLine.id, packs: 10, lotNumber: 'G1', manufacturedOn: '2026-01-10' }] });
    const rows = await ownerQuery<{ account_kind: string; quantity: string }>(`select account_kind, quantity from stock_movements order by account_kind`);
    expect(rows).toEqual([{ account_kind: 'WAREHOUSE', quantity: '50000.000' }, { account_kind: 'SUPPLIER', quantity: '-50000.000' }]);
  });

  it('RCV-004: one order line can arrive as several batches', async () => {
    const ctx = await admin();
    const { po, bagLine, bag } = await anOrderInTransit(ctx);
    await receiveGoods(ctx, po.id, { version: po.version, lines: [
      { purchaseOrderLineId: bagLine.id, packs: 8, lotNumber: 'A-1', manufacturedOn: '2026-01-10', expiresOn: '2027-06-30' },
      { purchaseOrderLineId: bagLine.id, packs: 12, lotNumber: 'A-2', manufacturedOn: '2026-02-10', expiresOn: '2027-09-30' },
    ] });
    const { batches } = await getSkuStock(ctx, bag.id);
    expect(batches.map((b) => [b.lotNumber, b.positions.warehouse])).toEqual([['A-1', 8], ['A-2', 12]]); // FEFO order
  });

  it('RCV-005, RCV-006, CAT-017: expiry from a date, a shelf-life period, or the product default', async () => {
    const ctx = await admin();
    const { po, bagLine, pouchLine, bag, pouch } = await anOrderInTransit(ctx);
    await receiveGoods(ctx, po.id, { version: po.version, lines: [
      { purchaseOrderLineId: bagLine.id, packs: 1, lotNumber: 'S1', manufacturedOn: '2026-03-15', shelfLife: { years: 1 } },
      { purchaseOrderLineId: pouchLine.id, packs: 1, lotNumber: 'S2', manufacturedOn: '2026-03-15' }, // Okra's 24 months
    ] });
    expect((await getSkuStock(ctx, bag.id)).batches[0]?.expiresOn).toBe('2027-03-15');
    expect((await getSkuStock(ctx, pouch.id)).batches[0]?.expiresOn).toBe('2028-03-15');
  });

  it('RCV-005: seeds need a LOT and a manufacturing date; the error names the line', async () => {
    const ctx = await admin();
    const { po, bagLine } = await anOrderInTransit(ctx);
    const err = await receiveGoods(ctx, po.id, { version: po.version, lines: [
      { purchaseOrderLineId: bagLine.id, packs: 1, lotNumber: 'OK', manufacturedOn: '2026-01-10' },
      { purchaseOrderLineId: bagLine.id, packs: 1, manufacturedOn: '2026-01-10' },
    ] }).catch((e: DomainError) => e);
    expect(err).toMatchObject({ code: 'ATTRIBUTE_REQUIRED', details: { attribute: 'LOT_NUMBER', line: 1 } });
    const [row] = await ownerQuery<{ n: number }>(`select count(*)::int as n from stock_movements`);
    expect(row?.n).toBe(0); // all or nothing
  });

  it('STK-002: a repeat consignment of one LOT adds to its batch; the same LOT on another product is another batch', async () => {
    const ctx = await admin();
    const a = await anOrderInTransit(ctx);
    const first = await receiveGoods(ctx, a.po.id, { version: a.po.version, lines: [
      { purchaseOrderLineId: a.bagLine.id, packs: 5, lotNumber: '8251', manufacturedOn: '2026-01-10', expiresOn: '2027-01-10' },
      { purchaseOrderLineId: a.pouchLine.id, packs: 5, lotNumber: '8251', manufacturedOn: '2026-01-10', expiresOn: '2027-01-10' },
    ] });
    await receiveGoods(ctx, a.po.id, { version: first.version, lines: [
      { purchaseOrderLineId: a.bagLine.id, packs: 3, lotNumber: '8251', manufacturedOn: '2026-01-10', expiresOn: '2027-01-10' },
    ] });
    expect((await getSkuStock(ctx, a.bag.id)).batches.map((b) => b.positions.warehouse)).toEqual([8]);
    const [row] = await ownerQuery<{ n: number }>(`select count(*)::int as n from batches where lot_number = '8251'`);
    expect(row?.n).toBe(2);
  });

  it('STK-003: LOT numbers are searchable, across products', async () => {
    const ctx = await admin();
    const { po, bagLine, pouchLine } = await anOrderInTransit(ctx);
    await receiveGoods(ctx, po.id, { version: po.version, lines: [
      { purchaseOrderLineId: bagLine.id, packs: 2, lotNumber: 'LOT-777', manufacturedOn: '2026-01-10' },
      { purchaseOrderLineId: pouchLine.id, packs: 3, lotNumber: 'LOT-777', manufacturedOn: '2026-01-10' },
    ] });
    const found = await searchLots(ctx, 'lot-77');
    expect(found.map((b) => [b.code, b.lotNumber, b.positions.total]).sort()).toEqual([['OKRA-PK-1KG', 'LOT-777', 3], ['OKRA-PK-5KG', 'LOT-777', 2]]);
  });

  it('RCV-007: a short receipt stays open for the balance; the variance is kept per line', async () => {
    const ctx = await admin();
    const { po, bagLine, pouchLine } = await anOrderInTransit(ctx);
    const part = await receiveGoods(ctx, po.id, { version: po.version, lines: [{ purchaseOrderLineId: bagLine.id, packs: 15, lotNumber: 'P1', manufacturedOn: '2026-01-10' }] });
    expect(part.status).toBe('PARTIALLY_RECEIVED');
    expect(part.lines.map((l) => [l.code, l.receivedPacks, l.variance, l.outstandingPacks])).toEqual([['OKRA-PK-1KG', 0, -10, 10], ['OKRA-PK-5KG', 15, -5, 5]]);
    const rest = await receiveGoods(ctx, po.id, { version: part.version, lines: [
      { purchaseOrderLineId: bagLine.id, packs: 6, lotNumber: 'P2', manufacturedOn: '2026-02-10' }, // one more than ordered
      { purchaseOrderLineId: pouchLine.id, packs: 10, lotNumber: 'P2', manufacturedOn: '2026-02-10' },
    ] });
    expect(rest).toMatchObject({ status: 'CLOSED', closeReason: 'COMPLETE' });
    expect(rest.lines.find((l) => l.code === 'OKRA-PK-5KG')).toMatchObject({ receivedPacks: 21, variance: 1, outstandingPacks: 0 });
  });

  it('RCV-003: goods can arrive before the despatch is recorded, never before the order is placed', async () => {
    const ctx = await admin();
    const okra = await okraSkus(ctx);
    const draft = await createPurchaseOrder(ctx, { vendorId: okra.vendor.id, lines: [{ skuId: okra.bag.id, orderedPacks: 2, expectedUnitCost: '70' }] });
    const line = draft.lines[0];
    if (!line) throw new Error('no line');
    const receive = (po: typeof draft) => receiveGoods(ctx, po.id, { version: po.version, lines: [{ purchaseOrderLineId: line.id, packs: 2, lotNumber: 'E1', manufacturedOn: '2026-01-10' }] });
    expect(await code(receive(draft))).toBe('PO_NOT_RECEIVABLE');
    const placed = await advance(ctx, draft, ['submit', 'approve', 'place']);
    expect((await receive(placed)).status).toBe('CLOSED');
  });

  it('RCV-003: receiving needs inventory.receive_goods; a stale version is refused', async () => {
    const ctx = await admin();
    const { po, bagLine } = await anOrderInTransit(ctx);
    const line = [{ purchaseOrderLineId: bagLine.id, packs: 1, lotNumber: 'R', manufacturedOn: '2026-01-10' }];
    expect(await code(receiveGoods(await manager(['procurement.view']), po.id, { version: po.version, lines: line }))).toBe('FORBIDDEN');
    expect(await code(receiveGoods(await manager(['inventory.receive_goods']), po.id, { version: po.version, lines: line }))).toBe('NO_ERROR');
    expect(await code(receiveGoods(ctx, po.id, { version: po.version, lines: line }))).toBe('VERSION_CONFLICT');
  });

  it('STK-004, STK-008: total stock is every unit held; the warehouse is a first-class location', async () => {
    const ctx = await admin();
    const { po, bagLine, bag } = await anOrderInTransit(ctx);
    await receiveGoods(ctx, po.id, { version: po.version, lines: [{ purchaseOrderLineId: bagLine.id, packs: 4, lotNumber: 'T', manufacturedOn: '2026-01-10' }] });
    const stock = (await listStock(ctx, { skuId: bag.id })).items[0];
    expect(stock).toMatchObject({ positions: { warehouse: 4, total: 4 }, incoming: { inTransit: 16 } });
    const [row] = await ownerQuery<{ warehouse_id: string | null }>(`select warehouse_id from stock_movements where account_kind = 'WAREHOUSE'`);
    expect(row?.warehouse_id).toBe(po.warehouseId);
    expect(await code(listStock(await manager(['catalogue.view'])))).toBe('FORBIDDEN');
  });
});

describe('bulk import (RCV-001, RCV-002)', () => {
  it('RCV-001: the template lists the order\'s outstanding lines, ready to fill in', async () => {
    const ctx = await admin();
    const { po } = await anOrderInTransit(ctx);
    const template = await receiptTemplate(ctx, po.id, LABELS);
    expect(template.fileName).toBe(`${po.number}-receipt.xlsx`);
    const rows = await readSheet(template.content);
    expect(rows[0]).toEqual(RECEIPT_COLUMNS.map((c) => c.toUpperCase()));
    expect(rows.slice(1).map((r) => [r[0], r[2], r[6], r[7]])).toEqual([['OKRA-PK-1KG', 10, 24, '16.50'], ['OKRA-PK-5KG', 20, 24, '70.00']]);
  });

  it('RCV-002: every row is validated and previewed with its error; nothing is written', async () => {
    const ctx = await admin();
    const { po } = await anOrderInTransit(ctx);
    const content = await xlsx([
      RECEIPT_COLUMNS.map((c) => c),
      ['OKRA-PK-5KG', 'Okra', 20, 8251, new Date(Date.UTC(2026, 0, 10)), new Date(Date.UTC(2027, 11, 31)), null, '69.5'],
      ['okra-pk-1kg', 'Okra', 10, 'L-9', '2026-01-10', null, 12, null],
      ['OKRA-PK-1KG', 'Okra', 2, null, '2026-01-10', null, null, null], // no LOT
      ['NOPE-1', 'x', 1, 'L', '2026-01-10', null, null, null],
      ['OKRA-PK-5KG', 'Okra', 1, 'L', '2026-02-30', null, null, null],
      [null, null, null, null, null, null, null, null],
    ]);
    const preview = await previewReceiptImport(ctx, po.id, { fileName: 'arrival.xlsx', content });
    expect(preview).toMatchObject({ valid: 2, invalid: 3 });
    expect(preview.rows.map((r) => [r.row, r.error?.code ?? null, r.error?.field ?? null])).toEqual([
      [2, null, null], [3, null, null], [4, 'ATTRIBUTE_REQUIRED', 'lotNumber'], [5, 'SKU_NOT_ON_ORDER', 'sku'], [6, 'INVALID_DATE', 'manufacturedOn'],
    ]);
    expect(preview.rows[0]?.input).toMatchObject({ lotNumber: '8251', manufacturedOn: '2026-01-10', expiresOn: '2027-12-31', unitCost: '69.5' });
    const [row] = await ownerQuery<{ n: number }>(`select count(*)::int as n from batches`);
    expect(row?.n).toBe(0);
  });

  it('RCV-002: confirmed rows are committed as one import receipt', async () => {
    const ctx = await admin();
    const { po } = await anOrderInTransit(ctx);
    const content = await xlsx([
      RECEIPT_COLUMNS.map((c) => c),
      ['OKRA-PK-5KG', '', 20, 'B-1', '2026-01-10', null, null, null],
      ['OKRA-PK-1KG', '', 10, 'B-1', '2026-01-10', null, null, null],
    ]);
    const preview = await previewReceiptImport(ctx, po.id, { fileName: 'arrival.xlsx', content });
    const lines = preview.rows.flatMap((r) => (r.input && !r.error ? [r.input] : []));
    const importer = await manager(['inventory.bulk_import', 'procurement.view']);
    const done = await receiveGoods(importer, po.id, { version: po.version, source: 'IMPORT', fileName: preview.fileName, lines });
    expect(done).toMatchObject({ status: 'CLOSED', closeReason: 'COMPLETE' });
    expect(done.receipts).toEqual([expect.objectContaining({ source: 'IMPORT', fileName: 'arrival.xlsx', packs: 30 })]);
  });

  it('RCV-001: importing needs inventory.bulk_import; an unreadable file is refused', async () => {
    const ctx = await admin();
    const { po } = await anOrderInTransit(ctx);
    expect(await code(previewReceiptImport(await manager(['inventory.receive_goods']), po.id, { fileName: 'x.xlsx', content: 'AAAA' }))).toBe('FORBIDDEN');
    expect(await code(previewReceiptImport(ctx, po.id, { fileName: 'x.xlsx', content: Buffer.from('not a spreadsheet').toString('base64') }))).toBe('INVALID_IMPORT_FILE');
  });
});
