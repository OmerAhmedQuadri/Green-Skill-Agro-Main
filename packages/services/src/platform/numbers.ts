import { schema } from '@gsa/db';
import { sql } from 'drizzle-orm';
import type { Executor } from './transaction';

const { documentSequences } = schema;

/**
 * Human-readable document numbers, one series per prefix and year: PO-2026-0007,
 * DN-2026-000123. Gapless (ADR-0019): the counter row stays locked until the
 * caller's transaction ends, and a rollback takes its number back with it.
 */
export async function nextDocumentNumber(db: Executor, prefix: string, now: Date, digits = 4): Promise<string> {
  const year = now.toISOString().slice(0, 4);
  const key = `${prefix}-${year}`;
  const [row] = await db.insert(documentSequences).values({ key, value: 1 })
    .onConflictDoUpdate({ target: documentSequences.key, set: { value: sql`${documentSequences.value} + 1` } })
    .returning({ value: documentSequences.value });
  return `${key}-${String(row?.value ?? 1).padStart(digits, '0')}`;
}
