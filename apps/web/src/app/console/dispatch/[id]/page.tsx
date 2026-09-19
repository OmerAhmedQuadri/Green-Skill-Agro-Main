import { notFound } from 'next/navigation';
import { DispatchDetail } from '@/components/dispatch/DispatchDetail';
import { canSeeDispatch } from '@/lib/navigation';
import { requireSession } from '@/server/session';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireSession();
  if (!canSeeDispatch(ctx.permissions)) notFound();
  const { id } = await params;
  return <DispatchDetail id={id} can={{ fulfil: ctx.permissions.has('sales.fulfil_dispatch'), decideClaims: ctx.permissions.has('sales.approve_lost_order'), me: ctx.user.id }} />;
}
