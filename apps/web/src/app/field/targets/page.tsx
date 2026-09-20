import { notFound } from 'next/navigation';
import { MyTargets } from '@/components/targets/MyTargets';
import { requireSession } from '@/server/session';

export default async function Page() {
  const ctx = await requireSession();
  // TGT-004: every seller may see their own month; nobody else's.
  if (!ctx.permissions.has('targets.view_own')) notFound();
  return <MyTargets />;
}
