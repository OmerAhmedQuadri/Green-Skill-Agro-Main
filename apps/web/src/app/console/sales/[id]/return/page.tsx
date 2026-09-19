import { notFound } from 'next/navigation';
import { ReturnScreen } from '@/components/returns/ReturnScreen';
import { requireSession } from '@/server/session';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireSession();
  if (!ctx.permissions.has('returns.process')) notFound();
  const { id } = await params;
  return <ReturnScreen saleId={id} surface="console" />;
}
