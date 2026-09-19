import { notFound } from 'next/navigation';
import { SalesPage } from '@/components/sales/SalesPage';
import { canSeeSales } from '@/lib/navigation';
import { requireSession } from '@/server/session';

export default async function Page() {
  const ctx = await requireSession();
  if (!canSeeSales(ctx.permissions)) notFound();
  return <SalesPage canDecide={ctx.permissions.has('sales.approve_discount')} />;
}
