import { COUNTRY_CODES, normalisePhone } from '@gsa/core';
import type { ExampleRows } from './styles';
import {
  columnOf, sheetRows, tidySkuCode, valueAt,
  type Issue, type Sheet, type SheetRows,
} from './workbook';

/**
 * Turning the workbook's rows into records worth loading and questions worth
 * asking (MIG-001 assessment and cleansing).
 *
 * Each sheet returns what it is sure of and an issue for everything else. No
 * value is invented: a store with no credit terms cannot trade (CRD-002), so it
 * is a question, not a store with a guessed cycle.
 */

/** The sheet travels with its result: a refusal has to point somewhere a person can open. */
export type Assessment<T> = { readonly sheet: string; readonly loadable: readonly T[]; readonly issues: readonly Issue[] };

export type CategoryRow = { readonly nameEn: string; readonly nameAr: string; readonly subEn: string; readonly subAr: string };
export type VendorRow = {
  readonly code: string; readonly name: string; readonly contact: string;
  readonly phone: string | null; readonly email: string | null;
  /** ISO 3166-1 alpha-2, resolved from whatever the sheet called it. */
  readonly country: string;
};
export type SkuRow = {
  readonly row: number; readonly code: string; readonly product: string; readonly variety: string;
  readonly packaging: string; readonly packSize: string; readonly unit: string; readonly price: string;
};
export type StoreRow = { readonly row: number; readonly name: string; readonly owner: string | null; readonly phone: string | null };

const issue = (sheet: string, row: number, kind: Issue['kind'], detail: string): Issue => ({ sheet, row, kind, detail });

/**
 * The rows the template shaded as its own examples (`styles.ts`). Every sheet
 * is given the set rather than defaulting to none: a missing argument would
 * quietly mean "load the examples too", which is the mistake this replaced.
 */
const examplesOf = (examples: ExampleRows, sheet: string): ReadonlySet<number> => examples.get(sheet) ?? new Set();

/** Shaded rows are not loaded, and say so — the tint outlives being typed over. */
const exampleIssue = (sheet: string, row: number): Issue =>
  issue(sheet, row, 'LOOKS_LIKE_TEMPLATE_EXAMPLE', 'the template shaded this row as one of its own examples; not loaded');

/** Sheet 1. Three categories, each with a sub-category; the simplest sheet in the book. */
export function assessCategories(sheet: Sheet, examples: ExampleRows): Assessment<CategoryRow> {
  const rows = sheetRows(sheet);
  const shaded = examplesOf(examples, rows.sheet);
  const at = {
    nameEn: columnOf(rows.headers, 'Category (English)'), nameAr: columnOf(rows.headers, 'Category (Arabic)'),
    subEn: columnOf(rows.headers, 'Sub-category (English)'), subAr: columnOf(rows.headers, 'Sub-category (Arabic)'),
  };
  const loadable: CategoryRow[] = [];
  const issues: Issue[] = [];
  for (const { row, cells } of rows.rows) {
    if (shaded.has(row)) {
      issues.push(exampleIssue(rows.sheet, row));
      continue;
    }
    const record = {
      nameEn: valueAt(cells, at.nameEn), nameAr: valueAt(cells, at.nameAr),
      subEn: valueAt(cells, at.subEn), subAr: valueAt(cells, at.subAr),
    };
    const missing = Object.entries(record).filter(([, v]) => v === '').map(([k]) => k);
    if (missing.length > 0) issues.push(issue(rows.sheet, row, 'MISSING_REQUIRED_FIELD', `needs ${missing.join(', ')}`));
    else loadable.push(record);
  }
  return { sheet: rows.sheet, loadable, issues };
}

/**
 * Sheet 2. Codes are unique and contacts are complete; phones lost their shape
 * to Excel and no vendor gave an address (CLIENT-DATA). A vendor loads without
 * either — neither is required to order from them — and the gaps are reported.
 */
