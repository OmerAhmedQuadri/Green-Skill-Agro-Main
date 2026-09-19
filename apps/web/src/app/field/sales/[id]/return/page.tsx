import { ReturnScreen } from '@/components/returns/ReturnScreen';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ReturnScreen saleId={id} surface="field" />;
}
