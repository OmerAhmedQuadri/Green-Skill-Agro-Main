import { FieldSaleScreen } from '@/components/sales/FieldSaleScreen';
import { requireSession } from '@/server/session';

export default async function SalePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireSession();
  const { id } = await params;
  return <FieldSaleScreen id={id} canReturn={ctx.permissions.has('returns.process')} />;
}
