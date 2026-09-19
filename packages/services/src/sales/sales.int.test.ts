import type { DomainError, PermissionCode } from '@gsa/core';
import { describe, expect, it } from 'vitest';
import { blobs } from '../../test/blobs';
import { ownerQuery } from '../../test/db';
import { anAccount, ctxFor } from '../../test/factories';
import { mailer } from '../../test/mailer';
import { aPdfRenderer, aSellingSeller } from '../../test/sales';
import { captureFor } from '../../test/vehicles';
import { checkOut } from '../attendance';
import { cashInHand, getMyCashInHand } from '../cash';
import { deliverPendingEmails, listMyNotifications } from '../notifications';
import { inTx, nextDocumentNumber, runIdempotent } from '../platform';
import { getDb } from '../runtime';
import { adjustBalance, getCreditStatus, grantCreditOverride, listStoreLedger, recordPayment } from '../stores';
import { updateSettings } from '../system';
import { getMyVehicle } from '../vehicles';
import {
  completeSale, decideDiscountRequest, deliveryDocumentPdf, emailDeliveryDocument, expireDiscountRequests, getSale, listSales,
  recordDocumentShared, recordSale, renderPendingDocuments, saleOptions, withdrawSale,
} from './index';

const code = async (p: Promise<unknown>) => p.then(() => 'NO_ERROR', (e: DomainError) => e.code ?? String(e));
const admin = async () => ctxFor(await anAccount('ADMIN'));
const minutes = (n: number) => new Date(Date.now() + n * 60_000);
const year = new Date().toISOString().slice(0, 4);
const vehiclePacks = async (ctx: Parameters<typeof getMyVehicle>[0]) => {
  const v = await getMyVehicle(ctx);
  return { packs: v.packs, held: v.batches.reduce((n, b) => n + b.heldPacks, 0) };
};

