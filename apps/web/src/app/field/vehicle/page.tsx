import { system } from '@gsa/services';
import { MyVehicleScreen } from '@/components/field/MyVehicleScreen';
import { requireSession } from '@/server/session';

export default async function MyVehiclePage() {
  const ctx = await requireSession();
  const toggles = await system.readToggles();
  return (
    <MyVehicleScreen userId={ctx.user.id} canWriteOff={ctx.permissions.has('inventory.submit_write_off')}
      canConvert={ctx.permissions.has('inventory.convert') && toggles['inventory.seller_conversion']} />
  );
}
