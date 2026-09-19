import { attendance as contract } from '@gsa/contracts';
import { attendance } from '@gsa/services';
import { authedRoute } from '@/server/route';

/** Attendance, distance and active hours (`attendance.view`). */
export const GET = authedRoute(async ({ request, ctx }) => {
  const query = contract.ListAttendanceQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
  return Response.json(await attendance.listAttendance(ctx, query));
});
