import { notFound } from 'next/navigation';
import { TargetsPage } from '@/components/targets/TargetsPage';
import { canSeeTargets } from '@/lib/navigation';
import { requireSession } from '@/server/session';

export default async function Page() {
  const ctx = await requireSession();
  if (!canSeeTargets(ctx.permissions)) notFound();
  return <TargetsPage canManage={ctx.permissions.has('targets.manage')} />;
}