export function assessVendors(sheet: Sheet, examples: ExampleRows): Assessment<VendorRow> {
  const rows = sheetRows(sheet);
  const shaded = examplesOf(examples, rows.sheet);
  const at = {
    code: columnOf(rows.headers, 'Vendor code'), name: columnOf(rows.headers, 'Vendor name'),
    contact: columnOf(rows.headers, 'Contact person'), phone: columnOf(rows.headers, 'Phone'),
    email: columnOf(rows.headers, 'Email'), country: columnOf(rows.headers, 'Country'),
    address: columnOf(rows.headers, 'Address'),
  };
  const loadable: VendorRow[] = [];
  const issues: Issue[] = [];
  const seen = new Set<string>();
  for (const { row, cells } of rows.rows) {
    if (shaded.has(row)) {
      issues.push(exampleIssue(rows.sheet, row));
      continue;
    }
    const code = valueAt(cells, at.code);
    const name = valueAt(cells, at.name);
    if (!code || !name) {
      issues.push(issue(rows.sheet, row, 'MISSING_REQUIRED_FIELD', 'needs a vendor code and name'));
      continue;
    }
    if (seen.has(code.toLowerCase())) {
      issues.push(issue(rows.sheet, row, 'CONFLICTING_VALUE', `vendor code ${code} appears more than once`));
      continue;
    }
    seen.add(code.toLowerCase());
    const phone = valueAt(cells, at.phone);
    // Excel turned several phones into numbers, losing leading zeros and country codes.
    const tidied = phone ? safePhone(phone) : null;
    if (phone && !tidied) issues.push(issue(rows.sheet, row, 'NEEDS_CONFIRMATION', `the phone for ${code} is not a usable number`));
    if (!valueAt(cells, at.address)) issues.push(issue(rows.sheet, row, 'MISSING_REQUIRED_FIELD', `${code} has no address`));
    const raw = valueAt(cells, at.country);
    const country = countryFor(raw);
    if (!country) {
      issues.push(issue(rows.sheet, row, raw ? 'UNKNOWN_REFERENCE' : 'MISSING_REQUIRED_FIELD', raw
        ? `${code} gives its country as "${raw}", which is not a country name the system knows — the name as it appears on a map, or the two-letter code`
        : `${code} has no country`));
      continue;
    }
    loadable.push({
      code, name, contact: valueAt(cells, at.contact), phone: tidied,
      email: valueAt(cells, at.email) || null, country,
    });
  }
  return { sheet: rows.sheet, loadable, issues };
}

/**
 * Sheet 4. Every SKU needs a pack size and a price to be sellable. Rows of an
 * unusual shape are reported rather than dropped: a real row with a note reads
 * the same as the template's example with a note (CLIENT-DATA, `OKRA-PK-1KG`).
 */
export function assessSkus(sheet: Sheet, examples: ExampleRows): Assessment<SkuRow> {
  const rows = sheetRows(sheet);
  const shaded = examplesOf(examples, rows.sheet);
  const at = {
    code: columnOf(rows.headers, 'SKU code'), product: columnOf(rows.headers, 'Product name (English)'),
    variety: columnOf(rows.headers, 'Variety name (English)'), packaging: columnOf(rows.headers, 'Packaging type'),
    packSize: columnOf(rows.headers, 'Pack size'), unit: columnOf(rows.headers, 'Unit'),
    price: columnOf(rows.headers, 'Base price'),
  };
  const loadable: SkuRow[] = [];
  const issues: Issue[] = [];
  const seen = new Set<string>();
  for (const { row, cells } of rows.rows) {
    if (shaded.has(row)) {
      issues.push(exampleIssue(rows.sheet, row));
      continue;
    }
    const raw = valueAt(cells, at.code);
    const code = tidySkuCode(raw);
    if (!code) {
      issues.push(issue(rows.sheet, row, 'MISSING_REQUIRED_FIELD', 'needs a SKU code'));
      continue;
    }
    if (raw !== code) issues.push(issue(rows.sheet, row, 'NEEDS_CONFIRMATION', `${raw} has a stray space; loading as ${code}`));
    if (seen.has(code)) {
      issues.push(issue(rows.sheet, row, 'CONFLICTING_VALUE', `SKU code ${code} appears more than once`));
      continue;
    }
    seen.add(code);
    const packSize = valueAt(cells, at.packSize);
    const price = valueAt(cells, at.price);
    if (!packSize || !valueAt(cells, at.unit) || !price) {
      issues.push(issue(rows.sheet, row, 'MISSING_REQUIRED_FIELD', `${code} needs a pack size, unit and base price`));
      continue;
    }
    // The code carries its own size, so a code and a pack size that disagree is
    // the conflict CLIENT-DATA lists for confirmation, not something to average.
    if (disagreesWithCode(code, packSize, valueAt(cells, at.unit))) {
      issues.push(issue(rows.sheet, row, 'CONFLICTING_VALUE', `${code} says one pack size and the Pack size column says another`));
      continue;
    }
    loadable.push({
      row, code, product: valueAt(cells, at.product), variety: valueAt(cells, at.variety),
      packaging: valueAt(cells, at.packaging), packSize, unit: valueAt(cells, at.unit), price,
    });
  }
  return { sheet: rows.sheet, loadable, issues };
}

