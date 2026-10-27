import { notFound } from 'next/navigation';
import { CorrectionsPage } from '@/components/corrections/CorrectionsPage';
import { canSeeCorrections } from '@/lib/navigation';
import { requireSession } from '@/server/session';

/** ADR-0059: every correction session, for whoever corrects history or reads the audit log. */
export default async function Page() {
  const ctx = await requireSession();
  if (!canSeeCorrections(ctx.permissions)) notFound();
  return <CorrectionsPage />;
}
