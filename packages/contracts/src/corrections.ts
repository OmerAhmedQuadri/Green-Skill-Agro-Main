import { z } from 'zod';
import { Limit, MoneyString, OptionalText, QueryBoolean, Version } from './shared';

/** COR-001: the Super Admin's own password again, and why the session is opened. A blank reason is the service's to refuse. */
export const OpenCorrectionSessionRequest = z.object({ password: z.string().min(1).max(256), reason: z.string().max(1000) });

/** COR-003: keep the reason, add to it, or edit it; adding and editing carry the words. */
export const CloseCorrectionSessionRequest = z.object({
  version: Version, closing: z.enum(['KEPT', 'ADDED', 'EDITED']), text: OptionalText(1000),
});

export const ListCorrectionSessionsQuery = z.object({ cursor: z.string().max(20).optional(), limit: Limit.optional() });

/** COR-005: what changes — anything left out stays as it was — or a removal, and why. A blank reason is the service's to refuse. */
export const StoreCorrectionRequest = z.object({
  reason: z.string().max(1000),
  amount: MoneyString.optional(), date: z.string().trim().max(10).optional(), storeId: z.uuid().optional(),
  voucherNumber: z.string().trim().max(60).optional(), remove: z.boolean().optional(),
  /** A cash payment taken in the app: correct its collector's cash in hand too. */
  cashInHand: z.boolean().optional(),
});

/** COR-002: the same change, to see its effect before confirming it. */
export const StoreCorrectionPreviewQuery = z.object({
  amount: MoneyString.optional(), date: z.string().trim().max(10).optional(), storeId: z.uuid().optional(),
  voucherNumber: z.string().trim().max(60).optional(), remove: QueryBoolean.optional(), cashInHand: QueryBoolean.optional(),
});

/** COR-005, IMP-009: the store an imported payment nobody could place belongs to, and why. */
export const AttachImportedPaymentRequest = z.object({ storeId: z.uuid(), reason: z.string().max(1000) });

/** IMP-009: the import's warnings, open (the default) or resolved. */
export const ListImportWarningsQuery = z.object({ resolved: QueryBoolean.optional() });

/** IMP-009: kept as it is, or marked corrected (in a correction session) — with a note either way. */
export const ResolveImportWarningRequest = z.object({ resolution: z.enum(['KEPT', 'CORRECTED']), note: z.string().max(1000) });

/**
 * COR-006: a sale made in the app — each line's packs or price, its store, or the whole sale away — and which of its
 * stock, delivery document, account and cash in hand follow. A blank reason is the service's to refuse.
 */
export const SaleCorrectionRequest = z.object({
  reason: z.string().max(1000),
  lines: z.array(z.object({
    lineId: z.uuid(), packs: z.number().int().min(0).max(1_000_000).optional(), unitPrice: MoneyString.optional(),
  })).max(200).optional(),
  storeId: z.uuid().optional(), remove: z.boolean().optional(),
  stock: z.boolean().optional(), document: z.boolean().optional(), account: z.boolean().optional(), cashInHand: z.boolean().optional(),
});

/** COR-006: an imported sale's lines as they should read — product, packs, price and amount — and its discount. */
export const ImportedSaleCorrectionRequest = z.object({
  reason: z.string().max(1000),
  lines: z.array(z.object({
    item: z.string().max(200), skuId: z.uuid().nullable().optional(),
    packs: z.string().trim().regex(/^\d{1,9}(\.\d{1,3})?$/), unitPrice: MoneyString, amount: MoneyString.optional(),
  })).min(1).max(200),
  discount: MoneyString.optional(),
});

