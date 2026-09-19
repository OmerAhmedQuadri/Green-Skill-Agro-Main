import { FieldStoreScreen } from '@/components/stores/FieldStoreScreen';

export default async function StorePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <FieldStoreScreen id={id} />;
}
