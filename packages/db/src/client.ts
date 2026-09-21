import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

export type Db = ReturnType<typeof createDb>;

export type DbLimits = {
  /**
   * How long a caller may wait for a free connection before failing.
   *
   * `pg.Pool` waits for ever by default. With every connection busy, a request
   * then hangs rather than erroring: no response, no log, no retry, and
   * nothing to find afterwards. Ten such requests take the whole application
   * down silently. Seen for real in the browser suite, where two ticket
   * requests never returned at all.
   */
  readonly connectionTimeoutMillis?: number;
  /**
   * How long one statement may run before the server cancels it. Bounds the
   * damage a runaway query can do: without it, one holds its connection for
   * ever and the pool never recovers.
   */
  readonly statementTimeoutMillis?: number;
};

/**
 * Limits are per caller, not baked in here, because the migration runner uses
 * this too and a migration may legitimately spend minutes building an index.
 * Cancelling one half way through a deployment would be its own disaster.
 */
export function createDb(connectionString: string, limits: DbLimits = {}) {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    ...(limits.connectionTimeoutMillis === undefined ? {} : { connectionTimeoutMillis: limits.connectionTimeoutMillis }),
    // A server-side setting sent with the startup packet, so it is in force on
    // the first query — a `SET` after connecting races the first caller.
    ...(limits.statementTimeoutMillis === undefined ? {} : { options: `-c statement_timeout=${limits.statementTimeoutMillis}` }),
  });
  return drizzle({ client: pool, schema });
}
