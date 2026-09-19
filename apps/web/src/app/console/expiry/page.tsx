import { notFound } from 'next/navigation';
import { ExpiryPage } from '@/components/warehouse/ExpiryPage';
import { canSeeExpiry } from '@/lib/navigation';
import { requireSession } from '@/server/session';

export default async function Page() {
  const ctx = await requireSession();
  if (!canSeeExpiry(ctx.permissions)) notFound();
  return <ExpiryPage canPrioritise={ctx.permissions.has('inventory.manage_expiry')} />;
}
