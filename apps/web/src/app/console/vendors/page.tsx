import { notFound } from 'next/navigation';
import { VendorsPage } from '@/components/vendors/VendorsPage';
import { canSeeVendors } from '@/lib/navigation';
import { requireSession } from '@/server/session';

export default async function Page() {
  const ctx = await requireSession();
  if (!canSeeVendors(ctx.permissions)) notFound(); // VEN-003
  return <VendorsPage canManage={ctx.permissions.has('vendors.manage')} />;
}
