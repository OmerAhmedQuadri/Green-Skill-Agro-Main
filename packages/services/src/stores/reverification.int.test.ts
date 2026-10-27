import { initialStoreStatus, type DomainError } from '@gsa/core';
import { schema } from '@gsa/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { anAccount, ctxFor, PASSWORD } from '../../test/factories';
import { aPhoto } from '../../test/media';
import { aVoucher } from '../../test/sales';
import { basePriceListId, SHOP } from '../../test/stores';
import { attachImportedPayment, listUnassignedPayments, openCorrectionSession } from '../corrections';
import type { Ctx } from '../context';
import { openImportBatch, recordImportedPayment, recordImportedSale, recordImportedStore } from '../migration';
import { listMyNotifications } from '../notifications';
import { inTx } from '../platform';
import { collectedBySeller } from '../reports';
import { getDb } from '../runtime';
import { readToggles } from '../system';
import { getCreditStatus, importedHistory, listAwaitingTransfers, listStoreLedger, recordPayment, reverifyStore, type ReverifyInput } from './index';

/** Synthetic throughout: client data never enters the repository, tests included (CLIENT-DATA.md). */
const codeOf = async (p: Promise<unknown>) => p.then(() => 'NO_ERROR', (e: DomainError) => e.code ?? String(e));
const BOOK = 'Seller A Invoices.xlsx';
const VOUCHERS = 'Seller A Vouchers.xlsx';
let n = 0;
const unique = () => `${Date.now() % 1_000_000}${(n += 1)}`;

/**
 * A store imported from a seller's books: two invoices (September and October) and two payments — a voucher in
 * cash and a bank transfer — and a voucher the books placed with no store.
 */
async function anImportedStore() {
  const owner = await ctxFor(await anAccount('SUPER_ADMIN'));
  const sellerAccount = await anAccount('SELLER');
  const seller = await ctxFor(sellerAccount);
  const voucher = { cash: `9${unique()}`, transfer: `8${unique()}`, loose: `7${unique()}` };
  const imported = await inTx(owner, async (tx) => {
    const batch = await openImportBatch(tx, owner, { files: [{ name: BOOK, sha256: 'a'.repeat(64), bytes: 100 }] });
    const store = await recordImportedStore(tx, owner, batch.id, { name: `Imported Store ${unique()}`, sellerId: sellerAccount.id });
    const written = { storeId: store.id, sellerId: sellerAccount.id, book: BOOK, storeNameWritten: 'Imported Store - Town' };
    await recordImportedSale(tx, owner, batch.id, { ...written, soldOn: '2026-09-10', bookRow: 20, serial: 101,
      lines: [{ item: 'Okra', packs: '10', unitPrice: '50.00', amount: '500.00' }] });
    await recordImportedSale(tx, owner, batch.id, { ...written, soldOn: '2026-10-05', bookRow: 31, serial: 117,
      lines: [{ item: 'Okra', packs: '4', unitPrice: '50.00', amount: '200.00' }] });
    await recordImportedPayment(tx, owner, batch.id, { ...written, book: VOUCHERS, bookRow: 5, paidOn: '2026-09-20', amount: '300.00',
      kind: 'VOUCHER', method: 'CASH', voucherNumber: ` 00${voucher.cash} ` });
    await recordImportedPayment(tx, owner, batch.id, { ...written, book: VOUCHERS, bookRow: 6, paidOn: '2026-10-08', amount: '100.00',
      kind: 'VOUCHER', method: 'BANK_TRANSFER', voucherNumber: voucher.transfer });
    const loose = await recordImportedPayment(tx, owner, batch.id, { ...written, storeId: null, book: VOUCHERS, bookRow: 7, paidOn: '2026-10-09',
      amount: '50.00', kind: 'VOUCHER', method: 'CASH', voucherNumber: voucher.loose });
    return { batch, store, loose };
  });
  return { owner, seller, sellerId: sellerAccount.id, voucher, ...imported };
}

