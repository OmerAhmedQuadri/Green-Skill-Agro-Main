import { DomainError, type Packaging } from '@gsa/core';
import {
  createCategory, createProduct, createSku, createSubCategory, createVariety,
  listCategories, listProductTypes, type ProductDetail, type SizeInput,
} from '../catalogue';
import type { Ctx } from '../context';
import { listPriceLists } from '../pricing';
import { assignVehicle, createVehicle } from '../vehicles';
import { createAccount } from '../identity';
import { createVendor } from '../vendors';
import type { Assessed, CategoryRow, ProductRow, SkuRow, UserRow, VehicleRow } from './assess';

/**
 * Loading the assessed workbook into the system (MIG-004).
 *
 * Everything goes through the ordinary use cases, exactly as if it had been
 * typed in: each record is validated, versioned and audited, and the audit
 * trail names whoever ran the import. Nothing writes to a table directly, so
 * there is no second definition of what a valid product is.
 *
 * The assessment is the first gate and the services are the second. A record
 * the assessment passed can still be refused here — a country the system does
 * not know, a Seeds product with no hybrid — and that is reported rather than
 * worked around. Where the two disagree the services win, because they are what
 * the running system enforces.
 *
 * **Records are loaded one at a time, not in one transaction.** A single
 * transaction would mean one bad row discards the other three hundred, and the
 * only thing anyone learns is that it failed. Loading each separately means a
 * run always ends with a complete account of what went in and what did not.
 * The cost is that a failed run leaves the system partly filled, so the
 * importer refuses to run twice: start again from an empty database.
 */

export type Refusal = {
  readonly sheet: string;
  readonly row: number;
  /** The domain error's code where there is one, so it can be looked up. */
  readonly code: string;
  readonly detail: string;
};

export type Loaded = {
  readonly categories: number; readonly subCategories: number; readonly vendors: number;
  readonly products: number; readonly varieties: number; readonly skus: number;
  readonly users: number; readonly vehicles: number; readonly assignments: number;
};

/**
 * A new account's first password. Returned rather than logged: it is a
 * credential, and CLAUDE.md is explicit that credentials do not go to a
 * terminal. Every one of these must be changed at first sign-in (USR-003).
 */
export type NewAccount = { readonly name: string; readonly identifier: string; readonly temporaryPassword: string };

export type LoadResult = {
  readonly loaded: Loaded;
  readonly refused: readonly Refusal[];
  readonly accounts: readonly NewAccount[];
};

/** The running count. `Loaded` is what the caller gets; this is what the run adds to. */
type Tally = { -readonly [K in keyof Loaded]: Loaded[K] };

const EMPTY: Tally = {
  categories: 0, subCategories: 0, vendors: 0, products: 0, varieties: 0, skus: 0, users: 0, vehicles: 0, assignments: 0,
};

const PACKAGING: Record<string, Packaging> = { can: 'CAN', pouch: 'POUCH', bag: 'BAG' };

/** Sheet 4 writes gm, kg or seeds; anything else is a refusal, never a guess at the unit. */
function sizeFor(row: SkuRow): SizeInput {
  const unit = row.unit.toLowerCase();
  if (unit === 'kg') return { measure: 'WEIGHT', value: row.packSize, unit: 'KG' };
  if (unit === 'gm' || unit === 'g') return { measure: 'WEIGHT', value: row.packSize, unit: 'G' };
  if (unit === 'seeds' || unit === 'seed') return { measure: 'COUNT', count: Number(row.packSize) };
  throw new DomainError('INVALID_IMPORT_FILE', { reason: `unit "${row.unit}"` });
}

const reasonFor = (error: unknown): { code: string; detail: string } => {
  if (error instanceof DomainError) return { code: error.code, detail: JSON.stringify(error.details ?? {}) };
  return { code: 'UNEXPECTED', detail: error instanceof Error ? error.message : String(error) };
};

/** Every record is attempted; a refusal is recorded against its row and the run goes on. */
async function attempt<T>(
  refused: Refusal[], sheet: string, row: number, what: () => Promise<T>,
): Promise<T | null> {
  try {
    return await what();
  } catch (error) {
    const { code, detail } = reasonFor(error);
    refused.push({ sheet, row, code, detail });
    return null;
  }
}

type Catalogue = {
  readonly subCategories: Map<string, { categoryId: string; subCategoryId: string }>;
  readonly vendors: Map<string, string>;
  readonly products: Map<string, { id: string; varieties: Map<string, string>; usesVarieties: boolean }>;
};

/**
 * MIG-004. Refuses outright if the catalogue already holds anything: running
 * twice would double every product, and a half-loaded database is not a base to
 * add to. Start from an empty one (`pnpm db:reset`).
 */
