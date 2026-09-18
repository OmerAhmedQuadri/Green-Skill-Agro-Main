import type { Ctx } from '@gsa/services';
import type { ProcurementCan } from '@/components/procurement/types';

/** What the procurement screens may offer. The services decide; these only hide (ADR-0005). */
export const procurementCan = (ctx: Ctx): ProcurementCan => ({
  manage: ctx.permissions.has('procurement.manage_po'),
  approve: ctx.permissions.has('procurement.approve_po'),
  receive: ctx.permissions.has('inventory.receive_goods'),
  import: ctx.permissions.has('inventory.bulk_import'),
});
