import { notFound } from 'next/navigation';
import { NewOrderPage } from '@/components/dispatch/NewOrderPage';
import { requireSession } from '@/server/session';

export default async function Page() {
  const ctx = await requireSession();
  if (!ctx.permissions.has('sales.create_order_for_seller')) notFound();
  return <NewOrderPage />;
}
