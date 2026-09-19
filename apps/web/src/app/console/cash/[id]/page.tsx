import { notFound } from 'next/navigation';
import { SettlementDetail } from '@/components/cash/SettlementDetail';
import { canSeeCash } from '@/lib/navigation';
import { requireSession } from '@/server/session';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireSession();
  if (!canSeeCash(ctx.permissions)) notFound();
  const { id } = await params;
  return <SettlementDetail id={id} surface="console" canDecide={ctx.permissions.has('cash.approve_settlement')} />;
}
