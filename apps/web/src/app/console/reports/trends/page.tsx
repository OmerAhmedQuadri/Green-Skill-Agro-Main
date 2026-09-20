import { notFound } from 'next/navigation';
import { TrendsScreen } from '@/components/reports/TrendsScreen';
import { requireSession } from '@/server/session';

export default async function Page() {
  const ctx = await requireSession();
  if (!ctx.permissions.has('reports.view_trends')) notFound();
  return <TrendsScreen />;
}
