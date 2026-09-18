import { notFound } from 'next/navigation';
import { IncomingPage } from '@/components/procurement/IncomingPage';
import { canSeeIncoming } from '@/lib/navigation';
import { requireSession } from '@/server/session';

export default async function Page() {
  const ctx = await requireSession();
  if (!canSeeIncoming(ctx.permissions)) notFound();
  return <IncomingPage />;
}
