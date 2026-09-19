import { notFound } from 'next/navigation';
import { AttendancePage } from '@/components/attendance/AttendancePage';
import { canSeeAttendance } from '@/lib/navigation';
import { requireSession } from '@/server/session';

export default async function Page() {
  const ctx = await requireSession();
  if (!canSeeAttendance(ctx.permissions)) notFound();
  return <AttendancePage canManage={ctx.permissions.has('attendance.manage')} />;
}
