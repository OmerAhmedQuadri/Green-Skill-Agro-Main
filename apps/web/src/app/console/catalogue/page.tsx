import { notFound } from 'next/navigation';
import { CataloguePage } from '@/components/catalogue/CataloguePage';
import { catalogueCan } from '@/lib/can';
import { canSeeCatalogue } from '@/lib/navigation';
import { requireSession } from '@/server/session';

export default async function Page() {
  const ctx = await requireSession();
  if (!canSeeCatalogue(ctx.permissions)) notFound(); // USR-008: absent, not forbidden
  return <CataloguePage can={catalogueCan(ctx)} />;
}
