declare const idBrand: unique symbol;

/**
 * Branded IDs (CONVENTIONS §2): passing a StoreId where a UserId is expected is
 * a compile error. Values are UUIDv7 strings.
 */
export type Id<Kind extends string> = string & { readonly [idBrand]: Kind };

export type UserId = Id<'User'>;
export type BranchId = Id<'Branch'>;
export type WarehouseId = Id<'Warehouse'>;
export type CategoryId = Id<'Category'>;
export type SubCategoryId = Id<'SubCategory'>;
export type ProductTypeId = Id<'ProductType'>;
export type ProductId = Id<'Product'>;
export type VarietyId = Id<'Variety'>;
export type SkuId = Id<'Sku'>;
export type VendorId = Id<'Vendor'>;
export type PriceListId = Id<'PriceList'>;
export type BatchId = Id<'Batch'>;
export type PurchaseOrderId = Id<'PurchaseOrder'>;
export type GoodsReceiptId = Id<'GoodsReceipt'>;
