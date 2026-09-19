import { ReturnDetail } from '@/components/returns/ReturnDetail';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ReturnDetail id={id} surface="field" />;
}
