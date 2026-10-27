import { addMonths, businessDate, businessDayStart, type DomainError } from '@gsa/core';
import { describe, expect, it } from 'vitest';
import { ownerQuery } from '../../test/db';
import { anAccount, ctxFor, PASSWORD } from '../../test/factories';
import { aPhoto } from '../../test/media';
import { aPdfRenderer, aSellingSeller, aVoucher } from '../../test/sales';
import { basePriceListId, SHOP } from '../../test/stores';
import { correctStoreEntry, openCorrectionSession } from '../corrections';
import { purgeMedia, requestUpload } from '../media';
import { openImportBatch, recordImportedPayment, recordImportedSale, recordImportedStore } from '../migration';
import { inTx } from '../platform';
import { recordSale } from '../sales';
import {
  adjustBalance, listStoreLedger, listStoreStatements, recordPayment, renderPendingStatements, requestStoreStatement, reverifyStore, storeStatementPdf,
} from './index';

/** Synthetic throughout: client data never enters the repository, tests included (CLIENT-DATA.md). */
const codeOf = async (p: Promise<unknown>) => p.then(() => 'NO_ERROR', (e: DomainError) => e.code ?? String(e));
const runOn = (day: string) => new Date(businessDayStart(day).getTime() + 4 * 3_600_000);

