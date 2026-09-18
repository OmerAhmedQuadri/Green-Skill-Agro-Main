import { z } from 'zod';
import { MoneyString, NameAr, NameEn, PercentString, Version } from './shared';

export const CreatePriceListRequest = z.object({ nameEn: NameEn, nameAr: NameAr });
export const UpdatePriceListRequest = z.object({ version: Version, nameEn: NameEn.optional(), nameAr: NameAr.optional(), isActive: z.boolean().optional() });

/** PRC-001: a null price takes the SKU off the list. */
export const SetPriceListItemsRequest = z.object({
  items: z.array(z.object({ skuId: z.uuid(), price: MoneyString.nullable() })).min(1).max(1000),
});

/** PRC-004..007, PRC-015, PRC-016 */
export const SetDiscountCeilingsRequest = z.object({
  orderCeiling: PercentString.optional(), itemCeiling: PercentString.optional(), absoluteMaximum: PercentString.optional(),
  approvalExpiryMinutes: z.number().int().optional(),
});

export const SetSkuCeilingRequest = z.object({ ceiling: PercentString.nullable() });
