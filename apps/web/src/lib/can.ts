import type { Ctx } from '@gsa/services';
import type { CatalogueCan } from '@/components/catalogue/types';

/** What the catalogue screens may offer this user. The services decide; these only hide (ADR-0005). */
export const catalogueCan = (ctx: Ctx): CatalogueCan => ({
  manageProducts: ctx.permissions.has('catalogue.manage_products'),
  manageStructure: ctx.permissions.has('catalogue.manage_structure'),
  viewVendors: ctx.permissions.has('vendors.view'),
  managePrices: ctx.permissions.has('pricing.manage_price_lists'),
});
