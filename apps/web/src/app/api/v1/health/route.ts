import { checkHealth } from '@gsa/services';

// Thin handler: parse → one service call → HTTP (ADR-0017).
export async function GET() {
  try {
    return Response.json({ status: 'ok', ...(await checkHealth()) });
  } catch {
    return Response.json({ status: 'error', database: 'unreachable' }, { status: 503 });
  }
}
