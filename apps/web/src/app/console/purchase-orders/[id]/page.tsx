import { notFound } from 'next/navigation';
import { PurchaseOrderView } from '@/components/procurement/PurchaseOrderView';
import { canSeePurchaseOrders } from '@/lib/navigation';
import { procurementCan } from '@/lib/procurement-can';
import { requireSession } from '@/server/session';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireSession();
  if (!canSeePurchaseOrders(ctx.permissions)) notFound();
  const { id } = await params;
  return <PurchaseOrderView id={id} can={procurementCan(ctx)} />;
}
