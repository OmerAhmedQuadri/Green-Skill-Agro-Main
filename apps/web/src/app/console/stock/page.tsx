import { notFound } from 'next/navigation';
import { StockPage } from '@/components/inventory/StockPage';
import { canSeeStock } from '@/lib/navigation';
import { requireSession } from '@/server/session';

export default async function Page() {
  const ctx = await requireSession();
  if (!canSeeStock(ctx.permissions)) notFound();
  return <StockPage />;
}
