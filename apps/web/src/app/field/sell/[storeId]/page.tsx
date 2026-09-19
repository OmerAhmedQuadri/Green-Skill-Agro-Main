import { SellScreen } from '@/components/sales/SellScreen';

export default async function SellPage({ params, searchParams }: { params: Promise<{ storeId: string }>; searchParams: Promise<{ from?: string; shortfall?: string }> }) {
  const { storeId } = await params;
  const { from, shortfall } = await searchParams;
  return <SellScreen storeId={storeId} fromSaleId={from ?? null} shortfallOf={shortfall ?? null} />;
}
