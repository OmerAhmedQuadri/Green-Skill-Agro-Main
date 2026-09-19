import { DOCUMENT_RENDER_MAX_ATTEMPTS, documentRenderBackoffMs, DomainError, normaliseEmail, type Money, type Percent } from '@gsa/core';
import { schema } from '@gsa/db';
import { and, asc, eq, lte } from 'drizzle-orm';
import { sizeOf } from '../catalogue';
import { authorize, type Ctx } from '../context';
import { enqueueEmail } from '../notifications';
import { audit, inOrder, inTx, nextDocumentNumber, type Executor, type Tx } from '../platform';
import { getBlobStore, getDb } from '../runtime';
import { loadSale, type Sale } from './access';
import { deliveryDocumentHtml, type DocumentData } from './document-html';
import { saleLimits } from './options';

const {
  deliveryDocuments, deliveryDocumentSends, sales, saleLines, stores, users, vehicles, skus, products, varieties, productTypes, payments, storeLedgerEntries,
} = schema;

/** Prints HTML to PDF — headless Chromium in the worker (ADR-0019), a fake in tests. */
export interface PdfRenderer {
  /** @font-face rules embedding the document's fonts, so no server font is needed (ADR-0037). */
  readonly fontCss: string;
  render(html: string): Promise<Uint8Array>;
}

/**
 * ADR-0019: the number is allocated in the sale's transaction from the locked
 * counter — gapless — and the PENDING row is the worker's render job.
 */
export async function createDeliveryDocument(tx: Tx, ctx: Ctx, saleId: string): Promise<string> {
  const number = await nextDocumentNumber(tx, 'DN', ctx.now, 6);
  await tx.insert(deliveryDocuments).values({ saleId, number, branchId: ctx.branchId, createdAt: ctx.now, nextAttemptAt: ctx.now });
  return number;
}

/** DOC-001: everything the document shows, read from the committed sale. */
async function documentData(db: Executor, saleId: string, number: string): Promise<DocumentData> {
  const [row] = await db.select({ s: sales, store: stores, seller: users.name, vehicle: vehicles.registration })
    .from(sales).innerJoin(stores, eq(stores.id, sales.storeId)).innerJoin(users, eq(users.id, sales.sellerId)).innerJoin(vehicles, eq(vehicles.id, sales.vehicleId))
    .where(eq(sales.id, saleId));
  if (!row) throw new Error(`sale ${saleId} missing for its document`);
  const [lines, [payment], [debit]] = await inOrder([
    db.select({ l: saleLines, sku: skus, productEn: products.nameEn, productAr: products.nameAr, varietyEn: varieties.nameEn, varietyAr: varieties.nameAr, countUnit: productTypes.countUnit })
      .from(saleLines).innerJoin(skus, eq(skus.id, saleLines.skuId)).innerJoin(products, eq(products.id, skus.productId))
      .innerJoin(productTypes, eq(productTypes.id, products.productTypeId)).leftJoin(varieties, eq(varieties.id, skus.varietyId))
      .where(eq(saleLines.saleId, saleId)).orderBy(asc(skus.code)),
    row.s.paymentId ? db.select().from(payments).where(eq(payments.id, row.s.paymentId)) : Promise.resolve([]),
    row.s.ledgerEntryId ? db.select({ dueOn: storeLedgerEntries.dueOn }).from(storeLedgerEntries).where(eq(storeLedgerEntries.id, row.s.ledgerEntryId)) : Promise.resolve([]),
  ]);
  return {
    number, issuedAt: row.s.completedAt ?? row.s.createdAt,
    store: { name: row.store.name, ownerName: row.store.ownerName, contactNumber: row.store.contactNumber },
    seller: row.seller, vehicle: row.vehicle,
    lines: lines.map((l) => ({
      code: l.sku.code, productEn: l.productEn, productAr: l.productAr, varietyEn: l.varietyEn, varietyAr: l.varietyAr,
      size: sizeOf(l.sku), countUnit: l.countUnit, packs: l.l.packs, unitPrice: l.l.unitPrice as Money, discount: l.l.discount as Percent,
      discountAmount: l.l.discountAmount as Money, total: l.l.total as Money,
    })),
    gross: row.s.gross as Money, discount: row.s.discount as Money, total: row.s.total as Money,
    settlement: payment ? { kind: 'PAID', method: payment.method, reference: payment.reference } : { kind: 'ON_ACCOUNT', dueOn: debit?.dueOn ?? row.s.businessDate },
  };
}

/**
 * The worker's pass (ADR-0019, ADR-0037): claims due documents — two workers
 * never take the same one — prints each, stores the PDF and marks it READY.
 * A failure waits longer each time and, after the last attempt, stays FAILED
 * with its error for someone to see.
 */