describe('a sale within the ceilings (workflow I, SAL-001..008)', () => {
  it('SAL-001, SAL-003, SAL-004, SAL-005: the sale screen shows credit first, then live vehicle stock with the store price and the tighter ceiling', async () => {
    const ctx = await admin();
    const { seller, store, bag } = await aSellingSeller(ctx);
    const options = await saleOptions(seller.ctx, store.id);
    expect(options).toMatchObject({ store: { id: store.id, credit: { blocked: false, available: '5000.00' } }, notWorking: null, canDiscount: true });
    expect(options.items).toEqual([expect.objectContaining({ skuId: bag.id, sellablePacks: 10, unitPrice: '90.00', ceiling: '5' })]);
  });

  it('SAL-007, SAL-008, SAL-006, DOC-005: completes in one request — stock leaves the vehicle batch by batch, the store owes it by its cycle, a document is numbered', async () => {
    const ctx = await admin();
    const { seller, store, bag, bagBatch } = await aSellingSeller(ctx);
    const sale = await recordSale(seller.ctx, { storeId: store.id, lines: [{ skuId: bag.id, packs: 3, discount: '5' }] });
    expect(sale).toMatchObject({
      status: 'COMPLETED', gross: '270.00', discount: '13.50', total: '256.50', approval: null, payment: null,
      lines: [{ skuId: bag.id, packs: 3, unitPrice: '90.00', discount: '5.000', requestedDiscount: '5.000', total: '256.50', batches: [{ batchId: bagBatch.batchId, packs: 3 }] }],
      document: { number: `DN-${year}-000001`, status: 'PENDING', sends: [] }, sendingMode: 'OPTIONAL',
    });
    expect(await vehiclePacks(seller.ctx)).toEqual({ packs: 7, held: 0 });
    const [debit] = await listStoreLedger(ctx, store.id);
    expect(debit).toMatchObject({ entryType: 'SALE', amount: '256.50', open: '256.50' });
    expect(debit?.dueOn).toBeTruthy(); // weekly: the closing day of its week (OQ-018)
    const moved = await ownerQuery<{ account_kind: string; quantity: string }>(
      "select account_kind, quantity from stock_movements where reference_type = 'SALE' and reference_id = $1 order by quantity", [sale.id]);
    expect(moved).toEqual([{ account_kind: 'VEHICLE', quantity: '-15000.000' }, { account_kind: 'SOLD', quantity: '15000.000' }]);
    expect((await getCreditStatus(seller.ctx, store.id)).outstanding).toBe('256.50');
  });

  it('SAL-006, CSH-001: bill to bill settles at once — in cash it becomes the seller’s cash in hand; by transfer it needs a reference', async () => {
    const ctx = await admin();
    const { seller, store, bag } = await aSellingSeller(ctx, { creditMode: 'BILL_TO_BILL', creditLimit: '0.00' });
    const line = [{ skuId: bag.id, packs: 2 }];
    expect(await code(recordSale(seller.ctx, { storeId: store.id, lines: line }))).toBe('PAYMENT_REQUIRED');
    expect(await code(recordSale(seller.ctx, { storeId: store.id, lines: line, payment: { method: 'BANK_TRANSFER' } }))).toBe('REASON_REQUIRED');
    const cash = await recordSale(seller.ctx, { storeId: store.id, lines: line, payment: { method: 'CASH' } });
    expect(cash.payment).toMatchObject({ method: 'CASH', amount: '180.00' });
    expect(await getMyCashInHand(seller.ctx)).toEqual({ cashInHand: '180.00' });
    const transfer = await recordSale(seller.ctx, { storeId: store.id, lines: line, payment: { method: 'BANK_TRANSFER', reference: 'TRX-991' } });
    expect(transfer.payment).toMatchObject({ method: 'BANK_TRANSFER', reference: 'TRX-991' });
    expect(await getMyCashInHand(seller.ctx)).toEqual({ cashInHand: '180.00' });
    expect(await getCreditStatus(seller.ctx, store.id)).toMatchObject({ outstanding: '0.00', blocked: false });
  });

  it('CSH-001: cash collected later against a store’s balance is cash in hand too', async () => {
    const ctx = await admin();
    const { seller, store, bag } = await aSellingSeller(ctx);
    await recordSale(seller.ctx, { storeId: store.id, lines: [{ skuId: bag.id, packs: 2 }] });
    await recordPayment(seller.ctx, { storeId: store.id, amount: '100.00', method: 'CASH' });
    expect(await cashInHand(getDb(), seller.account.id)).toBe('100.00');
  });

  it('SAL-010: no sale without an open check-in', async () => {
    const ctx = await admin();
    const { seller, store, bag } = await aSellingSeller(ctx);
    await checkOut(seller.ctx, await captureFor(seller.ctx, 10_050));
    expect(await code(recordSale(seller.ctx, { storeId: store.id, lines: [{ skuId: bag.id, packs: 1 }] }))).toBe('CHECK_IN_REQUIRED');
    expect((await saleOptions(seller.ctx, store.id)).notWorking).toBe('CHECK_IN_REQUIRED');
  });

  it('SAL-003, STK-015, SAL-004: only what the vehicle holds, in whole packs, and only priced items', async () => {
    const ctx = await admin();
    const { seller, store, bag, pouch } = await aSellingSeller(ctx, { packs: 4 });
    expect(await code(recordSale(seller.ctx, { storeId: store.id, lines: [{ skuId: bag.id, packs: 5 }] }))).toBe('INSUFFICIENT_STOCK');
    expect(await code(recordSale(seller.ctx, { storeId: store.id, lines: [{ skuId: bag.id, packs: 1.5 }] }))).toBe('INVALID_PACK_COUNT');
    expect(await code(recordSale(seller.ctx, { storeId: store.id, lines: [{ skuId: pouch.id, packs: 1 }] }))).toBe('NO_PRICE');
  });
});

