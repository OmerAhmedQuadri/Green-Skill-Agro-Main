import { notFound } from 'next/navigation';
import { StoragePage } from '@/components/storage/StoragePage';
import { canSeeStorage } from '@/lib/navigation';
import { requireSession } from '@/server/session';

/** ADR-0049: App management → Storage, for the Super Admin alone. */
export default async function Page() {
  const ctx = await requireSession();
  if (!canSeeStorage(ctx.permissions)) notFound();
  return <StoragePage />;
}
