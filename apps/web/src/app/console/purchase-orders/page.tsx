import { notFound } from 'next/navigation';
import { PurchaseOrdersPage } from '@/components/procurement/PurchaseOrdersPage';
import { canSeePurchaseOrders } from '@/lib/navigation';
import { requireSession } from '@/server/session';

export default async function Page() {
  const ctx = await requireSession();
  if (!canSeePurchaseOrders(ctx.permissions)) notFound();
  return <PurchaseOrdersPage canCreate={ctx.permissions.has('procurement.manage_po')} />;
}
