import { notFound } from 'next/navigation';
import { NewPurchaseOrder } from '@/components/procurement/NewPurchaseOrder';
import { requireSession } from '@/server/session';

export default async function Page() {
  const ctx = await requireSession();
  if (!ctx.permissions.has('procurement.manage_po')) notFound();
  return <NewPurchaseOrder />;
}