/**
 * Sheet 6. Names, and for some an owner or a phone. A store cannot trade
 * without a credit cycle and a seller (CRD-002, STO-006), so none of these load
 * as they stand: every one is a question, and the count is the answer Green
 * Agro has to give before the shop floor can use them (MIG-003, MIG-005).
 */
export function assessStores(sheet: Sheet, examples: ExampleRows): Assessment<StoreRow> {
  const rows = sheetRows(sheet);
  const shaded = examplesOf(examples, rows.sheet);
  const at = {
    name: columnOf(rows.headers, 'Store name'), owner: columnOf(rows.headers, 'Owner name'),
    phone: columnOf(rows.headers, 'Phone'), cycle: columnOf(rows.headers, 'Credit cycle'),
    seller: columnOf(rows.headers, 'Assigned seller'),
  };
  const issues: Issue[] = [];
  const ready: StoreRow[] = [];
  let namesOnly = 0;
  for (const { row, cells } of rows.rows) {
    if (shaded.has(row)) {
      issues.push(exampleIssue(rows.sheet, row));
      continue;
    }
    const name = valueAt(cells, at.name);
    if (!name) {
      issues.push(issue(rows.sheet, row, 'MISSING_REQUIRED_FIELD', 'needs a store name'));
      continue;
    }
    const phone = valueAt(cells, at.phone);
    if (!valueAt(cells, at.cycle) || !valueAt(cells, at.seller)) {
      namesOnly += 1;
      continue;
    }
    ready.push({ row, name, owner: valueAt(cells, at.owner) || null, phone: phone ? safePhone(phone) : null });
  }
  if (namesOnly > 0) {
    issues.push(issue(rows.sheet, 0, 'MISSING_REQUIRED_FIELD',
      `${namesOnly} stores have a name but no credit cycle or assigned seller, so none of them can trade yet — Green Agro supplies both, or they are entered fresh (MIG-005)`));
  }
  return { sheet: rows.sheet, loadable: ready, issues };
}

/**
 * Green Agro writes country names; the system stores ISO codes, and
 * `core/catalogue/countries.ts` keeps country names out of code on purpose.
 * `Intl` supplies the names, so the mapping is a property of the platform
 * rather than a list someone has to maintain.
 *
 * An informal name `Intl` does not know — "Holland" for the Netherlands — is a
 * question rather than a near-enough guess, and asking now beats a refusal
 * half way through the import.
 */
let countries: Map<string, string> | undefined;

function countryFor(value: string): string | null {
  if (!value) return null;
  if (!countries) {
    const names = new Intl.DisplayNames(['en'], { type: 'region' });
    countries = new Map();
    for (const code of COUNTRY_CODES) {
      countries.set(code.toLowerCase(), code);
      const name = names.of(code);
      if (name && name !== code) countries.set(name.toLowerCase(), code);
    }
  }
  return countries.get(value.trim().toLowerCase()) ?? null;
}

/** A phone Excel mangled is worth nothing; better absent than wrong. */
function safePhone(value: string): string | null {
  const digits = value.replace(/[^\d+]/g, '');
  // A placeholder like "1", or a number Excel rounded into scientific notation.
  if (digits.length < 7 || /e\+?\d/i.test(value)) return null;
  try {
    return normalisePhone(digits);
  } catch {
    return null;
  }
}

