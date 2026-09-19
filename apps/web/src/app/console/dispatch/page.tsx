import { notFound } from 'next/navigation';
import { DispatchPage } from '@/components/dispatch/DispatchPage';
import { canSeeDispatch } from '@/lib/navigation';
import { requireSession } from '@/server/session';

export default async function Page() {
  const ctx = await requireSession();
  if (!canSeeDispatch(ctx.permissions)) notFound();
  return <DispatchPage canCreate={ctx.permissions.has('sales.create_order_for_seller')} />;
}
