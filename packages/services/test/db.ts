import pg from 'pg';

// The owner connection exists only to reset state between tests — the code
// under test always runs as the runtime role.
let owner: pg.Pool | undefined;
const ownerPool = () => (owner ??= new pg.Pool({ connectionString: process.env.DATABASE_OWNER_URL, max: 2 }));

/** Clears everything except reference data (branches, warehouses, permissions, presets). */
export async function resetDatabase(): Promise<void> {
  await ownerPool().query('TRUNCATE users, sessions, user_permissions, audit_log, idempotency_keys, rate_limits CASCADE');
}

export async function ownerQuery<T extends pg.QueryResultRow>(text: string, values: unknown[] = []): Promise<T[]> {
  return (await ownerPool().query<T>(text, values)).rows;
}

export async function closeOwner(): Promise<void> {
  await owner?.end();
  owner = undefined;
}