/** `BEAN-SN-1KG` says 1 kg; a Pack size column saying 50 g is the conflict, not the truth. */
function disagreesWithCode(code: string, packSize: string, unit: string): boolean {
  const fromCode = /-(\d+(?:\.\d+)?)(G|KG|S)$/i.exec(code);
  if (!fromCode) return false;
  const [, size, codeUnit] = fromCode;
  const grams = (value: string, measure: string) => (measure.toUpperCase() === 'KG' ? Number(value) * 1000 : Number(value));
  if ((codeUnit ?? '').toUpperCase() === 'S' || unit.toLowerCase() === 'seeds') return false;
  return grams(size ?? '0', codeUnit ?? 'G') !== grams(packSize, unit);
}

export type Assessed = {
  readonly categories: Assessment<CategoryRow>;
  readonly vendors: Assessment<VendorRow>;
  readonly products: Assessment<ProductRow>;
  readonly skus: Assessment<SkuRow>;
  readonly stores: Assessment<StoreRow>;
  readonly users: Assessment<UserRow>;
  readonly vehicles: Assessment<VehicleRow>;
};

const find = (sheets: readonly Sheet[], name: string): Sheet => {
  const sheet = sheets.find((s) => s.sheet.toLowerCase().includes(name.toLowerCase()));
  if (!sheet) throw new Error(`the workbook has no "${name}" sheet`);
  return sheet;
};

/**
 * The whole workbook, in the order the sheets depend on each other: products
 * name a category and a vendor, and vehicles name a user, so those are read
 * first and a reference to something absent is reported rather than invented.
 */
export function assess(sheets: readonly Sheet[], examples: ExampleRows): Assessed {
  const categories = assessCategories(find(sheets, 'Categories'), examples);
  const vendors = assessVendors(find(sheets, 'Vendors'), examples);
  const users = assessUsers(find(sheets, 'Users'), examples);
  return {
    categories,
    vendors,
    products: assessProducts(find(sheets, 'Products'), { categories: categories.loadable, vendors: vendors.loadable }, examples),
    skus: assessSkus(find(sheets, 'SKUs'), examples),
    stores: assessStores(find(sheets, 'Stores'), examples),
    users,
    vehicles: assessVehicles(find(sheets, 'Vehicles'), users.loadable, examples),
  };
}

/**
 * The sheets nobody has answered for: ones where every row is still the
 * template's, and ones no assessor reads.
 *
 * Silence is the failure mode worth guarding against. A sheet returned exactly
 * as it was sent looks, in a report that only lists problems, identical to a
 * sheet that was filled in perfectly — and Phase 1 has sheets whose defaults
 * decide real behaviour. The shading tells the two apart (`styles.ts`).
 */
export type SheetState = { readonly sheet: string; readonly rows: number; readonly shaded: number };
export type Survey = { readonly untouched: readonly SheetState[]; readonly unread: readonly SheetState[] };

export function survey(sheets: readonly Sheet[], examples: ExampleRows, assessed: Assessed): Survey {
  const read = new Set(Object.values(assessed).map((part: Assessment<unknown>) => part.sheet));
  const untouched: SheetState[] = [];
  const unread: SheetState[] = [];
  for (const sheet of sheets) {
    const rows = sheetRows(sheet);
    // The title sheet carries guidance, not data, so it is neither.
    if (rows.rows.length === 0 || rows.headers.every((h) => h === '')) continue;
    const shaded = examplesOf(examples, rows.sheet);
    const state = { sheet: rows.sheet, rows: rows.rows.length, shaded: rows.rows.filter(({ row }) => shaded.has(row)).length };
    // Counted rather than judged: a sheet whose every row is ours is certain,
    // and for the rest the count says how much of it is still ours — which is
    // a fact Green Agro can act on without anyone guessing on their behalf.
    if (state.shaded > 0 && state.shaded === state.rows) untouched.push(state);
    else if (!read.has(rows.sheet)) unread.push(state);
  }
  return { untouched, unread };
}

export type { ExampleRows } from './styles';
export type { Issue, Sheet, SheetRows };

