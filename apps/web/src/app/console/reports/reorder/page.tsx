import { notFound } from 'next/navigation';
import { ReorderScreen } from '@/components/reports/ReorderScreen';
import { requireSession } from '@/server/session';

export default async function Page() {
  const ctx = await requireSession();
  // RPT-004: the import plan is not something a seller or a store-side manager sees.
  if (!ctx.permissions.has('reports.view_forecast')) notFound();
  return <ReorderScreen />;
}
