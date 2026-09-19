import { notFound } from 'next/navigation';
import { ReturnDetail } from '@/components/returns/ReturnDetail';
import { canSeeSales } from '@/lib/navigation';
import { requireSession } from '@/server/session';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireSession();
  if (!canSeeSales(ctx.permissions) && !ctx.permissions.has('returns.process')) notFound();
  const { id } = await params;
  return <ReturnDetail id={id} surface="console" />;
}
