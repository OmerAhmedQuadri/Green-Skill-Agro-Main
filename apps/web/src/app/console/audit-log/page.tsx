import { notFound } from 'next/navigation';
import { AuditLogPage } from '@/components/audit/AuditLogPage';
import { canSeeAuditLog } from '@/lib/navigation';
import { requireSession } from '@/server/session';

export default async function Page() {
  const ctx = await requireSession();
  if (!canSeeAuditLog(ctx.permissions)) notFound();
  return <AuditLogPage />;
}
