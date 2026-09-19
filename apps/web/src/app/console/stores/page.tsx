import { notFound } from 'next/navigation';
import { StoresPage } from '@/components/stores/StoresPage';
import { canSeeStores } from '@/lib/navigation';
import { requireSession } from '@/server/session';

export default async function Page() {
  const ctx = await requireSession();
  if (!canSeeStores(ctx.permissions)) notFound();
  return <StoresPage canApprove={ctx.permissions.has('stores.approve')} />;
}
