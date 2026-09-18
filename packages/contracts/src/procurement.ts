import { z } from 'zod';
import { Limit, MoneyString, Version } from './shared';

/** Procurement and goods receipt contracts (API.md). Quantities are packs. */
export const PoStatus = z.enum(['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PLACED', 'CONFIRMED', 'IN_TRANSIT', 'PARTIALLY_RECEIVED', 'FULLY_RECEIVED', 'CLOSED']);
export const PoAction = z.enum(['submit', 'reject', 'approve', 'place', 'confirm', 'despatch', 'close_short', 'cancel']);

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Line = z.object({ skuId: z.uuid(), orderedPacks: z.number().int().min(1).max(1_000_000), expectedUnitCost: MoneyString });

export const ListPurchaseOrdersQuery = z.object({
  status: PoStatus.optional(), open: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  vendorId: z.uuid().optional(), search: z.string().trim().max(40).optional(), cursor: z.uuid().optional(), limit: Limit.optional(),
});

export const CreatePurchaseOrderRequest = z.object({
  vendorId: z.uuid(), expectedArrival: IsoDate.nullable().optional(), notes: z.string().trim().max(1000).nullable().optional(),
  lines: z.array(Line).min(1).max(200),
});

export const UpdatePurchaseOrderRequest = z.object({
  version: Version, vendorId: z.uuid().optional(), expectedArrival: IsoDate.nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(), lines: z.array(Line).min(1).max(200).optional(),
});

export const TransitionRequest = z.object({ version: Version, reason: z.string().trim().max(500).nullable().optional() });

/** RCV-003..007: one line per batch; a PO line may appear more than once (RCV-004). */
export const ReceiveGoodsRequest = z.object({
  version: Version,
  source: z.enum(['MANUAL', 'IMPORT']).optional(),
  fileName: z.string().trim().max(200).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
  lines: z.array(z.object({
    purchaseOrderLineId: z.uuid(),
    packs: z.number().int().min(1).max(1_000_000),
    lotNumber: z.string().trim().max(60).nullable().optional(),
    manufacturedOn: IsoDate.nullable().optional(),
    expiresOn: IsoDate.nullable().optional(),
    shelfLife: z.union([z.object({ months: z.number().int() }), z.object({ years: z.number().int() })]).nullable().optional(),
    unitCost: MoneyString.nullable().optional(),
  })).min(1).max(500),
});

/** RCV-002: the file travels base64-encoded; 2 MB of spreadsheet at most. */
export const ReceiptPreviewRequest = z.object({
  fileName: z.string().trim().min(1).max(200),
  content: z.string().max(2_900_000),
});
