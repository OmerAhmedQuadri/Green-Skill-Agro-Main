import type { DomainError } from '@gsa/core';
import { describe, expect, it } from 'vitest';
import { anAccount, ctxFor, PASSWORD } from '../../test/factories';
import { aPhoto } from '../../test/media';
import { aPdfRenderer, aSellingSeller, paid } from '../../test/sales';
import { aStore, basePriceListId, SHOP } from '../../test/stores';
import { YARD } from '../../test/vehicles';
import { cashInHand } from '../cash';
import type { Ctx } from '../context';
import { openImportBatch, recordImportedSale, recordImportedStore } from '../migration';
import { inTx } from '../platform';
import { recordReturn } from '../returns';
import { getDb } from '../runtime';
import { getSale, listSales, openSaleOptions, recordOpenSale, recordSale, renderPendingDocuments } from '../sales';
import { decideStore, getCreditStatus, importedHistory, listStoreLedger, reverifyStore, type LedgerEntry } from '../stores';
import { openCorrectionSession } from './sessions';
import {
  correctImportedSale, correctSale, listImportedSales, listSaleCorrections, previewImportedSaleCorrection, previewSaleCorrection,
} from './sales';
import { correctStoreEntry } from './store-account';

/** Synthetic throughout: client data never enters the repository, tests included (CLIENT-DATA.md). */
const codeOf = async (p: Promise<unknown>) => p.then(() => 'NO_ERROR', (e: DomainError) => e.code ?? String(e));
const REASON = 'The seller wrote 4 packs; the store took 3';
const ALL = { stock: true, document: true, account: true, cashInHand: true };

/** A Super Admin, and a seller at work with ten bags of okra (90.00 each) and an approved weekly store. */
async function setup() {
  const owner = await ctxFor(await anAccount('SUPER_ADMIN'));
  const selling = await aSellingSeller(owner);
  const open = () => openCorrectionSession(owner, { password: PASSWORD, reason: 'Fixing October\'s sales' });
  const onVehicle = async () => (await openSaleOptions(selling.seller.ctx)).items.find((i) => i.skuId === selling.bag.id)?.sellablePacks ?? 0;
  const sell = (packs: number, storeId = selling.store.id) => recordSale(selling.seller.ctx, { storeId, lines: [{ skuId: selling.bag.id, packs }] });
  return { owner, ...selling, open, onVehicle, sell };
}
const owed = async (ctx: Ctx, storeId: string) => (await getCreditStatus(ctx, storeId)).outstanding;
const billsOf = (rows: LedgerEntry[]) => rows.filter((e) => e.entryType === 'SALE' || (e.entryType === 'ADJUSTMENT' && e.reference.type === 'CORRECTION_REVERSAL'));

