import { z } from 'zod';

/** Money travels as a decimal string in SAR (ADR-0003); the service validates it exactly. */
export const MoneyString = z.string().trim().regex(/^\d{1,12}(\.\d{1,2})?$/);
/** 0–100, up to three decimals, as a string — never a JS number (ADR-0003). */
export const PercentString = z.string().trim().regex(/^\d{1,3}(\.\d{1,3})?$/);

export const NameEn = z.string().trim().min(1).max(120);
export const NameAr = z.string().trim().min(1).max(120);
export const Version = z.number().int().min(1);

/** Query-string booleans. */
export const QueryBoolean = z.enum(['true', 'false']).transform((v) => v === 'true');
export const Limit = z.coerce.number().int().min(1).max(200);

/** An optional free-text field: blank becomes null. */
export const OptionalText = (max: number) =>
  z.string().trim().max(max).nullable().optional().transform((v) => (v === undefined ? undefined : v || null));
