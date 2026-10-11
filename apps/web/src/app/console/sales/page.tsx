import { notFound } from 'next/navigation';
import { SalesPage } from '@/components/sales/SalesPage';
import { canSeeSales } from '@/lib/navigation';
import { requireSession } from '@/server/session';

export default async function Page({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const ctx = await requireSession();
  if (!canSeeSales(ctx.permissions)) notFound();
  const { status } = await searchParams;
  return <SalesPage canDecide={ctx.permissions.has('sales.approve_discount') || ctx.permissions.has('sales.approve_open_sale')} initialFilter={status ?? ''} />;
}
