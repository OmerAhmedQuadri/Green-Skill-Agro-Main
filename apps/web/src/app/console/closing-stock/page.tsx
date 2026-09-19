import { notFound } from 'next/navigation';
import { ClosingStockPage } from '@/components/vehicles/ClosingStockPage';
import { canSeeClosingStock } from '@/lib/navigation';
import { requireSession } from '@/server/session';

export default async function Page() {
  const ctx = await requireSession();
  if (!canSeeClosingStock(ctx.permissions)) notFound();
  return <ClosingStockPage />;
}
