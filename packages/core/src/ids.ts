declare const idBrand: unique symbol;

/**
 * Branded IDs (CONVENTIONS §2): passing a StoreId where a UserId is expected is
 * a compile error. Values are UUIDv7 strings.
 */
export type Id<Kind extends string> = string & { readonly [idBrand]: Kind };

export type UserId = Id<'User'>;
export type BranchId = Id<'Branch'>;
export type WarehouseId = Id<'Warehouse'>;
