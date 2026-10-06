import { notFound } from 'next/navigation';
import { ClosingStockPage } from '@/components/vehicles/ClosingStockPage';
import { CLOSING_STATUSES } from '@/components/vehicles/types';
import { canSeeClosingStock } from '@/lib/navigation';
import { requireSession } from '@/server/session';

export default async function Page({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const ctx = await requireSession();
  if (!canSeeClosingStock(ctx.permissions)) notFound();
  const { status } = await searchParams;
  return <ClosingStockPage initialStatus={CLOSING_STATUSES.find((s) => s === status) ?? ''} />;
}
