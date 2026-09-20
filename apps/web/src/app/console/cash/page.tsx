import { notFound } from 'next/navigation';
import { CashPage } from '@/components/cash/CashPage';
import { canSeeCash } from '@/lib/navigation';
import { requireSession } from '@/server/session';

export default async function Page() {
  const ctx = await requireSession();
  if (!canSeeCash(ctx.permissions)) notFound();
  return <CashPage />;
}
