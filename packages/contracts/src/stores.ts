import { z } from 'zod';
import { MoneyString, OptionalText, Version } from './shared';

const CreditMode = z.enum(['BILL_TO_BILL', 'WEEKLY', 'MONTHLY', 'CUSTOM']);
const Days = z.number().int().min(1).max(365);
const Location = z.object({
  lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracyM: z.number().min(0).max(100_000).nullable().optional(),
});

/** Workflow H (STO-001..008) */
export const OnboardStoreRequest = z.object({
  name: z.string().trim().min(1).max(160), ownerName: z.string().trim().min(1).max(160),
  contactNumber: z.string().trim().min(3).max(30), category: OptionalText(80),
  location: Location, address: OptionalText(300),
  crNumber: OptionalText(40), vatNumber: OptionalText(40), nationalAddress: OptionalText(60),
  creditMode: CreditMode, creditCycleDays: Days.nullable().optional(), creditLimit: MoneyString, priceListId: z.uuid(),
  storefrontPhotoId: z.uuid(), sellerId: z.uuid().nullable().optional(), acknowledgeDuplicates: z.boolean().optional(),
});

export const DuplicateCheckQuery = z.object({
  lat: z.coerce.number().min(-90).max(90), lng: z.coerce.number().min(-180).max(180), name: z.string().trim().min(1).max(160),
});

export const ListStoresQuery = z.object({
  status: z.enum(['PENDING_APPROVAL', 'ACTIVE', 'REJECTED', 'INACTIVE']).optional(), search: z.string().trim().max(100).optional(),
  sellerId: z.uuid().optional(), blocked: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});

/** STO-009 */
export const DecideStoreRequest = z.object({ version: Version, reason: OptionalText(500) });
/** STATE-MACHINES §4 */
export const StoreActiveRequest = z.object({ version: Version, active: z.boolean() });
/** STO-005 */
export const StoreTermsRequest = z.object({ version: Version, creditLimit: MoneyString.optional(), priceListId: z.uuid().optional() });
/** CRD-001, OQ-010 */
export const CreditCycleRequest = z.object({ version: Version, creditMode: CreditMode, creditCycleDays: Days.nullable().optional() });
/** STO-007 */
export const ReassignStoreRequest = z.object({ sellerId: z.uuid(), note: OptionalText(300) });
/** CRD-006, 007 */
export const CreditOverrideRequest = z.object({ reason: z.string().trim().min(1).max(500) });
/** ADR-0036: signed — "-50.00" lowers what is owed. */
export const AdjustBalanceRequest = z.object({
  amount: z.string().trim().regex(/^[+-]?\d{1,12}(\.\d{1,2})?$/), reason: z.string().trim().min(1).max(500), dueOn: z.iso.date().nullable().optional(),
});
/** CRD-003 */
export const PaymentRequest = z.object({
  storeId: z.uuid(), amount: MoneyString, method: z.enum(['CASH', 'BANK_TRANSFER']), reference: OptionalText(100),
});
