import { notFound } from 'next/navigation';
import { NewProduct } from '@/components/catalogue/NewProduct';
import { requireSession } from '@/server/session';

export default async function Page() {
  const ctx = await requireSession();
  if (!ctx.permissions.has('catalogue.manage_products')) notFound();
  return <NewProduct />;
}