describe('credit at the point of sale (SAL-002, SAL-009, CRD-004..007, OQ-018)', () => {
  it('SAL-002, CRD-004: a store past due cannot be sold to, with its reasons', async () => {
    const ctx = await admin();
    const { seller, store, bag } = await aSellingSeller(ctx);
    await adjustBalance(ctx, store.id, { amount: '100.00', reason: 'Opening balance', dueOn: '2026-01-01' });
    const refused = await recordSale(seller.ctx, { storeId: store.id, lines: [{ skuId: bag.id, packs: 1 }] }).catch((e: DomainError) => e);
    expect(refused).toMatchObject({ code: 'CREDIT_BLOCKED', details: { reasons: [{ code: 'PAST_DUE' }] } });
  });

  it('OQ-018: a sale on credit stops at the limit; an override releases one sale, which uses it up', async () => {
    const ctx = await admin();
    const { seller, store, bag } = await aSellingSeller(ctx, { creditLimit: '200.00' });
    const three = [{ skuId: bag.id, packs: 3 }]; // 270.00
    const refused = await recordSale(seller.ctx, { storeId: store.id, lines: three }).catch((e: DomainError) => e);
    expect(refused).toMatchObject({ code: 'CREDIT_LIMIT_EXCEEDED', details: { available: '200.00', total: '270.00' } });
    await grantCreditOverride(ctx, store.id, { reason: 'Big order before the season' });
    const sale = await recordSale(seller.ctx, { storeId: store.id, lines: three });
    expect(sale.creditOverride).toMatchObject({ reason: 'Big order before the season' });
    // SAL-009: one sale only — the store is now over its limit and blocked again.
    expect(await code(recordSale(seller.ctx, { storeId: store.id, lines: [{ skuId: bag.id, packs: 1 }] }))).toBe('CREDIT_BLOCKED');
  });
});

