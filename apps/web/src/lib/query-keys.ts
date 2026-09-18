/** One key factory per context (CONVENTIONS §7), so invalidation is never a guess. */
export const keys = {
  productTypes: ['product-types'] as const,
  categories: ['categories'] as const,
  products: (filter?: object) => (filter ? ['products', filter] as const : ['products'] as const),
  product: (id: string) => ['product', id] as const,
  skus: (filter?: object) => (filter ? ['skus', filter] as const : ['skus'] as const),
  vendorCodes: ['vendor-codes'] as const,
  vendors: (filter?: object) => (filter ? ['vendors', filter] as const : ['vendors'] as const),
  vendor: (id: string) => ['vendor', id] as const,
  priceLists: ['price-lists'] as const,
  priceList: (id: string) => ['price-list', id] as const,
  discountCeilings: ['discount-ceilings'] as const,
  settings: ['settings'] as const,
  toggles: ['feature-toggles'] as const,
  ceilings: ['ceilings'] as const,
  commissionRates: ['commission-rates'] as const,
};
