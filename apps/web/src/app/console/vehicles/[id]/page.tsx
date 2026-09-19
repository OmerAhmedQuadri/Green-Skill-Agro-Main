import { notFound } from 'next/navigation';
import { VehicleDetail } from '@/components/vehicles/VehicleDetail';
import { canSeeVehicles } from '@/lib/navigation';
import { requireSession } from '@/server/session';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireSession();
  if (!canSeeVehicles(ctx.permissions)) notFound();
  const { id } = await params;
  return <VehicleDetail id={id} can={{ manage: ctx.permissions.has('vehicles.manage'), issue: ctx.permissions.has('inventory.issue_to_vehicle') }} />;
}
