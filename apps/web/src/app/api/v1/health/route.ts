import { ConfigError } from '@gsa/config';
import { checkHealth } from '@gsa/services';

/**
 * Thin handler: parse → one service call → HTTP (ADR-0017).
 *
 * The two failures are told apart deliberately. This used to answer
 * 'database: unreachable' to *any* error, so a malformed value in `.env` —
 * which stops the process configuring itself at all, and says exactly which
 * key is wrong — was reported as a database that was never down. The
 * operator then restarts Postgres, and the runbook tells them to.
 *
 * Which key it was goes to the log, not to an unauthenticated response.
 */
export async function GET() {
  try {
    return Response.json({ status: 'ok', ...(await checkHealth()) });
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error('[health] the process is misconfigured\n', error.message);
      return Response.json({ status: 'error', configuration: 'invalid' }, { status: 503 });
    }
    console.error('[health] the database could not be reached\n', error);
    return Response.json({ status: 'error', database: 'unreachable' }, { status: 503 });
  }
}
