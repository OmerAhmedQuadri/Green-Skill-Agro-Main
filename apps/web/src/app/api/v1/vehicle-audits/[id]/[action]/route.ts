import { z } from 'zod';
import { vehicles as contract } from '@gsa/contracts';
import { vehicles } from '@gsa/services';
import { mutation } from '@/server/route';

type P = { id: string; action: string };

const Body = z.union([contract.RecordCountRequest, contract.CloseAuditRequest, contract.DecideSurplusRequest]);

/** VEH-011..013, OQ-022: counting, closing, and deciding a surplus. */
export const POST = mutation<typeof Body, P>(Body, async ({ ctx, params, input }) => {
  switch (params.action) {
    case 'count': return { status: 200, body: await vehicles.recordCount(ctx, params.id, contract.RecordCountRequest.parse(input)) };
    case 'close': return { status: 200, body: await vehicles.closeVehicleAudit(ctx, params.id, contract.CloseAuditRequest.parse(input)) };
    case 'surplus': return { status: 200, body: await vehicles.decideSurplus(ctx, params.id, contract.DecideSurplusRequest.parse(input)) };
    default: return { status: 404, body: { code: 'NOT_FOUND' } };
  }
});
