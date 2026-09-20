import { normalisePhone } from '@gsa/core';
import {
  columnOf, shapeOutliers, sheetRows, templateExamples, tidySkuCode, valueAt,
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

export type Assessment<T> = { readonly loadable: readonly T[]; readonly issues: readonly Issue[] };

export type CategoryRow = { readonly nameEn: string; readonly nameAr: string; readonly subEn: string; readonly subAr: string };
export type VendorRow = {
  readonly code: string; readonly name: string; readonly contact: string;
  readonly phone: string | null; readonly email: string | null; readonly country: string;
};
export type SkuRow = {
  readonly row: number; readonly code: string; readonly product: string; readonly variety: string;
  readonly packaging: string; readonly packSize: string; readonly unit: string; readonly price: string;
};
export type StoreRow = { readonly row: number; readonly name: string; readonly owner: string | null; readonly phone: string | null };

const issue = (sheet: string, row: number, kind: Issue['kind'], detail: string): Issue => ({ sheet, row, kind, detail });

/** Sheet 1. Three categories, each with a sub-category; the simplest sheet in the book. */
export function assessCategories(sheet: Sheet): Assessment<CategoryRow> {
  const rows = sheetRows(sheet);
  const at = {
    nameEn: columnOf(rows.headers, 'Category (English)'), nameAr: columnOf(rows.headers, 'Category (Arabic)'),
    subEn: columnOf(rows.headers, 'Sub-category (English)'), subAr: columnOf(rows.headers, 'Sub-category (Arabic)'),
  };
  const loadable: CategoryRow[] = [];
  const issues: Issue[] = [];
  for (const { row, cells } of rows.rows) {
    const record = {
      nameEn: valueAt(cells, at.nameEn), nameAr: valueAt(cells, at.nameAr),
      subEn: valueAt(cells, at.subEn), subAr: valueAt(cells, at.subAr),
    };
    const missing = Object.entries(record).filter(([, v]) => v === '').map(([k]) => k);
    if (missing.length > 0) issues.push(issue(rows.sheet, row, 'MISSING_REQUIRED_FIELD', `needs ${missing.join(', ')}`));
    else loadable.push(record);
  }
  return { loadable, issues };
}

/**
 * Sheet 2. Codes are unique and contacts are complete; phones lost their shape
 * to Excel and no vendor gave an address (CLIENT-DATA). A vendor loads without
 * either — neither is required to order from them — and the gaps are reported.
 */
export function assessVendors(sheet: Sheet): Assessment<VendorRow> {
  const rows = sheetRows(sheet);
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
    loadable.push({
      code, name, contact: valueAt(cells, at.contact), phone: tidied,
      email: valueAt(cells, at.email) || null, country: valueAt(cells, at.country),
    });
  }
  return { loadable, issues };
}

/**
 * Sheet 4. Every SKU needs a pack size and a price to be sellable. Rows of an
 * unusual shape are reported rather than dropped: a real row with a note reads
 * the same as the template's example with a note (CLIENT-DATA, `OKRA-PK-1KG`).
 */
export function assessSkus(sheet: Sheet): Assessment<SkuRow> {
  const rows = sheetRows(sheet);
  const at = {
    code: columnOf(rows.headers, 'SKU code'), product: columnOf(rows.headers, 'Product name (English)'),
    variety: columnOf(rows.headers, 'Variety name (English)'), packaging: columnOf(rows.headers, 'Packaging type'),
    packSize: columnOf(rows.headers, 'Pack size'), unit: columnOf(rows.headers, 'Unit'),
    price: columnOf(rows.headers, 'Base price'),
  };
  const odd = new Map(shapeOutliers(rows).map((o) => [o.row, o]));
  const loadable: SkuRow[] = [];
  const issues: Issue[] = [];
  const seen = new Set<string>();
  for (const { row, cells } of rows.rows) {
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
    if (odd.has(row)) {
      issues.push(issue(rows.sheet, row, 'LOOKS_LIKE_TEMPLATE_EXAMPLE', `${code} fills a different set of columns from the other rows — confirm it is a real SKU`));
      continue;
    }
    loadable.push({
      row, code, product: valueAt(cells, at.product), variety: valueAt(cells, at.variety),
      packaging: valueAt(cells, at.packaging), packSize, unit: valueAt(cells, at.unit), price,
    });
  }
  return { loadable, issues };
}

/**
 * Sheet 6. Names, and for some an owner or a phone. A store cannot trade
 * without a credit cycle and a seller (CRD-002, STO-006), so none of these load
 * as they stand: every one is a question, and the count is the answer Green
 * Agro has to give before the shop floor can use them (MIG-003, MIG-005).
 */
export function assessStores(sheet: Sheet): Assessment<StoreRow> {
  const rows = sheetRows(sheet);
  const at = {
    name: columnOf(rows.headers, 'Store name'), owner: columnOf(rows.headers, 'Owner name'),
    phone: columnOf(rows.headers, 'Phone'), cycle: columnOf(rows.headers, 'Credit cycle'),
    seller: columnOf(rows.headers, 'Assigned seller'),
  };
  const examples = templateExamples(rows, ['Credit cycle', 'Credit limit', 'Price list']);
  const issues: Issue[] = [];
  const ready: StoreRow[] = [];
  let namesOnly = 0;
  for (const { row, cells } of rows.rows) {
    if (examples.has(row)) {
      // Indistinguishable from a store Green Agro genuinely finished, so this
      // asks rather than asserts. In the workbook as received all three such
      // rows are the template's; if real stores are completed later they become
      // the majority and stop being read this way.
      issues.push(issue(rows.sheet, row, 'LOOKS_LIKE_TEMPLATE_EXAMPLE',
        'carries credit terms almost no other row has — confirm whether this is the template\'s example or a real store; not loaded either way'));
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
  return { loadable: ready, issues };
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
  readonly skus: Assessment<SkuRow>;
  readonly stores: Assessment<StoreRow>;
};

const find = (sheets: readonly Sheet[], name: string): Sheet => {
  const sheet = sheets.find((s) => s.sheet.toLowerCase().includes(name.toLowerCase()));
  if (!sheet) throw new Error(`the workbook has no "${name}" sheet`);
  return sheet;
};

/** The whole workbook, sheet by sheet. */
export function assess(sheets: readonly Sheet[]): Assessed {
  return {
    categories: assessCategories(find(sheets, 'Categories')),
    vendors: assessVendors(find(sheets, 'Vendors')),
    skus: assessSkus(find(sheets, 'SKUs')),
    stores: assessStores(find(sheets, 'Stores')),
  };
}

export type { Issue, Sheet, SheetRows };
