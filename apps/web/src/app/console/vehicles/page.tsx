import { notFound } from 'next/navigation';
import { VehiclesPage } from '@/components/vehicles/VehiclesPage';
import { canSeeVehicles } from '@/lib/navigation';
import { requireSession } from '@/server/session';

export default async function Page() {
  const ctx = await requireSession();
  if (!canSeeVehicles(ctx.permissions)) notFound();
  return <VehiclesPage canManage={ctx.permissions.has('vehicles.manage')} />;
}
