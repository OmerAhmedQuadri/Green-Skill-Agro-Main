import type { catalogue, pricing, vendors } from '@gsa/services';

// Response shapes come from the services that produce them; `import type` keeps server code out of the bundle.
export type ProductType = catalogue.ProductType;
export type Category = catalogue.Category;
export type ProductSummary = catalogue.ProductSummary;
export type ProductDetail = catalogue.ProductDetail;
export type SkuSummary = catalogue.SkuSummary;
export type PriceList = pricing.PriceList;
export type VendorCode = Awaited<ReturnType<typeof vendors.listVendorCodes>>[number];
export type Page<T> = { items: T[]; nextCursor: string | null };

export type CatalogueCan = {
  manageProducts: boolean; manageStructure: boolean; viewVendors: boolean; managePrices: boolean;
};
