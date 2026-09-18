import { z } from 'zod';
import { MoneyString, PercentString } from './shared';

/** Keys and values are validated against the settings register in core (ADR-0024). */
export const UpdateSettingsRequest = z.object({
  changes: z.array(z.object({ key: z.string().max(100), value: z.union([z.string().max(100), z.number(), z.boolean()]) })).min(1).max(50),
});

export const UpdateTogglesRequest = z.object({
  changes: z.array(z.object({ key: z.string().max(100), enabled: z.boolean() })).min(1).max(20),
});

export const CeilingKind = z.enum(['CASH_IN_HAND', 'VEHICLE_STOCK_VALUE']);

/** LIM-001: a null seller is the global ceiling; a null amount removes the ceiling. */
export const SetCeilingRequest = z.object({ kind: CeilingKind, sellerId: z.uuid().nullable(), amount: MoneyString.nullable() });

/** SYS-008: null removes the seller's rates. */
export const SetCommissionRateRequest = z.object({
  rate: z.object({ onTarget: PercentString, belowTarget: PercentString }).nullable(),
});