describe('sale corrections: the sale corrected, what follows chosen (COR-006, ADR-0059)', () => {
  it('COR-006, COR-002: fewer packs — stock back on the vehicle, the bill corrected, the document reissued as version 2; shown before it is done', async () => {
    const { owner, seller, store, open, onVehicle, sell } = await setup();
    const sale = await sell(4);
    await renderPendingDocuments(aPdfRenderer(), new Date());
    const line = sale.lines[0];
    if (!line) throw new Error('no line');
    const change = { lines: [{ lineId: line.id, packs: 3 }], reason: REASON, ...ALL };
    expect(await codeOf(correctSale(owner, sale.id, change))).toBe('NO_CORRECTION_SESSION');
    await open();

    const preview = await previewSaleCorrection(owner, sale.id, change);
    expect(preview).toMatchObject({
      available: { stock: true, document: true, account: true, cashInHand: false }, total: { before: '360.00', after: '270.00' },
      stock: [{ code: 'OKRA-PK-5KG', packs: 1 }], document: { version: 2 },
      stores: [{ id: store.id, owed: { before: '360.00', after: '270.00' } }], cashInHand: null,
    });
    expect((await getSale(owner, sale.id)).total).toBe('360.00'); // a preview changes nothing
    expect(await onVehicle()).toBe(6);

    const done = await correctSale(owner, sale.id, change);
    expect(done.effect).toMatchObject({ total: { after: '270.00' }, document: { version: 2 } });
    const corrected = await getSale(seller.ctx, sale.id);
    expect(corrected).toMatchObject({ total: '270.00', lines: [{ packs: 3, total: '270.00' }], document: { version: 2, status: 'PENDING' } });
    expect(corrected.corrections).toMatchObject([{
      number: done.number, reason: REASON, before: { total: '360.00', lines: [{ lineId: line.id, packs: 4 }] },
      after: { total: '270.00', lines: [{ lineId: line.id, packs: 3 }] }, applied: { stock: true, document: true, account: true, cashInHand: false },
    }]);
    expect(await onVehicle()).toBe(7);
    expect(await owed(owner, store.id)).toBe('270.00');
    expect((await listSales(owner, { storeId: store.id })).items.map((s) => [s.total, s.documentNumber])).toEqual([['270.00', corrected.document?.number]]);

    // The ledger: the sale's bill struck through, its reversal, and the corrected bill — corrected through the sale only.
    const ledger = await listStoreLedger(owner, store.id);
    expect(billsOf(ledger).map((e) => [e.amount, Boolean(e.replacedBy), Boolean(e.reversalOf), e.saleId, e.correctable]).sort((a, b) => Number(b[0]) - Number(a[0]))).toEqual([
      ['360.00', true, false, sale.id, null], ['270.00', false, false, sale.id, null], ['-360.00', false, true, null, null],
    ]);
    const bill = ledger.find((e) => e.amount === '270.00');
    expect(await codeOf(correctStoreEntry(owner, bill?.id ?? '', { amount: '100.00', reason: 'From the account' }))).toBe('CORRECT_THROUGH_SALE');

    // The worker prints the corrected copy under the same number, saying what it replaces.
    const printer = aPdfRenderer();
    expect(await renderPendingDocuments(printer, new Date())).toEqual({ rendered: 1, failed: 0 });
    expect(printer.printed[0]).toContain(`${corrected.document?.number ?? ''} · v2`);
    expect(printer.printed[0]).toContain('Corrected — replaces the copy of');
    expect((await listSaleCorrections(owner)).items[0]).toMatchObject({
      number: done.number, sale: { id: sale.id, documentNumber: corrected.document?.number }, store: { id: store.id }, total: { before: '360.00', after: '270.00' },
    });
  });

  it('COR-006: only what is chosen follows — a price corrected with the account as it was; more packs taken from the vehicle, while it has them', async () => {
    const { owner, store, open, onVehicle, sell } = await setup();
    await open();
    const sale = await sell(2);
    const lineId = sale.lines[0]?.id ?? '';
    await correctSale(owner, sale.id, { lines: [{ lineId, unitPrice: '80' }], reason: 'Agreed at 80 a bag' });
    expect((await getSale(owner, sale.id))).toMatchObject({ total: '160.00', document: { version: 1 }, corrections: [{ applied: { stock: false, document: false, account: false } }] });
    expect(await owed(owner, store.id)).toBe('180.00');

    await correctSale(owner, sale.id, { lines: [{ lineId, packs: 5 }], reason: 'Three more bags were given', stock: true });
    expect(await onVehicle()).toBe(5);
    expect(await codeOf(correctSale(owner, sale.id, { lines: [{ lineId, packs: 11 }], reason: 'More than the vehicle has', stock: true }))).toBe('INSUFFICIENT_STOCK');
    // Not chosen, nothing moves: the vehicle's count is someone else's to correct.
    await correctSale(owner, sale.id, { lines: [{ lineId, packs: 11 }], reason: 'As the store counted' });
    expect(await onVehicle()).toBe(5);
  });

  it('COR-006: moved to another store, its bill goes with it; removed whole, the sale leaves every total', async () => {
    const { owner, seller, store, open, onVehicle, sell } = await setup();
    const created = await aStore(seller.ctx, { creditMode: 'MONTHLY' });
    const other = await decideStore(owner, created.id, 'approve', { version: created.version });
    await open();
    const sale = await sell(2);
    await correctSale(owner, sale.id, { storeId: other.id, reason: 'Sold to the shop next door', account: false });
    expect(await owed(owner, store.id)).toBe('0.00');
    expect(await owed(owner, other.id)).toBe('180.00');
    expect((await getSale(owner, sale.id)).store?.id).toBe(other.id);

    await correctSale(owner, sale.id, { remove: true, reason: 'Entered twice', stock: true, account: true });
    expect(await getSale(owner, sale.id)).toMatchObject({ status: 'REMOVED', total: '180.00' });
    expect(await owed(owner, other.id)).toBe('0.00');
    expect(await onVehicle()).toBe(10);
    expect(await codeOf(correctSale(owner, sale.id, { lines: [{ lineId: sale.lines[0]?.id ?? '', packs: 1 }], reason: 'Again' }))).toBe('NOT_CORRECTABLE');
  });

  it('COR-006, RET-002: what the store returned stays returned', async () => {
    const { owner, seller, open, sell } = await setup();
    await open();
    const sale = await sell(3);
    const line = sale.lines[0];
    await recordReturn(seller.ctx, {
      saleId: sale.id, kind: 'CREDIT_NOTE', condition: 'UNCLEARED_PAYMENT', lines: [{ saleLineId: line?.id ?? '', batchId: line?.batches[0]?.batchId ?? '', packs: 1 }],
    });
    expect(await codeOf(correctSale(owner, sale.id, { lines: [{ lineId: line?.id ?? '', packs: 0 }], reason: 'None were sold' }))).toBe('EMPTY_SALE');
    expect(await codeOf(correctSale(owner, sale.id, { remove: true, reason: 'Never happened' }))).toBe('SALE_HAS_RETURNS');
    await correctSale(owner, sale.id, { lines: [{ lineId: line?.id ?? '', packs: 2 }], reason: 'Two were sold', stock: true });
    expect((await getSale(owner, sale.id)).lines[0]?.packs).toBe(2);
  });

  it('COR-006: an open sale paid in cash — its seller\'s cash in hand follows when chosen', async () => {
    const { owner, seller, store, bag, open } = await setup(); // open sales are on by default
    const sale = await recordOpenSale(seller.ctx, {
      lines: [{ skuId: bag.id, packs: 2 }], location: { lat: YARD.lat + 0.01, lng: YARD.lng, accuracyM: 12 }, payment: await paid(seller.ctx, '180.00'),
    });
    expect(await cashInHand(getDb(), seller.account.id)).toBe('180.00');
    await open();
    const preview = await previewSaleCorrection(owner, sale.id, { lines: [{ lineId: sale.lines[0]?.id ?? '', packs: 1 }], reason: 'One bag', cashInHand: true });
    expect(preview.available).toEqual({ stock: true, document: true, account: false, cashInHand: true });
    expect(preview.cashInHand).toMatchObject({ seller: { id: seller.account.id }, before: '180.00', after: '90.00' });
    await correctSale(owner, sale.id, { lines: [{ lineId: sale.lines[0]?.id ?? '', packs: 1 }], reason: 'One bag', cashInHand: true });
    expect(await cashInHand(getDb(), seller.account.id)).toBe('90.00');
    // An open sale has no store to move from.
    expect(await codeOf(correctSale(owner, sale.id, { storeId: store.id, reason: 'To a store' }))).toBe('NOT_CORRECTABLE');
  });
});