export type ProductRow = {
  readonly row: number; readonly nameEn: string; readonly nameAr: string;
  readonly category: string; readonly subCategory: string; readonly productType: string;
  readonly vendorCode: string;
  /** ISO 3166-1 alpha-2, resolved from whatever the sheet called it. */
  readonly origin: string | null;
  readonly shelfLifeMonths: number | null;
  readonly hybrid: Hybrid | null;
  readonly varieties: readonly { readonly nameEn: string; readonly nameAr: string }[];
};

/** CAT-013: a Seeds product must say which it is, so the column is read, not inferred from the sub-category. */
export type Hybrid = 'HYBRID' | 'NON_HYBRID';

/**
 * Sheet 3. One row per SKU, so a product with four varieties appears four
 * times — expected, and the reason this folds rows into products rather than
 * reading each as its own (CLIENT-DATA: 33 products, 37 product–variety pairs).
 *
 * A product whose category or vendor is not in the workbook is a broken
 * reference, not something to create silently.
 */
export function assessProducts(
  sheet: Sheet,
  known: { readonly categories: readonly CategoryRow[]; readonly vendors: readonly VendorRow[] },
  examples: ExampleRows,
): Assessment<ProductRow> {
  const rows = sheetRows(sheet);
  const shaded = examplesOf(examples, rows.sheet);
  const at = {
    type: columnOf(rows.headers, 'Product type'), category: columnOf(rows.headers, 'Category'),
    sub: columnOf(rows.headers, 'Sub-category'), nameEn: columnOf(rows.headers, 'Product name (English)'),
    nameAr: columnOf(rows.headers, 'Product name (Arabic)'), varietyEn: columnOf(rows.headers, 'Variety name (English)'),
    varietyAr: columnOf(rows.headers, 'Variety name (Arabic)'), hybrid: columnOf(rows.headers, 'Hybrid'),
    origin: columnOf(rows.headers, 'Country of origin'), vendor: columnOf(rows.headers, 'Vendor code'),
    shelfLife: columnOf(rows.headers, 'Default shelf life'), shelfUnit: columnOf(rows.headers, 'Shelf life unit'),
  };
  const categories = new Set(known.categories.map((c) => c.nameEn.toLowerCase()));
  const subCategories = new Set(known.categories.map((c) => c.subEn.toLowerCase()));
  const vendors = new Set(known.vendors.map((v) => v.code.toLowerCase()));

  const byProduct = new Map<string, { row: number; product: ProductRow; varieties: Map<string, { nameEn: string; nameAr: string }> }>();
  const issues: Issue[] = [];

  for (const { row, cells } of rows.rows) {
    if (shaded.has(row)) {
      issues.push(exampleIssue(rows.sheet, row));
      continue;
    }
    const nameEn = valueAt(cells, at.nameEn);
    const nameAr = valueAt(cells, at.nameAr);
    if (!nameEn || !nameAr) {
      issues.push(issue(rows.sheet, row, 'MISSING_REQUIRED_FIELD', 'needs a product name in both languages'));
      continue;
    }
    const category = valueAt(cells, at.category);
    const subCategory = valueAt(cells, at.sub);
    const vendorCode = valueAt(cells, at.vendor);
    if (category && !categories.has(category.toLowerCase())) {
      issues.push(issue(rows.sheet, row, 'UNKNOWN_REFERENCE', `${nameEn} is in category "${category}", which the Categories sheet does not list`));
      continue;
    }
    if (subCategory && !subCategories.has(subCategory.toLowerCase())) {
      issues.push(issue(rows.sheet, row, 'UNKNOWN_REFERENCE', `${nameEn} is in sub-category "${subCategory}", which the Categories sheet does not list`));
      continue;
    }
    if (vendorCode && !vendors.has(vendorCode.toLowerCase())) {
      issues.push(issue(rows.sheet, row, 'UNKNOWN_REFERENCE', `${nameEn} names vendor ${vendorCode}, which the Vendors sheet does not list`));
      continue;
    }

    const rawOrigin = valueAt(cells, at.origin);
    const origin = countryFor(rawOrigin);
    if (rawOrigin && !origin) {
      issues.push(issue(rows.sheet, row, 'UNKNOWN_REFERENCE', `${nameEn} gives its country of origin as "${rawOrigin}", which is not a country name the system knows`));
      continue;
    }
    const months = shelfLifeMonths(valueAt(cells, at.shelfLife), valueAt(cells, at.shelfUnit));
    const hybrid = hybridOf(valueAt(cells, at.hybrid));
    const key = nameEn.toLowerCase();
    const existing = byProduct.get(key);
    const varietyEn = valueAt(cells, at.varietyEn);
    const variety = varietyEn ? { nameEn: varietyEn, nameAr: valueAt(cells, at.varietyAr) || varietyEn } : null;

    if (!existing) {
      const varieties = new Map<string, { nameEn: string; nameAr: string }>();
      if (variety) varieties.set(variety.nameEn.toLowerCase(), variety);
      byProduct.set(key, {
        row,
        product: {
          row, nameEn, nameAr, category, subCategory, productType: valueAt(cells, at.type),
          vendorCode, origin, shelfLifeMonths: months, hybrid, varieties: [],
        },
        varieties,
      });
      continue;
    }
    // The same product on a later row must not disagree with itself.
    if (existing.product.nameAr !== nameAr) {
      issues.push(issue(rows.sheet, row, 'CONFLICTING_VALUE', `${nameEn} has one Arabic name on row ${existing.row} and another here`));
    }
    if (existing.product.hybrid !== hybrid) {
      issues.push(issue(rows.sheet, row, 'CONFLICTING_VALUE', `${nameEn} is hybrid on row ${existing.row} and not here, or the other way round`));
    }
    if (variety) existing.varieties.set(variety.nameEn.toLowerCase(), variety);
  }

  const loadable = [...byProduct.values()].map(({ product, varieties }) => ({ ...product, varieties: [...varieties.values()] }));
  return { sheet: rows.sheet, loadable, issues };
}

