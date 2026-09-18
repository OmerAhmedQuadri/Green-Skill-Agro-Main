import { schema } from '@gsa/db';
import { getDb } from '../runtime';

export type Health = { readonly database: 'ok'; readonly branch: string | null };

/** Liveness of the full path: service → db, as the runtime role. No auth. */
export async function checkHealth(): Promise<Health> {
  const [branch] = await getDb().select({ code: schema.branches.code }).from(schema.branches).limit(1);
  return { database: 'ok', branch: branch?.code ?? null };
}
