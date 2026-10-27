import { corrections as contract } from '@gsa/contracts';
import { corrections } from '@gsa/services';
import { authedRoute } from '@/server/route';

/** The Corrections page: every session, newest first. */
export const GET = authedRoute(async ({ request, ctx }) => {
  const query = contract.ListCorrectionSessionsQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
  return Response.json(await corrections.listCorrectionSessions(ctx, query));
});

/**
 * COR-001: open a correction session. Exempt from Idempotency-Key, like the password endpoints: the body carries a
 * password, which an idempotency record would hash and keep. A retry is harmless — a second open is refused.
 */
export const POST = authedRoute(async ({ request, ctx }) => {
  const input = contract.OpenCorrectionSessionRequest.parse(await request.json());
  return Response.json(await corrections.openCorrectionSession(ctx, input), { status: 201 });
});
