import { notFound } from 'next/navigation';
import { StructurePage } from '@/components/catalogue/StructurePage';
import { requireSession } from '@/server/session';

export default async function Page() {
  const ctx = await requireSession();
  if (!ctx.permissions.has('catalogue.manage_structure')) notFound();
  return <StructurePage />;
}