export async function loadWorkbook(ctx: Ctx, assessed: Assessed): Promise<LoadResult> {
  // Not a DomainError: no user ever sees this, and a code would need messages
  // in both languages for something only an operator at a terminal can hit.
  if ((await listCategories(ctx)).length > 0) {
    throw new Error('the catalogue already holds categories — import into an empty database (pnpm db:reset)');
  }
  const refused: Refusal[] = [];
  const loaded = { ...EMPTY };
  const { categories, vendors, products, skus, users, vehicles } = assessed;

  // Dependency order: a product names a category and a vendor, a SKU names a
  // product and its variety, a vehicle names a seller.
  const catalogue: Catalogue = { subCategories: new Map(), vendors: new Map(), products: new Map() };
  await loadStructure(ctx, categories.loadable, categories.sheet, catalogue, loaded, refused);
  await loadVendors(ctx, vendors.loadable, vendors.sheet, catalogue, loaded, refused);
  await loadProducts(ctx, products.loadable, products.sheet, catalogue, loaded, refused);
  await loadSkus(ctx, skus.loadable, skus.sheet, catalogue, loaded, refused);
  const accounts = await loadUsers(ctx, users.loadable, users.sheet, loaded, refused);
  await loadVehicles(ctx, vehicles.loadable, vehicles.sheet, loaded, refused);

  return { loaded, refused, accounts };
}

/**
 * Sheet 1 repeats its category once per sub-category, so the rows are folded
 * back into the structure they describe.
 */
async function loadStructure(
  ctx: Ctx, rows: readonly CategoryRow[], sheet: string, catalogue: Catalogue, loaded: Tally, refused: Refusal[],
) {
  const byName = new Map<string, string>();
  for (const [index, row] of rows.entries()) {
    const at = index + 5; // the sheet's own numbering, for a refusal someone can find
    let categoryId = byName.get(row.nameEn.toLowerCase());
    if (!categoryId) {
      const created = await attempt(refused, sheet, at, () => createCategory(ctx, { nameEn: row.nameEn, nameAr: row.nameAr }));
      if (!created) continue;
      categoryId = created.id;
      byName.set(row.nameEn.toLowerCase(), categoryId);
      loaded.categories += 1;
    }
    const withSub = await attempt(refused, sheet, at, () => createSubCategory(ctx, categoryId, { nameEn: row.subEn, nameAr: row.subAr }));
    if (!withSub) continue;
    loaded.subCategories += 1;
    for (const sub of withSub.subCategories) catalogue.subCategories.set(sub.nameEn.toLowerCase(), { categoryId, subCategoryId: sub.id });
  }
}

async function loadVendors(
  ctx: Ctx, rows: readonly Assessed['vendors']['loadable'][number][], sheet: string, catalogue: Catalogue,
  loaded: Tally, refused: Refusal[],
) {
  for (const [index, row] of rows.entries()) {
    const at = index + 5;
    const vendor = await attempt(refused, sheet, at, () => createVendor(ctx, {
      code: row.code, name: row.name, contactPerson: row.contact || null,
      phone: row.phone, email: row.email, country: row.country,
    }));
    if (!vendor) continue;
    catalogue.vendors.set(row.code.toLowerCase(), vendor.id);
    loaded.vendors += 1;
  }
}

async function loadProducts(
  ctx: Ctx, rows: readonly ProductRow[], sheet: string, catalogue: Catalogue,
  loaded: Tally, refused: Refusal[],
) {
  const types = await listProductTypes(ctx);

  for (const row of rows) {
    const type = types.find((t) => t.nameEn.toLowerCase() === row.productType.toLowerCase() || t.code.toLowerCase() === row.productType.toLowerCase());
    const place = catalogue.subCategories.get(row.subCategory.toLowerCase());
    // A missing vendor is named here rather than left to surface as the
    // product type's ATTRIBUTE_REQUIRED, which says nothing about the cause.
    const vendorId = row.vendorCode ? catalogue.vendors.get(row.vendorCode.toLowerCase()) ?? null : null;
    const missing = !type ? `no product type matches "${row.productType}"`
      : !place ? `sub-category "${row.subCategory}" was not loaded`
      : row.vendorCode && !vendorId ? `vendor ${row.vendorCode} was not loaded, so its products cannot be either`
      : null;
    if (missing || !type || !place) {
      refused.push({ sheet, row: row.row, code: 'NOT_FOUND', detail: missing ?? 'a reference was not loaded' });
      continue;
    }
    const product = await attempt(refused, sheet, row.row, () => createProduct(ctx, {
      productTypeId: type.id, ...place, nameEn: row.nameEn, nameAr: row.nameAr, hybrid: row.hybrid,
      countryOfOrigin: row.origin, vendorId, shelfLifeMonths: row.shelfLifeMonths,
    }));
    if (!product) continue;
    loaded.products += 1;

    let detail: ProductDetail = product;
    for (const variety of row.varieties) {
      const next = await attempt(refused, sheet, row.row, () => createVariety(ctx, product.id, variety));
      if (!next) continue;
      detail = next;
      loaded.varieties += 1;
    }
    catalogue.products.set(row.nameEn.toLowerCase(), {
      id: product.id,
      varieties: new Map(detail.varieties.map((v) => [v.nameEn.toLowerCase(), v.id])),
      usesVarieties: detail.productType.template.VARIETY !== 'HIDDEN',
    });
  }
}