describe('above the ceiling: approval (PRC-008..017)', () => {
  const approver = async () => admin();

  it('PRC-008, PRC-009, PRC-016: above the ceiling needs a reason; above the absolute maximum cannot be asked at all', async () => {
    const ctx = await admin();
    const { seller, store, bag } = await aSellingSeller(ctx);
    const refused = await recordSale(seller.ctx, { storeId: store.id, lines: [{ skuId: bag.id, packs: 2, discount: '12' }] }).catch((e: DomainError) => e);
    expect(refused).toMatchObject({ code: 'DISCOUNT_ABOVE_CEILING', details: { lines: [{ skuId: bag.id, discount: '12', ceiling: '5' }] } });
    expect(await code(recordSale(seller.ctx, { storeId: store.id, lines: [{ skuId: bag.id, packs: 2, discount: '26' }], approvalReason: 'x' }))).toBe('DISCOUNT_ABOVE_MAXIMUM');
  });

  it('PRC-010, PRC-011, PRC-012: a request holds its stock, posts nothing, notifies every approver, and cannot be completed while pending', async () => {
    const ctx = await admin();
    const other = await approver();
    const { seller, store, bag } = await aSellingSeller(ctx);
    const sale = await recordSale(seller.ctx, { storeId: store.id, lines: [{ skuId: bag.id, packs: 4, discount: '12' }], approvalReason: 'Matching a competitor’s price' });
    expect(sale).toMatchObject({ status: 'PENDING_DISCOUNT_APPROVAL', total: '316.80', document: null, approval: { status: 'PENDING', reason: 'Matching a competitor’s price' } });
    expect(await vehiclePacks(seller.ctx)).toEqual({ packs: 10, held: 4 });
    expect((await saleOptions(seller.ctx, store.id)).items[0]?.sellablePacks).toBe(6);
    expect(await listStoreLedger(ctx, store.id)).toEqual([]);
    expect(await ownerQuery("select 1 from stock_movements where reference_type = 'SALE'")).toEqual([]);
    for (const a of [ctx, other]) expect((await listMyNotifications(a)).items.map((n) => n.kind)).toContain('DISCOUNT_APPROVAL_REQUESTED');
    expect((await listSales(other, { awaitingDecision: true })).items.map((s) => s.id)).toEqual([sale.id]);
    expect(await code(completeSale(seller.ctx, sale.id, { version: sale.version }))).toBe('INVALID_TRANSITION');
    // PRC-011: what is held cannot be sold again meanwhile.
    expect(await code(recordSale(seller.ctx, { storeId: store.id, lines: [{ skuId: bag.id, packs: 7 }] }))).toBe('INSUFFICIENT_STOCK');
  });

  it('PRC-013, PRC-014, PRC-017: approved lower with a comment — the first decision wins — and the seller completes at the approved discount', async () => {
    const ctx = await admin();
    const first = await approver();
    const second = await approver();
    const { seller, store, bag } = await aSellingSeller(ctx);
    const pending = await recordSale(seller.ctx, { storeId: store.id, lines: [{ skuId: bag.id, packs: 4, discount: '12' }], approvalReason: 'Season opening' });
    const lineId = pending.lines[0]?.id ?? '';
    expect(await code(decideDiscountRequest(first, pending.id, { version: pending.version, approve: true, lines: [{ lineId, discount: '8' }] }))).toBe('REASON_REQUIRED');
    const approved = await decideDiscountRequest(first, pending.id, { version: pending.version, approve: true, lines: [{ lineId, discount: '8' }], comment: 'Eight is the most this season' });
    expect(approved).toMatchObject({
      status: 'DISCOUNT_APPROVED', total: '331.20', discount: '28.80',
      lines: [{ requestedDiscount: '12.000', discount: '8.000' }], approval: { status: 'REDUCED', comment: 'Eight is the most this season', decidedBy: { id: first.user.id } },
    });
    const late = await decideDiscountRequest(second, pending.id, { version: approved.version, approve: false, comment: 'No' }).catch((e: DomainError) => e);
    expect(late).toMatchObject({ code: 'ALREADY_DECIDED', details: { status: 'REDUCED' } });
    expect((await listMyNotifications(seller.ctx)).items.map((n) => n.kind)).toContain('DISCOUNT_REDUCED');

    const done = await completeSale(seller.ctx, pending.id, { version: approved.version });
    expect(done).toMatchObject({ status: 'COMPLETED', total: '331.20', document: { number: `DN-${year}-000001` } });
    expect(await vehiclePacks(seller.ctx)).toEqual({ packs: 6, held: 0 });
    expect((await listStoreLedger(ctx, store.id))[0]).toMatchObject({ entryType: 'SALE', amount: '331.20' });
    const trail = await ownerQuery<{ action: string }>("select action from audit_log where entity_id = $1 order by occurred_at, id", [pending.id]);
    expect(trail.map((a) => a.action)).toEqual(['sales.discount_requested', 'sales.discount_decided', 'sales.completed']);
  });

  it('PRC-014: a rejection closes the sale and releases what it held', async () => {
    const ctx = await admin();
    const { seller, store, bag } = await aSellingSeller(ctx);
    const pending = await recordSale(seller.ctx, { storeId: store.id, lines: [{ skuId: bag.id, packs: 4, discount: '12' }], approvalReason: 'Asked' });
    expect(await code(decideDiscountRequest(ctx, pending.id, { version: pending.version, approve: false }))).toBe('REASON_REQUIRED');
    const rejected = await decideDiscountRequest(ctx, pending.id, { version: pending.version, approve: false, comment: 'Too deep' });
    expect(rejected).toMatchObject({ status: 'CANCELLED', cancelReason: 'REJECTED', approval: { status: 'REJECTED' } });
    expect(await vehiclePacks(seller.ctx)).toEqual({ packs: 10, held: 0 });
    expect((await listMyNotifications(seller.ctx)).items.map((n) => n.kind)).toContain('DISCOUNT_REJECTED');
  });

  it('PRC-013: nobody decides their own sale', async () => {
    const ctx = await admin();
    const { seller, store, bag } = await aSellingSeller(ctx);
    const pending = await recordSale(seller.ctx, { storeId: store.id, lines: [{ skuId: bag.id, packs: 1, discount: '12' }], approvalReason: 'Asked' });
    const self = { ...seller.ctx, permissions: new Set<PermissionCode>([...seller.ctx.permissions, 'sales.approve_discount']) };
    expect(await code(decideDiscountRequest(self, pending.id, { version: pending.version, approve: true }))).toBe('FOUR_EYES');
  });

  it('PRC-015: the seller may withdraw at any time, which cancels the sale and frees its stock', async () => {
    const ctx = await admin();
    const { seller, store, bag } = await aSellingSeller(ctx);
    const pending = await recordSale(seller.ctx, { storeId: store.id, lines: [{ skuId: bag.id, packs: 4, discount: '12' }], approvalReason: 'Asked' });
    const withdrawn = await withdrawSale(seller.ctx, pending.id, { version: pending.version });
    expect(withdrawn).toMatchObject({ status: 'CANCELLED', cancelReason: 'WITHDRAWN', approval: { status: 'WITHDRAWN' } });
    expect(await vehiclePacks(seller.ctx)).toEqual({ packs: 10, held: 0 });
    expect(await code(decideDiscountRequest(ctx, pending.id, { version: withdrawn.version, approve: true }))).toBe('ALREADY_DECIDED');
  });

  it('PRC-015: an undecided request expires after the configured minutes, and at check-out', async () => {
    const ctx = await admin();
    await updateSettings(ctx, [{ key: 'discount.approval_expiry_minutes', value: 10 }]);
    const { seller, store, bag } = await aSellingSeller(ctx);
    const pending = await recordSale(seller.ctx, { storeId: store.id, lines: [{ skuId: bag.id, packs: 2, discount: '12' }], approvalReason: 'Asked' });
    expect(await expireDiscountRequests(minutes(9))).toEqual({ expired: 0 });
    expect(await expireDiscountRequests(minutes(11))).toEqual({ expired: 1 });
    expect(await getSale(seller.ctx, pending.id)).toMatchObject({ status: 'CANCELLED', cancelReason: 'EXPIRED', approval: { status: 'EXPIRED' } });
    expect((await listMyNotifications(seller.ctx)).items.map((n) => n.kind)).toContain('DISCOUNT_EXPIRED');

    const again = await recordSale(seller.ctx, { storeId: store.id, lines: [{ skuId: bag.id, packs: 2, discount: '12' }], approvalReason: 'Asked again' });
    const approved = await decideDiscountRequest(ctx, again.id, { version: again.version, approve: true });
    await checkOut(seller.ctx, await captureFor(seller.ctx, 10_050));
    expect(await getSale(seller.ctx, approved.id)).toMatchObject({ status: 'CANCELLED', cancelReason: 'EXPIRED' });
    expect(await vehiclePacks(seller.ctx)).toMatchObject({ held: 0 });
  });
});

