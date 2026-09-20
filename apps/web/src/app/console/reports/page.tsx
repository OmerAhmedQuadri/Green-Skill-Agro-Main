import { notFound } from 'next/navigation';
import { ReportsPage } from '@/components/reports/ReportsPage';
import { canSeeReports } from '@/lib/navigation';
import { requireSession } from '@/server/session';

export default async function Page() {
  const ctx = await requireSession();
  if (!canSeeReports(ctx.permissions)) notFound();
  return <ReportsPage canForecast={ctx.permissions.has('reports.view_forecast')} />;
}
