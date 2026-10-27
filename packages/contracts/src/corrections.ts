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