describe('exactly once (SAL-011, ADR-0009)', () => {
  it('SAL-011: the same completion sent twice — even at once — makes one sale', async () => {
    const ctx = await admin();
    const { seller, store, bag } = await aSellingSeller(ctx);
    const send = () => runIdempotent(seller.ctx, { key: 'tap-1', hash: 'same-body' }, async (c) => ({ status: 201, body: await recordSale(c, { storeId: store.id, lines: [{ skuId: bag.id, packs: 2 }] }) }));
    const [a, b] = await Promise.all([send(), send()]);
    expect(a.body.id).toBe(b.body.id);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect((await listSales(seller.ctx, {})).items).toHaveLength(1);
    expect(await vehiclePacks(seller.ctx)).toEqual({ packs: 8, held: 0 });
  });
});

describe('the delivery document (DOC-001..006, ADR-0019)', () => {
  it('ADR-0019: numbers are gapless — a rolled-back sale gives its number back', async () => {
    const now = new Date();
    await getDb().transaction(async (tx) => { await nextDocumentNumber(tx, 'DN', now, 6); tx.rollback(); }).catch(() => undefined);
    const ctx = await admin();
    const { seller, store, bag } = await aSellingSeller(ctx);
    const first = await recordSale(seller.ctx, { storeId: store.id, lines: [{ skuId: bag.id, packs: 1 }] });
    const second = await recordSale(seller.ctx, { storeId: store.id, lines: [{ skuId: bag.id, packs: 1 }] });
    expect([first.document?.number, second.document?.number]).toEqual([`DN-${year}-000001`, `DN-${year}-000002`]);
    await inTx({}, async (tx) => expect(await nextDocumentNumber(tx, 'DN', now, 6)).toBe(`DN-${year}-000003`));
  });

  it('DOC-001, DOC-002, DOC-005, DOC-006: the worker prints it — store, date, seller, items, prices, total; not a tax invoice in both languages; no VAT — and keeps the copy', async () => {
    const ctx = await admin();
    const { seller, store, bag } = await aSellingSeller(ctx);
    const sale = await recordSale(seller.ctx, { storeId: store.id, lines: [{ skuId: bag.id, packs: 3, discount: '5' }] });
    expect(await code(deliveryDocumentPdf(seller.ctx, sale.id))).toBe('DOCUMENT_NOT_READY');
    const renderer = aPdfRenderer();
    expect(await renderPendingDocuments(renderer, new Date())).toEqual({ rendered: 1, failed: 0 });
    const html = renderer.printed[0] ?? '';
    for (const text of [store.name, sale.seller.name, bag.code, '90.00', '256.50', `DN-${year}-000001`, 'This is not a tax invoice', 'هذه ليست فاتورة ضريبية']) expect(html).toContain(text);
    expect(html).not.toMatch(/VAT|ضريبة القيمة المضافة/);
    const { number, pdf } = await deliveryDocumentPdf(seller.ctx, sale.id);
    expect(number).toBe(`DN-${year}-000001`);
    expect(new TextDecoder().decode(pdf)).toMatch(/^%PDF/);
    expect(blobs.keys()).toContain(`delivery-documents/${year}/DN-${year}-000001.pdf`);
    expect((await getSale(seller.ctx, sale.id)).document?.status).toBe('READY');
  });

  it('ADR-0019: a render that fails is retried later, then left FAILED with its error', async () => {
    const ctx = await admin();
    const { seller, store, bag } = await aSellingSeller(ctx);
    const sale = await recordSale(seller.ctx, { storeId: store.id, lines: [{ skuId: bag.id, packs: 1 }] });
    const broken = aPdfRenderer({ fail: true });
    expect(await renderPendingDocuments(broken, new Date())).toEqual({ rendered: 0, failed: 1 });
    expect(await renderPendingDocuments(broken, new Date())).toEqual({ rendered: 0, failed: 0 }); // waits before retrying
    for (let i = 0; i < 6; i += 1) await renderPendingDocuments(broken, new Date(Date.now() + (i + 1) * 3_600_000));
    const [row] = await ownerQuery<{ status: string; last_error: string }>('select status, last_error from delivery_documents where sale_id = $1', [sale.id]);
    expect(row).toEqual({ status: 'FAILED', last_error: 'chromium is not installed' });
  });

  it('DOC-003, OQ-007: shared from the phone or emailed with the PDF attached — each recorded', async () => {
    const ctx = await admin();
    const { seller, store, bag } = await aSellingSeller(ctx);
    const sale = await recordSale(seller.ctx, { storeId: store.id, lines: [{ skuId: bag.id, packs: 1 }] });
    expect(await code(recordDocumentShared(seller.ctx, sale.id))).toBe('DOCUMENT_NOT_READY');
    await renderPendingDocuments(aPdfRenderer(), new Date());
    await recordDocumentShared(seller.ctx, sale.id);
    expect(await code(emailDeliveryDocument(seller.ctx, sale.id, { to: 'not-an-email' }))).toBe('INVALID_EMAIL');
    await emailDeliveryDocument(seller.ctx, sale.id, { to: 'Owner@Store.example' });
    expect((await getSale(seller.ctx, sale.id)).document?.sends).toMatchObject([{ channel: 'SHARE', toAddress: null }, { channel: 'EMAIL', toAddress: 'owner@store.example' }]);
    await deliverPendingEmails(mailer, new Date());
    const [email] = mailer.sent;
    expect(email).toMatchObject({ to: 'owner@store.example', attachments: [{ filename: `DN-${year}-000001.pdf`, contentType: 'application/pdf' }] });
    expect(email?.subject).toContain(`DN-${year}-000001`);
    expect(email?.text).toContain('This is not a tax invoice');
    expect(email?.text).toContain('هذه ليست فاتورة ضريبية');
    // Only the seller of record sends it.
    expect(await code(recordDocumentShared(ctx, sale.id))).toBe('NOT_FOUND');
  });

  it('DOC-004, DOC-005: with sending disabled nothing is sent, and the copy is still kept', async () => {
    const ctx = await admin();
    await updateSettings(ctx, [{ key: 'documents.sending', value: 'DISABLED' }]);
    const { seller, store, bag } = await aSellingSeller(ctx);
    const sale = await recordSale(seller.ctx, { storeId: store.id, lines: [{ skuId: bag.id, packs: 1 }] });
    expect(sale.sendingMode).toBe('DISABLED');
    await renderPendingDocuments(aPdfRenderer(), new Date());
    expect(await code(recordDocumentShared(seller.ctx, sale.id))).toBe('DOCUMENT_SENDING_DISABLED');
    expect(await code(emailDeliveryDocument(seller.ctx, sale.id, { to: 'a@b.example' }))).toBe('DOCUMENT_SENDING_DISABLED');
    expect((await deliveryDocumentPdf(ctx, sale.id)).number).toBe(`DN-${year}-000001`);
  });
});