/** "Non-hybrid" contains "hybrid", so the negative is tested first. */
const hybridOf = (value: string): Hybrid | null => {
  if (!value) return null;
  if (/non[-\s]?hybrid/i.test(value)) return 'NON_HYBRID';
  return /hybrid/i.test(value) ? 'HYBRID' : null;
};

const shelfLifeMonths = (value: string, unit: string): number | null => {
  const n = Number(value);
  if (!value || Number.isNaN(n) || n <= 0) return null;
  if (/month/i.test(unit)) return n;
  if (/year/i.test(unit)) return n * 12;
  if (/day/i.test(unit)) return Math.round(n / 30);
  return null;
};

export type UserRow = {
  readonly row: number; readonly name: string; readonly email: string | null;
  readonly phone: string | null; readonly role: string;
};

/**
 * Sheet 7. Four accounts. One seller signs in by phone rather than email
 * (ADR-0018), which is allowed, so an account needs a name, a role, and at
 * least one of the two ways to sign in.
 */
export function assessUsers(sheet: Sheet, examples: ExampleRows): Assessment<UserRow> {
  const rows = sheetRows(sheet);
  const shaded = examplesOf(examples, rows.sheet);
  const at = {
    name: columnOf(rows.headers, 'Full name'), email: columnOf(rows.headers, 'Email'),
    phone: columnOf(rows.headers, 'Phone'), role: columnOf(rows.headers, 'Role'),
  };
  // SUPER_ADMIN is a role of its own (ROLES); mapping it to ADMIN would quietly
  // demote the one account that can do everything.
  const roles = new Map([
    ['super admin', 'SUPER_ADMIN'], ['superadmin', 'SUPER_ADMIN'],
    ['admin', 'ADMIN'], ['manager', 'MANAGER'], ['seller', 'SELLER'],
  ]);
  const loadable: UserRow[] = [];
  const issues: Issue[] = [];
  const seen = new Set<string>();
  for (const { row, cells } of rows.rows) {
    if (shaded.has(row)) {
      issues.push(exampleIssue(rows.sheet, row));
      continue;
    }
    const name = valueAt(cells, at.name);
    const rawRole = valueAt(cells, at.role);
    const role = roles.get(rawRole.toLowerCase());
    if (!name || !rawRole) {
      issues.push(issue(rows.sheet, row, 'MISSING_REQUIRED_FIELD', 'needs a full name and a role'));
      continue;
    }
    if (!role) {
      issues.push(issue(rows.sheet, row, 'UNKNOWN_REFERENCE', `"${rawRole}" is not a role this system has`));
      continue;
    }
    const email = valueAt(cells, at.email) || null;
    const phone = valueAt(cells, at.phone) ? safePhone(valueAt(cells, at.phone)) : null;
    if (!email && !phone) {
      issues.push(issue(rows.sheet, row, 'MISSING_REQUIRED_FIELD', `${name} has neither an email nor a usable phone, so they cannot sign in`));
      continue;
    }
    const key = (email ?? phone ?? '').toLowerCase();
    if (seen.has(key)) {
      issues.push(issue(rows.sheet, row, 'CONFLICTING_VALUE', 'two accounts share the same email or phone'));
      continue;
    }
    seen.add(key);
    loadable.push({ row, name, email, phone, role });
  }
  return { sheet: rows.sheet, loadable, issues };
}

