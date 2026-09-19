import { attendance as contract } from '@gsa/contracts';
import { attendance } from '@gsa/services';
import { mutation } from '@/server/route';

type P = { id: string };

export const PATCH = mutation<typeof contract.UpdateZoneRequest, P>(contract.UpdateZoneRequest, async ({ ctx, params, input }) => ({
  status: 200, body: await attendance.updateZone(ctx, params.id, input),
}));