export async function renderPendingDocuments(renderer: PdfRenderer, now: Date, batch = 5): Promise<{ rendered: number; failed: number }> {
  let rendered = 0;
  let failed = 0;
  await getDb().transaction(async (tx) => {
    const due = await tx.select().from(deliveryDocuments)
      .where(and(eq(deliveryDocuments.status, 'PENDING'), lte(deliveryDocuments.nextAttemptAt, now)))
      .orderBy(asc(deliveryDocuments.nextAttemptAt)).limit(batch).for('update', { skipLocked: true });
    for (const doc of due) {
      const attempt = doc.attempts + 1;
      try {
        const html = deliveryDocumentHtml(await documentData(tx, doc.saleId, doc.number), { fontCss: renderer.fontCss });
        const pdf = new Uint8Array(await renderer.render(html));
        const key = `delivery-documents/${doc.number.slice(3, 7)}/${doc.number}.pdf`;
        await getBlobStore().put(key, pdf, 'application/pdf');
        await tx.update(deliveryDocuments).set({ status: 'READY', storageKey: key, byteSize: pdf.byteLength, attempts: attempt, renderedAt: now, lastError: null })
          .where(eq(deliveryDocuments.id, doc.id));
        rendered += 1;
      } catch (error) {
        await tx.update(deliveryDocuments).set({
          attempts: attempt, status: attempt >= DOCUMENT_RENDER_MAX_ATTEMPTS ? 'FAILED' : 'PENDING',
          nextAttemptAt: new Date(now.getTime() + documentRenderBackoffMs(attempt)),
          lastError: String(error instanceof Error ? error.message : error).slice(0, 500),
        }).where(eq(deliveryDocuments.id, doc.id));
        failed += 1;
      }
    }
  });
  return { rendered, failed };
}

/** DOC-005: the kept copy, for anyone who may see the sale. */
export async function deliveryDocumentPdf(ctx: Ctx, saleId: string): Promise<{ number: string; pdf: Uint8Array<ArrayBuffer> }> {
  authorize(ctx, 'sales.record');
  const db = getDb();
  const sale = await loadSale(db, ctx, saleId);
  const [doc] = await db.select().from(deliveryDocuments).where(eq(deliveryDocuments.saleId, sale.id));
  if (!doc) throw new DomainError('NOT_FOUND', { entity: 'delivery_document', saleId });
  if (doc.status !== 'READY' || !doc.storageKey) throw new DomainError('DOCUMENT_NOT_READY', { status: doc.status });
  const pdf = await getBlobStore().get(doc.storageKey);
  if (!pdf) throw new DomainError('DOCUMENT_NOT_READY', { status: 'MISSING' });
  return { number: doc.number, pdf };
}

/** DOC-003, DOC-004: only the seller of record sends, only a ready document, and not when sending is off. */
async function sendable(tx: Tx, ctx: Ctx, saleId: string): Promise<{ sale: Sale; documentId: string; number: string; storageKey: string }> {
  const sale = await loadSale(tx, ctx, saleId);
  if (sale.seller.id !== ctx.user.id) throw new DomainError('NOT_FOUND', { entity: 'sale', id: saleId });
  if ((await saleLimits(tx)).sendingMode === 'DISABLED') throw new DomainError('DOCUMENT_SENDING_DISABLED');
  const [doc] = await tx.select().from(deliveryDocuments).where(eq(deliveryDocuments.saleId, saleId));
  if (!doc) throw new DomainError('NOT_FOUND', { entity: 'delivery_document', saleId });
  if (doc.status !== 'READY' || !doc.storageKey) throw new DomainError('DOCUMENT_NOT_READY', { status: doc.status });
  return { sale, documentId: doc.id, number: doc.number, storageKey: doc.storageKey };
}

/**
 * DOC-003, OQ-007: the phone's share sheet finished — WhatsApp, SMS or email
 * from the seller's own phone. The app knows it was handed over, not that it
 * was delivered.
 */
export async function recordDocumentShared(ctx: Ctx, saleId: string): Promise<void> {
  authorize(ctx, 'sales.record');
  await inTx(ctx, async (tx) => {
    const { documentId, number } = await sendable(tx, ctx, saleId);
    await tx.insert(deliveryDocumentSends).values({ documentId, channel: 'SHARE', sentAt: ctx.now, sentBy: ctx.user.id, branchId: ctx.branchId, createdAt: ctx.now });
    await audit(tx, ctx, { action: 'sales.document_shared', entityType: 'sale', entityId: saleId, after: { number } });
  });
}

/** DOC-003: emailed from the server with the PDF attached, through the outbox (ADR-0023). */
export async function emailDeliveryDocument(ctx: Ctx, saleId: string, input: { to: string }): Promise<void> {
  authorize(ctx, 'sales.record');
  const to = normaliseEmail(input.to);
  await inTx(ctx, async (tx) => {
    const { sale, documentId, number, storageKey } = await sendable(tx, ctx, saleId);
    await enqueueEmail(tx, {
      to, template: 'delivery-document', locale: ctx.locale, branchId: ctx.branchId,
      params: { number, store: sale.store.name, seller: sale.seller.name, total: sale.total, attachmentKey: storageKey, attachmentName: `${number}.pdf` },
    }, ctx.now);
    await tx.insert(deliveryDocumentSends).values({ documentId, channel: 'EMAIL', toAddress: to, sentAt: ctx.now, sentBy: ctx.user.id, branchId: ctx.branchId, createdAt: ctx.now });
    await audit(tx, ctx, { action: 'sales.document_emailed', entityType: 'sale', entityId: saleId, after: { number, to } });
  });
}
