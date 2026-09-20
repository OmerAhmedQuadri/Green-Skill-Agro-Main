import { vehicles } from '@gsa/services';
import { notFound } from 'next/navigation';
import { AuditsPage } from '@/components/audits/AuditsPage';
import { canSeeAudits } from '@/lib/navigation';
import { requireSession } from '@/server/session';

export default async function Page() {
  const ctx = await requireSession();
  if (!canSeeAudits(ctx.permissions)) notFound();
  // VEH-015: derived when read, like an unconfirmed dispatch.
  const overdue = await vehicles.overdueAudits(ctx);
  return <AuditsPage overdue={overdue} canAudit={ctx.permissions.has('inventory.audit_vehicle')} />;
}
