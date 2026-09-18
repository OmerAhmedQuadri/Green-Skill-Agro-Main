import { notFound } from 'next/navigation';
import { PriceListView } from '@/components/pricing/PriceListView';
import { requireSession } from '@/server/session';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireSession();
  if (!ctx.permissions.has('pricing.manage_price_lists')) notFound();
  const { id } = await params;
  return <PriceListView id={id} />;
}
