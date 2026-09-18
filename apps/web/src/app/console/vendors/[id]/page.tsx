import { notFound } from 'next/navigation';
import { VendorView } from '@/components/vendors/VendorView';
import { canSeeVendors } from '@/lib/navigation';
import { requireSession } from '@/server/session';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireSession();
  if (!canSeeVendors(ctx.permissions)) notFound(); // VEN-005: without vendor access there is no profile to open
  const { id } = await params;
  return <VendorView id={id} canManage={ctx.permissions.has('vendors.manage')} />;
}
