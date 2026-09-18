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