describe('the store statement (IMP-010, ADR-0059)', () => {
  it('IMP-010: asked for from the store, numbered at once, printed by the worker as the account stood then — for whoever may see the store', async () => {
    const owner = await ctxFor(await anAccount('SUPER_ADMIN'));
    const { seller, store, bag } = await aSellingSeller(owner);
    const sale = await recordSale(seller.ctx, { storeId: store.id, lines: [{ skuId: bag.id, packs: 2 }] });
    const voucher = await aVoucher(seller.ctx);
    await recordPayment(seller.ctx, { storeId: store.id, amount: '50.00', method: 'CASH', voucher });

    const asked = await requestStoreStatement(await ctxFor(seller.account), store.id);
    expect(asked).toMatchObject({ number: `ST-${new Date().getFullYear()}-0001`, status: 'PENDING', deleted: false });
    // Paid after it was asked for: not on it.
    await recordPayment(seller.ctx, { storeId: store.id, amount: '30.00', method: 'CASH', voucher: await aVoucher(seller.ctx) });
    expect(await codeOf(storeStatementPdf(seller.ctx, store.id, asked.id))).toBe('DOCUMENT_NOT_READY');

    const printer = aPdfRenderer();
    expect(await renderPendingStatements(printer, new Date())).toEqual({ rendered: 1, failed: 0 });
    const html = printer.printed[0] ?? '';
    expect(html).toContain(asked.number);
    expect(html).toContain(store.name);
    expect(html).toContain(sale.document?.number ?? 'a delivery document number');
    expect(html).toContain(`Voucher ${voucher.number.toUpperCase()}`); // as kept (ADR-0047)
    expect(html).toContain('180.00');
    expect(html).toContain('130.00');
    expect(html).not.toContain('100.00'); // what it came to after the later payment
    expect(html).toContain('كشف حساب');

    expect(await listStoreStatements(seller.ctx, store.id)).toMatchObject([{ id: asked.id, status: 'READY', deleted: false }]);
    const kept = await storeStatementPdf(seller.ctx, store.id, asked.id);
    expect(kept.number).toBe(asked.number);
    expect(new TextDecoder().decode(kept.pdf)).toMatch(/^%PDF/);
    expect((await storeStatementPdf(await ctxFor(await anAccount('ADMIN')), store.id, asked.id)).number).toBe(asked.number);
    // Another seller's store does not exist for them.
    const other = await ctxFor(await anAccount('SELLER'));
    expect(await codeOf(requestStoreStatement(other, store.id))).toBe('NOT_FOUND');
    expect(await codeOf(storeStatementPdf(other, store.id, asked.id))).toBe('NOT_FOUND');
  });

  it('IMP-003, COR-002: imported entries are labelled with where they were written; a correction shows beside what it replaced', async () => {
    const owner = await ctxFor(await anAccount('SUPER_ADMIN'));
    const sellerAccount = await anAccount('SELLER');
    const seller = await ctxFor(sellerAccount);
    const imported = await inTx(owner, async (tx) => {
      const batch = await openImportBatch(tx, owner, { files: [{ name: 'Seller A Invoices.xlsx', sha256: 'b'.repeat(64), bytes: 100 }] });
      const created = await recordImportedStore(tx, owner, batch.id, { name: 'Imported Store', sellerId: sellerAccount.id });
      const written = { storeId: created.id, sellerId: sellerAccount.id, book: 'Seller A Invoices.xlsx', storeNameWritten: 'Imported Store - Town' };
      await recordImportedSale(tx, owner, batch.id, { ...written, soldOn: '2026-09-10', bookRow: 20, serial: 101,
        lines: [{ item: 'Okra', packs: '10', unitPrice: '50.00', amount: '500.00' }] });
      await recordImportedPayment(tx, owner, batch.id, { ...written, bookRow: 21, paidOn: '2026-09-20', amount: '300.00',
        kind: 'VOUCHER', method: 'CASH', voucherNumber: '424242' });
      return created;
    });
    // IMP-008: no account until it is re-verified.
    expect(await codeOf(requestStoreStatement(seller, imported.id))).toBe('STORE_NOT_ACTIVE');
    await reverifyStore(seller, imported.id, {
      name: 'Imported Store', ownerName: 'Owner', contactNumber: '0501234567', location: { lat: SHOP.lat + 4, lng: SHOP.lng + 1 },
      creditMode: 'WEEKLY', creditLimit: '5000.00', priceListId: await basePriceListId(), storefrontPhotoId: await aPhoto(seller, 'STOREFRONT'),
      balance: { shown: '200.00', confirmation: 'AGREED' },
    });
    await adjustBalance(owner, imported.id, { amount: '40.00', reason: 'Crates not returned' });
    await openCorrectionSession(owner, { password: PASSWORD, reason: 'Fixing the September books' });
    const adjustment = (await listStoreLedger(owner, imported.id)).find((e) => e.entryType === 'ADJUSTMENT');
    await correctStoreEntry(owner, adjustment?.id ?? '', { amount: '25.00', reason: 'Only five crates were kept' });

    await requestStoreStatement(owner, imported.id);
    const printer = aPdfRenderer();
    await renderPendingStatements(printer, new Date());
    const html = printer.printed[0] ?? '';
    expect(html).toContain('منقول من الدفاتر');
    expect(html).toContain('Seller A Invoices.xlsx · row 20 · #101');
    expect(html).toContain('Voucher 424242');
    expect(html).toMatch(/Replaced by correction \d+: Only five crates were kept/);
    expect(html).toMatch(/Correction \d+: Only five crates were kept \(was 40\.00\)/);
    // Billed 500, paid 300, adjusted 25: the replaced 40 and its reversal count nowhere.
    expect(html).toContain('225.00 SAR');
    expect(html).toContain('25.00 SAR');
  });

  it('IMP-010, ADR-0049: kept as a stored file for its period, never uploaded; one that will not print waits, then stays failed', async () => {
    const owner = await ctxFor(await anAccount('SUPER_ADMIN'));
    const { seller, store } = await aSellingSeller(owner);
    expect(await codeOf(requestUpload(owner, { kind: 'STORE_STATEMENT', contentType: 'application/pdf', byteSize: 10 }))).toBe('FORBIDDEN');

    const asked = await requestStoreStatement(seller.ctx, store.id);
    await renderPendingStatements(aPdfRenderer(), new Date());
    const [file] = await ownerQuery<{ kind: string; created_at: Date }>(
      'select kind, created_at from media_assets where id = (select media_id from store_statements where id = $1)', [asked.id],
    );
    expect(file?.kind).toBe('STORE_STATEMENT');
    const day = businessDate(file?.created_at ?? new Date());
    // Three months by default — other files the seller's day stored go by their own periods.
    await purgeMedia(runOn(addMonths(day, 2)));
    expect((await storeStatementPdf(seller.ctx, store.id, asked.id)).number).toBe(asked.number);
    await purgeMedia(runOn(addMonths(day, 3)));
    expect(await codeOf(storeStatementPdf(seller.ctx, store.id, asked.id))).toBe('FILE_DELETED');
    expect(await listStoreStatements(seller.ctx, store.id)).toMatchObject([{ id: asked.id, status: 'READY', deleted: true }]);

    const broken = aPdfRenderer({ fail: true });
    const stuck = await requestStoreStatement(seller.ctx, store.id);
    expect(await renderPendingStatements(broken, new Date())).toEqual({ rendered: 0, failed: 1 });
    expect(await renderPendingStatements(broken, new Date())).toEqual({ rendered: 0, failed: 0 }); // waits before retrying
    for (let i = 0; i < 6; i += 1) await renderPendingStatements(broken, new Date(Date.now() + (i + 1) * 3_600_000));
    expect((await listStoreStatements(seller.ctx, store.id)).find((s) => s.id === stuck.id)?.status).toBe('FAILED');
  });
});
