import { attendance } from '@gsa/services';
import { authedRoute } from '@/server/route';

export const GET = authedRoute(async ({ ctx }) => Response.json(await attendance.getToday(ctx)));
