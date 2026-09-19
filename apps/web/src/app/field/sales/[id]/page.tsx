import { FieldSaleScreen } from '@/components/sales/FieldSaleScreen';

export default async function SalePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <FieldSaleScreen id={id} />;
}
