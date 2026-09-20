import { notFound } from 'next/navigation';
import { AuditDetail } from '@/components/audits/AuditDetail';
import { canSeeAudits } from '@/lib/navigation';
import { requireSession } from '@/server/session';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireSession();
  if (!canSeeAudits(ctx.permissions)) notFound();
  const { id } = await params;
  return <AuditDetail id={id} canDecideSurplus={ctx.permissions.has('inventory.approve_write_off')} />;
}