describe('imported sale corrections (COR-006)', () => {
  /** A store imported from a seller's books with one invoice of two lines, 700.00. */
  async function anImportedInvoice() {
    const owner = await ctxFor(await anAccount('SUPER_ADMIN'));
    const sellerAccount = await anAccount('SELLER');
    const seller = await ctxFor(sellerAccount);
    const made = await inTx(owner, async (tx) => {
      const batch = await openImportBatch(tx, owner, { files: [{ name: 'Seller A Invoices.xlsx', sha256: 'c'.repeat(64), bytes: 100 }] });
      const store = await recordImportedStore(tx, owner, batch.id, { name: 'Imported Store', sellerId: sellerAccount.id });
      const sale = await recordImportedSale(tx, owner, batch.id, {
        storeId: store.id, sellerId: sellerAccount.id, book: 'Seller A Invoices.xlsx', storeNameWritten: 'Imported Store', soldOn: '2026-09-10', bookRow: 20, serial: 101,
        lines: [{ item: 'Okra', packs: '10', unitPrice: '50.00', amount: '500.00' }, { item: 'Beans', packs: '2', unitPrice: '100.00', amount: '200.00' }],
      });
      return { store, sale };
    });
    await openCorrectionSession(owner, { password: PASSWORD, reason: 'Fixing the September books' });
    const reverify = async (shown: string) => reverifyStore(seller, made.store.id, {
      name: 'Imported Store', ownerName: 'Owner', contactNumber: '0501234567', location: { lat: SHOP.lat + 5, lng: SHOP.lng + 2 },
      creditMode: 'WEEKLY', creditLimit: '5000.00', priceListId: await basePriceListId(), storefrontPhotoId: await aPhoto(seller, 'STOREFRONT'),
      balance: { shown, confirmation: 'AGREED' },
    });
    return { owner, seller, ...made, reverify };
  }
  const lines = (okraPacks: string) => [{ item: 'Okra', packs: okraPacks, unitPrice: '50' }, { item: 'Beans', packs: '2', unitPrice: '100' }];

  it('COR-006: corrected before re-verification — the store is shown, and posted, the corrected invoice', async () => {
    const { owner, seller, store, sale, reverify } = await anImportedInvoice();
    expect(await previewImportedSaleCorrection(owner, sale.id, { lines: lines('8'), reason: 'Eight bags, per the copy' }))
      .toEqual({ total: { before: '700.00', after: '600.00' }, posted: false, stores: [] });
    await correctImportedSale(owner, sale.id, { lines: lines('8'), reason: 'Eight bags, per the copy' });
    expect(await codeOf(correctImportedSale(owner, sale.id, { lines: lines('7'), reason: 'Again' }))).toBe('ALREADY_CORRECTED');
    const [current] = await listImportedSales(owner, store.id);
    expect(current).toMatchObject({ serial: 101, total: '600.00', posted: false, lines: [{ item: 'Okra', packs: '8.000', amount: '400.00' }, { item: 'Beans' }] });
    expect((await importedHistory(seller, store.id)).billed).toBe('600.00');
    await reverify('600.00');
    expect((await listStoreLedger(owner, store.id)).map((e) => [e.amount, e.reference.id])).toEqual([['600.00', current?.id]]);
  });

  it('COR-006: corrected after re-verification — its bill in the account follows, and is never posted twice', async () => {
    const { owner, seller, store, sale, reverify } = await anImportedInvoice();
    await reverify('700.00');
    const effect = await correctImportedSale(owner, sale.id, { lines: lines('9'), reason: 'Nine bags' });
    expect(effect.effect).toMatchObject({ total: { before: '700.00', after: '650.00' }, posted: true, stores: [{ owed: { before: '700.00', after: '650.00' } }] });
    expect(await owed(owner, store.id)).toBe('650.00');
    const [current] = await listImportedSales(owner, store.id);
    await correctImportedSale(owner, current?.id ?? '', { lines: lines('10'), reason: 'Ten after all' });
    expect(await owed(owner, store.id)).toBe('700.00');
    expect((await importedHistory(seller, store.id)).sales).toEqual([]);
    expect((await listSaleCorrections(owner)).items.map((c) => [c.imported?.serial, c.total.before, c.total.after, c.applied.account])).toEqual([
      [101, '650.00', '700.00', true], [101, '700.00', '650.00', true],
    ]);
  });
});
