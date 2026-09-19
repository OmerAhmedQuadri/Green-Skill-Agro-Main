import { FieldOrderRequestScreen } from '@/components/dispatch/FieldOrderRequestScreen';

export default async function OrderPage({ params, searchParams }: { params: Promise<{ storeId: string }>; searchParams: Promise<{ shortfall?: string }> }) {
  const { storeId } = await params;
  const { shortfall } = await searchParams;
  return <FieldOrderRequestScreen storeId={storeId} shortfallOf={shortfall ?? null} />;
}