const details = async (seller: Ctx, shown: string, confirmation: 'AGREED' | 'DISPUTED' = 'AGREED', disputeNote?: string): Promise<ReverifyInput> => ({
  name: 'Imported Store, as the sign reads', ownerName: 'Owner', contactNumber: '0501234567',
  location: { lat: SHOP.lat + 3 + Math.random(), lng: SHOP.lng + Math.random() }, creditMode: 'WEEKLY', creditLimit: '5000.00',
  priceListId: await basePriceListId(), storefrontPhotoId: await aPhoto(seller, 'STOREFRONT'),
  balance: { shown, confirmation, ...(disputeNote ? { disputeNote } : {}) },
});

describe('imported stores, re-verified by their sellers (ADR-0059)', () => {
  it('IMP-008: an imported store awaits re-verification — no trade, nothing in its account, its books\' balance shown', async () => {
    const { owner, seller, store } = await anImportedStore();
    const credit = await getCreditStatus(seller, store.id);
    expect(credit).toMatchObject({ blocked: true, outstanding: '0.00' });
    expect(credit.reasons).toContainEqual({ code: 'NOT_VERIFIED' });
    expect(await listStoreLedger(owner, store.id)).toEqual([]);
    const history = await importedHistory(seller, store.id);
    expect(history).toMatchObject({ billed: '700.00', paid: '400.00', balance: '300.00' });
    expect(history.sales.map((s) => [s.soldOn, s.serial, s.total])).toEqual([['2026-09-10', 101, '500.00'], ['2026-10-05', 117, '200.00']]);
    expect(history.payments.map((p) => [p.paidOn, p.amount, p.method])).toEqual([['2026-09-20', '300.00', 'CASH'], ['2026-10-08', '100.00', 'BANK_TRANSFER']]);
    // Another seller's store does not exist for them.
    const other = await ctxFor(await anAccount('SELLER'));
    expect(await codeOf(importedHistory(other, store.id))).toBe('NOT_FOUND');
  });

  it('IMP-005, IMP-003: re-verified, its history goes into its account — due by the terms just set, labelled with its source', async () => {
    const { owner, seller, sellerId, store, batch, voucher } = await anImportedStore();
    // The store agreed to what it was shown: a different figure is refused.
    expect(await codeOf(reverifyStore(seller, store.id, await details(seller, '250.00')))).toBe('IMPORTED_BALANCE_CHANGED');
    const verified = await reverifyStore(seller, store.id, await details(seller, '300.00'));
    expect(verified).toMatchObject({
      name: 'Imported Store, as the sign reads', ownerName: 'Owner', creditMode: 'WEEKLY', imported: true,
      status: initialStoreStatus((await readToggles(getDb()))['stores.approval_required']),
      reverification: { importedBalance: '300.00', confirmation: 'AGREED', disputeNote: null },
    });
    const rows = await listStoreLedger(owner, store.id);
    expect(rows.map((e) => [e.entryType, e.amount, e.dueOn, e.origin])).toEqual([
      ['SALE', '500.00', '2026-09-12', 'IMPORT'],       // Thursday the 10th, due the Saturday the week closes
      ['PAYMENT', '-300.00', null, 'IMPORT'],
      ['SALE', '200.00', '2026-10-10', 'IMPORT'],
      ['PAYMENT', '-100.00', null, 'IMPORT'],
    ]);
    expect(rows[0]?.imported).toEqual({ batch: batch.number, book: BOOK, row: 20, serial: 101, voucherNumber: null });
    expect(rows[1]?.imported).toMatchObject({ book: VOUCHERS, row: 5, voucherNumber: `00${voucher.cash}` }); // as written, less its spaces
    // Both payments settle the older bill first (ADR-0036).
    expect(rows.map((e) => e.open)).toEqual(['100.00', null, '200.00', null]);
    expect((await getCreditStatus(owner, store.id)).outstanding).toBe('300.00');
    // Its payments: numbered on their own, the voucher as kept, the transfer naming its voucher; no cash in anyone's hand.
    const posted = await getDb().select().from(schema.payments).where(eq(schema.payments.storeId, store.id)).orderBy(schema.payments.receivedAt);
    expect(posted.map((p) => [p.number.slice(0, 3), p.voucherNumber, p.reference, p.origin, p.importBatchId, p.receivedBy])).toEqual([
      ['PI-', voucher.cash, null, 'IMPORT', batch.id, sellerId],
      ['PI-', voucher.transfer, voucher.transfer, 'IMPORT', batch.id, sellerId],
    ]);
    const cash = await getDb().select().from(schema.cashLedgerEntries).where(eq(schema.cashLedgerEntries.sellerId, sellerId));
    expect(cash).toEqual([]);
    // IMP-006: not the seller's collections, and no transfer to check.
    expect((await collectedBySeller(getDb(), [sellerId], new Date(0), new Date(Date.now() + 86_400_000))).get(sellerId)).toMatchObject({ payments: 0 });
    expect((await listAwaitingTransfers(owner, { limit: 100 })).items.map((t) => t.store?.id)).not.toContain(store.id);
    // Re-verified once.
    expect(await codeOf(reverifyStore(seller, store.id, await details(seller, '0.00')))).toBe('INVALID_TRANSITION');
  });

  it('IMP-008: a disputed balance is flagged for the Super Admin, in the store\'s words', async () => {
    const { owner, seller, store } = await anImportedStore();
    expect(await codeOf(reverifyStore(seller, store.id, await details(seller, '300.00', 'DISPUTED')))).toBe('REASON_REQUIRED');
    const verified = await reverifyStore(seller, store.id, await details(seller, '300.00', 'DISPUTED', 'The owner says he paid 100 more in October'));
    expect(verified.reverification).toMatchObject({ confirmation: 'DISPUTED', disputeNote: 'The owner says he paid 100 more in October' });
    const inbox = await listMyNotifications(owner, { limit: 50 });
    expect(inbox.items.find((i) => i.kind === 'STORE_BALANCE_DISPUTED' && i.params.name === verified.name))
      .toMatchObject({ params: { amount: '300.00', note: 'The owner says he paid 100 more in October' }, link: `/console/stores/${store.id}` });
  });

  it('COR-005, IMP-009: a payment the books placed nowhere is attached in a session — held until re-verification, or posted at once', async () => {
    const { owner, seller, store, loose } = await anImportedStore();
    expect((await listUnassignedPayments(owner)).map((p) => p.id)).toContain(loose.id);
    expect(await codeOf(attachImportedPayment(owner, loose.id, { storeId: store.id, reason: 'The owner showed the receipt' }))).toBe('NO_CORRECTION_SESSION');
    await openCorrectionSession(owner, { password: PASSWORD, reason: 'Placing the vouchers nobody could' });
    await attachImportedPayment(owner, loose.id, { storeId: store.id, reason: 'The owner showed the receipt' });
    expect((await listUnassignedPayments(owner)).map((p) => p.id)).not.toContain(loose.id);
    expect(await codeOf(attachImportedPayment(owner, loose.id, { storeId: store.id, reason: 'Again' }))).toBe('ALREADY_CORRECTED');
    // Awaiting re-verification: it waits with the rest of the store's history.
    expect((await importedHistory(seller, store.id)).balance).toBe('250.00');
    await reverifyStore(seller, store.id, await details(seller, '250.00'));
    expect((await getCreditStatus(owner, store.id)).outstanding).toBe('250.00');

    // A store verified already takes it into its account at once.
    const second = await anImportedStore();
    await reverifyStore(second.seller, second.store.id, await details(second.seller, '300.00'));
    await openCorrectionSession(second.owner, { password: PASSWORD, reason: 'Placing the vouchers nobody could' });
    await attachImportedPayment(second.owner, second.loose.id, { storeId: second.store.id, reason: 'The voucher names this store' });
    expect((await getCreditStatus(second.owner, second.store.id)).outstanding).toBe('250.00');
  });

  it('ADR-0047, ADR-0059: a voucher number in the books cannot be used again in the app', async () => {
    const { owner, voucher } = await anImportedStore();
    const shop = await (await import('../../test/sales')).aSellingSeller(owner);
    const taken = { amount: '10.00', method: 'CASH' as const, voucher: { ...(await aVoucher(shop.seller.ctx)), number: voucher.cash } };
    await (await import('./index')).adjustBalance(owner, shop.store.id, { amount: '10.00', reason: 'Opening balance' });
    expect(await codeOf(recordPayment(shop.seller.ctx, { storeId: shop.store.id, ...taken }))).toBe('DUPLICATE_VOUCHER');
  });
});
