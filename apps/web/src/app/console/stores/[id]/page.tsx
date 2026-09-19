import { notFound } from 'next/navigation';
import { StoreDetail } from '@/components/stores/StoreDetail';
import { canSeeStores } from '@/lib/navigation';
import { requireSession } from '@/server/session';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireSession();
  if (!canSeeStores(ctx.permissions)) notFound();
  const { id } = await params;
  const p = ctx.permissions;
  return (
    <StoreDetail id={id} can={{
      approve: p.has('stores.approve'), editTerms: p.has('stores.edit_terms'), reassign: p.has('stores.reassign'),
      override: p.has('stores.override_credit_block'), adjust: p.has('stores.adjust_balance'),
    }} />
  );
}
