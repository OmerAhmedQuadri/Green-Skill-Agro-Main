import { schema } from '@gsa/db';
import { sql } from 'drizzle-orm';
import type { Executor } from './transaction';

const { documentSequences } = schema;

/** Human-readable document numbers, one series per prefix and year: PO-2026-0007, WO-2026-0012. */
export async function nextDocumentNumber(db: Executor, prefix: string, now: Date): Promise<string> {
  const year = now.toISOString().slice(0, 4);
  const key = `${prefix}-${year}`;
  const [row] = await db.insert(documentSequences).values({ key, value: 1 })
    .onConflictDoUpdate({ target: documentSequences.key, set: { value: sql`${documentSequences.value} + 1` } })
    .returning({ value: documentSequences.value });
  return `${key}-${String(row?.value ?? 1).padStart(4, '0')}`;
}
