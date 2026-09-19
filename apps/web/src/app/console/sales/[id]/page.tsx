import { notFound } from 'next/navigation';
import { SaleDetail } from '@/components/sales/SaleDetail';
import { canSeeSales } from '@/lib/navigation';
import { requireSession } from '@/server/session';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireSession();
  if (!canSeeSales(ctx.permissions)) notFound();
  const { id } = await params;
  return <SaleDetail id={id} canDecide={ctx.permissions.has('sales.approve_discount')} canReturn={ctx.permissions.has('returns.process')} />;
}