/**
 * CAT-008: Green Skill Agro's own SKU codes are kept rather than regenerated. They
 * are printed on the packs and used in the warehouse, so the system adopting
 * them matters more than the codes it would have chosen.
 */
async function loadSkus(
  ctx: Ctx, rows: readonly SkuRow[], sheet: string, catalogue: Catalogue,
  loaded: Tally, refused: Refusal[],
) {
  const [base] = await listPriceLists(ctx);
  if (!base) throw new Error('no base price list — run pnpm db:sync first');

  for (const row of rows) {
    const product = catalogue.products.get(row.product.toLowerCase());
    if (!product) {
      refused.push({ sheet, row: row.row, code: 'NOT_FOUND', detail: `product "${row.product}" was not loaded` });
      continue;
    }
    const varietyId = product.usesVarieties ? product.varieties.get(row.variety.toLowerCase()) ?? null : null;
    if (product.usesVarieties && !varietyId) {
      refused.push({ sheet, row: row.row, code: 'NOT_FOUND', detail: `variety "${row.variety}" was not loaded for ${row.product}` });
      continue;
    }
    const packaging = PACKAGING[row.packaging.toLowerCase()];
    if (!packaging) {
      refused.push({ sheet, row: row.row, code: 'INVALID_IMPORT_FILE', detail: `packaging "${row.packaging}" is not Can, Pouch or Bag` });
      continue;
    }
    const created = await attempt(refused, sheet, row.row, async () => createSku(ctx, product.id, {
      varietyId, size: sizeFor(row), packaging, code: row.code,
      prices: [{ priceListId: base.id, price: row.price }],
    }));
    if (created) loaded.skus += 1;
  }
}

/**
 * USR-002/003: each account gets a temporary password it must change. The
 * passwords are returned to the caller, which writes them somewhere they can be
 * handed over — never to the terminal.
 */
async function loadUsers(
  ctx: Ctx, rows: readonly UserRow[], sheet: string, loaded: Tally, refused: Refusal[],
): Promise<NewAccount[]> {
  const accounts: NewAccount[] = [];
  for (const row of rows) {
    const created = await attempt(refused, sheet, row.row, () => createAccount(ctx, {
      role: row.role as Parameters<typeof createAccount>[1]['role'], name: row.name, email: row.email, phone: row.phone,
    }));
    if (!created) continue;
    loaded.users += 1;
    accounts.push({ name: row.name, identifier: row.email ?? row.phone ?? '', temporaryPassword: created.temporaryPassword });
  }
  return accounts;
}

async function loadVehicles(
  ctx: Ctx, rows: readonly VehicleRow[], sheet: string, loaded: Tally, refused: Refusal[],
) {
  const sellers = await sellersByName(ctx);
  for (const row of rows) {
    const vehicle = await attempt(refused, sheet, row.row, () => createVehicle(ctx, {
      registration: row.registration, description: row.description || null, odometer: row.odometer,
    }));
    if (!vehicle) continue;
    loaded.vehicles += 1;
    if (!row.assignee) continue;
    const sellerId = sellers.get(row.assignee.toLowerCase());
    if (!sellerId) {
      refused.push({ sheet, row: row.row, code: 'NOT_FOUND', detail: `${row.registration} names a seller who was not loaded; the vehicle loaded unassigned` });
      continue;
    }
    const assigned = await attempt(refused, sheet, row.row, () => assignVehicle(ctx, vehicle.id, { sellerId }));
    if (assigned) loaded.assignments += 1;
  }
}

/** The accounts just created, by the name the Vehicles sheet would have used. */
async function sellersByName(ctx: Ctx): Promise<Map<string, string>> {
  const { listSellers } = await import('../vehicles');
  return new Map((await listSellers(ctx)).map((s) => [s.name.toLowerCase(), s.id]));
}
