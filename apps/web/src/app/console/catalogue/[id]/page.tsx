import { notFound } from 'next/navigation';
import { ProductView } from '@/components/catalogue/ProductView';
import { catalogueCan } from '@/lib/can';
import { canSeeCatalogue } from '@/lib/navigation';
import { requireSession } from '@/server/session';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireSession();
  if (!canSeeCatalogue(ctx.permissions)) notFound();
  const { id } = await params;
  return <ProductView id={id} can={catalogueCan(ctx)} />;
}
