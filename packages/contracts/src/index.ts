import { z } from 'zod';

/** `application/problem+json` body for every API error (ARCHITECTURE §6.9). */
export const Problem = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
  requestId: z.string().optional(),
});
export type Problem = z.infer<typeof Problem>;

/** Cursor-paginated list envelope (CONVENTIONS §5). */
export const page = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });

export * as identity from './identity';
export * as media from './media';
export * as catalogue from './catalogue';
export * as vendors from './vendors';
export * as pricing from './pricing';
export * as system from './system';
export * as procurement from './procurement';
export * as inventory from './inventory';
export * as warehouse from './warehouse';
export * as vehicles from './vehicles';
export * as attendance from './attendance';
export * as notifications from './notifications';
export * as stores from './stores';
