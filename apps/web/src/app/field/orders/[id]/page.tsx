import { FieldOrderScreen } from '@/components/dispatch/FieldOrderScreen';

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <FieldOrderScreen id={id} />;
}