export type VehicleRow = {
  readonly row: number; readonly registration: string; readonly description: string;
  readonly odometer: number; readonly assignee: string | null;
};

/**
 * Sheet 8. Two vehicles. The assignee is a name typed by hand, so it is matched
 * against the accounts rather than trusted: one matches a user by first name
 * only and one matches nobody (CLIENT-DATA), and neither should quietly become
 * an assignment to the wrong seller.
 */
export function assessVehicles(sheet: Sheet, users: readonly UserRow[], examples: ExampleRows): Assessment<VehicleRow> {
  const rows = sheetRows(sheet);
  const shaded = examplesOf(examples, rows.sheet);
  const at = {
    registration: columnOf(rows.headers, 'Registration number'), description: columnOf(rows.headers, 'Description'),
    odometer: columnOf(rows.headers, 'Current odometer'), status: columnOf(rows.headers, 'Status'),
    assignee: columnOf(rows.headers, 'Currently assigned to'),
  };
  const loadable: VehicleRow[] = [];
  const issues: Issue[] = [];
  for (const { row, cells } of rows.rows) {
    if (shaded.has(row)) {
      issues.push(exampleIssue(rows.sheet, row));
      continue;
    }
    const registration = valueAt(cells, at.registration);
    if (!registration) {
      issues.push(issue(rows.sheet, row, 'MISSING_REQUIRED_FIELD', 'needs a registration number'));
      continue;
    }
    const odometer = Number(valueAt(cells, at.odometer));
    if (!valueAt(cells, at.odometer) || Number.isNaN(odometer) || odometer < 0) {
      issues.push(issue(rows.sheet, row, 'MISSING_REQUIRED_FIELD', `${registration} needs a current odometer reading — it is the baseline every day's distance is measured from`));
      continue;
    }
    const typed = valueAt(cells, at.assignee);
    const match = typed ? matchUser(typed, users) : null;
    if (typed && !match) {
      issues.push(issue(rows.sheet, row, 'UNKNOWN_REFERENCE', `${registration} is assigned to a name that matches no account on the Users sheet`));
    }
    if (match?.partial) {
      issues.push(issue(rows.sheet, row, 'NEEDS_CONFIRMATION', `${registration} is assigned by first name only — confirm which account is meant; the vehicle loads unassigned`));
    }
    // A first-name match is not an assignment: the vehicle carries a seller's
    // whole stock, and a manager assigns one in seconds (MIG-005, VEH-002).
    loadable.push({
      row, registration, description: valueAt(cells, at.description), odometer,
      assignee: match && !match.partial ? match.name : null,
    });
  }
  return { sheet: rows.sheet, loadable, issues };
}

/** A hand-typed name against the accounts: only an exact match is an assignment. */
function matchUser(typed: string, users: readonly UserRow[]): { name: string; partial: boolean } | null {
  const wanted = typed.trim().toLowerCase();
  const exact = users.find((u) => u.name.toLowerCase() === wanted);
  if (exact) return { name: exact.name, partial: false };
  const byFirst = users.filter((u) => u.name.toLowerCase().split(/\s+/)[0] === wanted.split(/\s+/)[0]);
  return byFirst.length === 1 && byFirst[0] ? { name: byFirst[0].name, partial: true } : null;
}
