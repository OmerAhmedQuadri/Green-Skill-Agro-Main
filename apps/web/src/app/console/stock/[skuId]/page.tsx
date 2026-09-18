import { notFound } from 'next/navigation';
import { SkuStockView } from '@/components/inventory/SkuStockView';
import { canSeeStock } from '@/lib/navigation';
import { requireSession } from '@/server/session';

export default async function Page({ params }: { params: Promise<{ skuId: string }> }) {
  const ctx = await requireSession();
  if (!canSeeStock(ctx.permissions)) notFound();
  const { skuId } = await params;
  return <SkuStockView skuId={skuId} />;
}
