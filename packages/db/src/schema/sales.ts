import { sql } from 'drizzle-orm';
import { check, date, index, integer, numeric, pgEnum, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { skus } from './catalogue';
import { createdAt, id, timestamptz } from './columns';
import { users } from './identity';
import { mutable } from './mutable';
import { branches } from './organisation';
import { batches } from './stock';
import { creditOverrides, payments, storeLedgerEntries, stores } from './stores';
import { vehicles } from './vehicles';

// Mirror packages/core/src/sales and packages/core/src/cash.
export const saleStatus = pgEnum('sale_status', ['PENDING_DISCOUNT_APPROVAL', 'DISCOUNT_APPROVED', 'PENDING_DELIVERY', 'COMPLETED', 'CANCELLED']);
export const saleCancelReason = pgEnum('sale_cancel_reason', ['REJECTED', 'EXPIRED', 'WITHDRAWN']);
export const discountRequestStatus = pgEnum('discount_request_status', ['PENDING', 'APPROVED', 'REDUCED', 'REJECTED', 'EXPIRED', 'WITHDRAWN']);
export const deliveryDocumentStatus = pgEnum('delivery_document_status', ['PENDING', 'READY', 'FAILED']);
export const documentSendChannel = pgEnum('document_send_channel', ['SHARE', 'EMAIL']);
export const cashLedgerEntryType = pgEnum('cash_ledger_entry_type', ['COLLECTION', 'SETTLEMENT_APPROVED', 'DISCREPANCY']);

const money = (name: string) => numeric(name, { precision: 14, scale: 2 });
const percent = (name: string) => numeric(name, { precision: 6, scale: 3 });

/**
 * SAL-001..011, STATE-MACHINES §2. A vehicle sale within its ceilings is
 * created COMPLETED in one request; only a sale awaiting a discount decision
 * lives on in progress (ADR-0037).
 */
export const sales = pgTable(
  'sales',
  {
    id: id(),
    storeId: uuid('store_id').notNull().references(() => stores.id),
    sellerId: uuid('seller_id').notNull().references(() => users.id),
    vehicleId: uuid('vehicle_id').notNull().references(() => vehicles.id),
    status: saleStatus('status').notNull(),
    businessDate: date('business_date').notNull(),
    gross: money('gross').notNull(),
    discount: money('discount').notNull(),
    total: money('total').notNull(),
    ledgerEntryId: uuid('ledger_entry_id').references(() => storeLedgerEntries.id), // the store ledger's SALE, on completion
    paymentId: uuid('payment_id').references(() => payments.id),                  // SAL-006: bill to bill, settled at once
    creditOverrideId: uuid('credit_override_id').references(() => creditOverrides.id), // SAL-009: the override this sale used
    completedAt: timestamptz('completed_at'),
    cancelledAt: timestamptz('cancelled_at'),
    cancelReason: saleCancelReason('cancel_reason'),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    ...mutable(),
  },
  (t) => [
    index('sales_seller_id_idx').on(t.sellerId, t.createdAt),
    index('sales_store_id_idx').on(t.storeId, t.createdAt),
    index('sales_vehicle_id_idx').on(t.vehicleId),
    index('sales_holding_idx').on(t.status).where(sql`${t.status} in ('PENDING_DISCOUNT_APPROVAL', 'DISCOUNT_APPROVED')`),
    index('sales_ledger_entry_id_idx').on(t.ledgerEntryId),
    index('sales_payment_id_idx').on(t.paymentId),
    index('sales_credit_override_id_idx').on(t.creditOverrideId),
    check('sales_completed', sql`(${t.status} = 'COMPLETED') = (${t.completedAt} is not null and ${t.ledgerEntryId} is not null)`),
    check('sales_cancelled', sql`(${t.status} = 'CANCELLED') = (${t.cancelledAt} is not null and ${t.cancelReason} is not null)`),
    check('sales_total', sql`${t.total} = ${t.gross} - ${t.discount} and ${t.total} > 0`),
  ],
);

/** One line per SKU: its price when the sale was made, the discount asked and the discount given. */
export const saleLines = pgTable(
  'sale_lines',
  {
    id: id(),
    saleId: uuid('sale_id').notNull().references(() => sales.id),
    skuId: uuid('sku_id').notNull().references(() => skus.id),
    packs: integer('packs').notNull(),
    quantity: numeric('quantity', { precision: 14, scale: 3 }).notNull(), // base units (ADR-0015)
    unitPrice: money('unit_price').notNull(),
    ceiling: percent('ceiling').notNull(),                       // PRC-006: the tighter, when sold
    requestedDiscount: percent('requested_discount').notNull(),  // PRC-017
    discount: percent('discount').notNull(),                     // as given: requested, or as approved
    gross: money('gross').notNull(),
    discountAmount: money('discount_amount').notNull(),
    total: money('total').notNull(),
  },
  (t) => [
    unique('sale_lines_sku_unique').on(t.saleId, t.skuId),
    index('sale_lines_sku_id_idx').on(t.skuId),
    check('sale_lines_packs_positive', sql`${t.packs} > 0`),
    check('sale_lines_discount', sql`${t.discount} >= 0 and ${t.discount} <= ${t.requestedDiscount}`),
    check('sale_lines_total', sql`${t.total} = ${t.gross} - ${t.discountAmount}`),
  ],
);

/**
 * DATA-MODEL §5.3: which batch satisfied which line — RET-007 returns stock to
 * its original batch. While the sale awaits a decision these are its holds
 * (DATA-MODEL §5.4a).
 */
export const saleLineAllocations = pgTable(
  'sale_line_allocations',
  {
    id: id(),
    saleLineId: uuid('sale_line_id').notNull().references(() => saleLines.id),
    batchId: uuid('batch_id').notNull().references(() => batches.id),
    quantity: numeric('quantity', { precision: 14, scale: 3 }).notNull(),
    unitPrice: money('unit_price').notNull(), // price at the time of sale, for return validation (RET-001)
  },
  (t) => [
    unique('sale_line_allocations_batch_unique').on(t.saleLineId, t.batchId),
    index('sale_line_allocations_batch_id_idx').on(t.batchId),
    check('sale_line_allocations_quantity_positive', sql`${t.quantity} > 0`),
  ],
);

/** PRC-009..017 (OQ-001): the request, who decided it, how, and when. */
export const discountApprovalRequests = pgTable(
  'discount_approval_requests',
  {
    id: id(),
    saleId: uuid('sale_id').notNull().unique().references(() => sales.id),
    status: discountRequestStatus('status').notNull().default('PENDING'),
    reason: text('reason').notNull(),
    requestedAt: timestamptz('requested_at').notNull(),
    requestedBy: uuid('requested_by').notNull().references(() => users.id),
    expiresAt: timestamptz('expires_at').notNull(),
    decidedAt: timestamptz('decided_at'),
    decidedBy: uuid('decided_by').references(() => users.id),
    comment: text('comment'),
    closedAt: timestamptz('closed_at'), // expired or withdrawn
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    createdAt: createdAt(),
  },
  (t) => [
    index('discount_approval_requests_pending_idx').on(t.expiresAt).where(sql`${t.status} = 'PENDING'`),
    index('discount_approval_requests_decided_by_idx').on(t.decidedBy),
    check('discount_approval_requests_decided', sql`(${t.status} in ('APPROVED', 'REDUCED', 'REJECTED')) = (${t.decidedAt} is not null and ${t.decidedBy} is not null)`),
  ],
);

/**
 * DOC-001..006, ADR-0019, ADR-0037: the delivery document. Numbered in the
 * sale's transaction, gapless; the PENDING row is the worker's render job.
 */
export const deliveryDocuments = pgTable(
  'delivery_documents',
  {
    id: id(),
    saleId: uuid('sale_id').notNull().unique().references(() => sales.id),
    number: text('number').notNull().unique(),
    status: deliveryDocumentStatus('status').notNull().default('PENDING'),
    storageKey: text('storage_key'),
    byteSize: integer('byte_size'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamptz('next_attempt_at').notNull().defaultNow(),
    lastError: text('last_error'),
    renderedAt: timestamptz('rendered_at'),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    createdAt: createdAt(),
  },
  (t) => [
    index('delivery_documents_due_idx').on(t.nextAttemptAt).where(sql`${t.status} = 'PENDING'`),
    check('delivery_documents_ready', sql`(${t.status} = 'READY') = (${t.storageKey} is not null and ${t.renderedAt} is not null)`),
  ],
);

/** DOC-003: each time the document was shared from the phone or emailed. Append-only. */
export const deliveryDocumentSends = pgTable(
  'delivery_document_sends',
  {
    id: id(),
    documentId: uuid('document_id').notNull().references(() => deliveryDocuments.id),
    channel: documentSendChannel('channel').notNull(),
    toAddress: text('to_address'),
    sentAt: timestamptz('sent_at').notNull(),
    sentBy: uuid('sent_by').notNull().references(() => users.id),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    createdAt: createdAt(),
  },
  (t) => [
    index('delivery_document_sends_document_id_idx').on(t.documentId),
    check('delivery_document_sends_email_address', sql`(${t.channel} = 'EMAIL') = (${t.toAddress} is not null)`),
  ],
);

/**
 * The cash ledger (DATA-MODEL §3.3, ADR-0037). Signed: + raises the seller's
 * cash in hand. Append-only; cash in hand is its sum.
 */
export const cashLedgerEntries = pgTable(
  'cash_ledger_entries',
  {
    id: id(),
    sellerId: uuid('seller_id').notNull().references(() => users.id),
    occurredAt: timestamptz('occurred_at').notNull(),
    entryType: cashLedgerEntryType('entry_type').notNull(),
    amount: money('amount').notNull(),
    referenceType: text('reference_type').notNull(),
    referenceId: uuid('reference_id').notNull(),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    createdAt: createdAt(),
    createdBy: uuid('created_by').notNull().references(() => users.id),
  },
  (t) => [
    index('cash_ledger_entries_seller_idx').on(t.sellerId, t.occurredAt),
    index('cash_ledger_entries_reference_idx').on(t.referenceType, t.referenceId),
    uniqueIndex('cash_ledger_entries_one_collection').on(t.referenceType, t.referenceId).where(sql`${t.entryType} = 'COLLECTION'`),
    check('cash_ledger_sign', sql`(${t.entryType} = 'COLLECTION' and ${t.amount} > 0) or (${t.entryType} = 'SETTLEMENT_APPROVED' and ${t.amount} < 0) or (${t.entryType} = 'DISCREPANCY' and ${t.amount} <> 0)`),
  ],
);
