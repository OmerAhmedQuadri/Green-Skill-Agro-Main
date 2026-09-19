import { notFound } from 'next/navigation';
import { WriteOffsPage } from '@/components/warehouse/WriteOffsPage';
import { canSeeWriteOffs } from '@/lib/navigation';
import { requireSession } from '@/server/session';

export default async function Page() {
  const ctx = await requireSession();
  if (!canSeeWriteOffs(ctx.permissions)) notFound();
  return <WriteOffsPage canDecide={ctx.permissions.has('inventory.approve_write_off')} userId={ctx.user.id} />;
}
