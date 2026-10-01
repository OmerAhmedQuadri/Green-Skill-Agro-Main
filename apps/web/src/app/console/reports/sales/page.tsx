import { notFound } from 'next/navigation';
import { SalesAnalyticsPage } from '@/components/reports/SalesAnalyticsPage';
import { requireSession } from '@/server/session';

export default async function Page() {
  const ctx = await requireSession();
  // ADR-0048: the reports permission opens the page; the list of sales also needs every sale.
  if (!ctx.permissions.has('reports.view_trends')) notFound();
  return <SalesAnalyticsPage canListSales={ctx.permissions.has('sales.view_all')} />;
}
