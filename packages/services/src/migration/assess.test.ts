import { describe, expect, it } from 'vitest';
import { assessCategories, assessSkus, assessStores, assessVendors } from './assess';
import { HEADER_ROW, type Cell, type Sheet } from './workbook';

/** Synthetic, shaped like the workbook: client data never enters the repo. */
const aSheet = (name: string, headers: string[], rows: Cell[][]): Sheet => ({
  sheet: name,
  data: [[null], ['title'], ['guidance'], headers, ...rows],
});
const STORE_HEADERS = ['Store name', 'Owner name', 'Phone', 'Store category', 'Address', 'City', 'Credit cycle', 'Custom cycle (days)', 'Credit limit (SAR)', 'Price list', 'Assigned seller'];
const SKU_HEADERS = ['SKU code', 'Product name (English)', 'Variety name (English)', 'Packaging type', 'Pack size', 'Unit', 'Base price (SAR)', 'Notes'];

describe('assessing the workbook (MIG-001, MIG-003, MIG-005)', () => {
  it('headers land where the template puts them', () => {
    expect(HEADER_ROW).toBe(3);
  });

  it('MIG-001: a complete category loads; a half-filled one is a question', () => {
    const sheet = aSheet('1. Categories', ['Category (English)', 'Category (Arabic)', 'Sub-category (English)', 'Sub-category (Arabic)'], [
      ['Seeds', 'بذور', 'Hybrid', 'هجين'],
      ['Essentials', 'أساسيات', 'Nets', null],
    ]);
    const { loadable, issues } = assessCategories(sheet);
    expect(loadable).toEqual([{ nameEn: 'Seeds', nameAr: 'بذور', subEn: 'Hybrid', subAr: 'هجين' }]);
    expect(issues).toMatchObject([{ row: 6, kind: 'MISSING_REQUIRED_FIELD', detail: 'needs subAr' }]);
  });

  it('MIG-003: a vendor loads without an address or a usable phone, and both are reported', () => {
    const headers = ['Vendor code', 'Vendor name', 'Contact person', 'Phone', 'Email', 'Country', 'Address'];
    const sheet = aSheet('2. Vendors', headers, [
      ['VEN-1', 'Supplier', 'Person', '0512345678', 'a@b.com', 'IN', 'Somewhere'],
      ['VEN-2', 'Other', 'Person', '1', null, 'CN', null],
    ]);
    const { loadable, issues } = assessVendors(sheet);
    expect(loadable).toHaveLength(2);
    // The placeholder phone is dropped rather than stored as a wrong number.
    expect(loadable[1]).toMatchObject({ code: 'VEN-2', phone: null, email: null });
    expect(issues.map((i) => i.kind)).toEqual(['NEEDS_CONFIRMATION', 'MISSING_REQUIRED_FIELD']);
  });

  it('a duplicate vendor code is a conflict, not the last row quietly winning', () => {
    const headers = ['Vendor code', 'Vendor name', 'Contact person', 'Phone', 'Email', 'Country', 'Address'];
    const sheet = aSheet('2. Vendors', headers, [
      ['VEN-1', 'First', 'P', null, null, 'IN', 'A'],
      ['VEN-1', 'Second', 'P', null, null, 'IN', 'A'],
    ]);
    const { loadable, issues } = assessVendors(sheet);
    expect(loadable).toHaveLength(1);
    expect(issues).toMatchObject([{ kind: 'CONFLICTING_VALUE', row: 6 }]);
  });

  it('CLIENT-DATA: a stray space is tidied and said out loud', () => {
    const sheet = aSheet('4. SKUs & Prices', SKU_HEADERS, [
      ['RED -CB-50G', 'Radish', 'Cherry Belle', 'Can', '50', 'g', '12.00', null],
    ]);
    const { loadable, issues } = assessSkus(sheet);
    expect(loadable[0]?.code).toBe('RED-CB-50G');
    expect(issues).toMatchObject([{ kind: 'NEEDS_CONFIRMATION' }]);
  });

  it('MIG-003: a code and a pack size that disagree is a conflict, never an average', () => {
    // `BEAN-SN-1KG` against a 50 g pack size is exactly the conflict CLIENT-DATA lists.
    const sheet = aSheet('4. SKUs & Prices', SKU_HEADERS, [
      ['BEAN-SN-1KG', 'Bean', 'Snake', 'Can', '50', 'g', '60.00', null],
      ['OKRA-PK-5KG', 'Okra', 'PK', 'Bag', '5', 'kg', '48.00', null],
    ]);
    const { loadable, issues } = assessSkus(sheet);
    expect(loadable.map((s) => s.code)).toEqual(['OKRA-PK-5KG']);
    expect(issues).toMatchObject([{ kind: 'CONFLICTING_VALUE', row: 5 }]);
  });

  it('a SKU with no price is not sellable, so it is a question rather than a half-loaded row', () => {
    const sheet = aSheet('4. SKUs & Prices', SKU_HEADERS, [['OKRA-PK-5KG', 'Okra', 'PK', 'Bag', '5', 'kg', null, null]]);
    const { loadable, issues } = assessSkus(sheet);
    expect(loadable).toEqual([]);
    expect(issues).toMatchObject([{ kind: 'MISSING_REQUIRED_FIELD' }]);
  });

  it('MIG-005: stores with names only do not load, and the count is the question', () => {
    const namesOnly = Array.from({ length: 6 }, (_, i) => [`Store ${i}`, null, null, null, null, null, null, null, null, null, null] as Cell[]);
    const { loadable, issues } = assessStores(aSheet('6. Stores', STORE_HEADERS, namesOnly));
    expect(loadable).toEqual([]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.kind).toBe('MISSING_REQUIRED_FIELD');
    expect(issues[0]?.detail).toContain('6 stores');
  });

  it('MIG-003: a lone completed store is asked about, because it reads exactly like the template\'s row', () => {
    // The rule cannot tell the template's demonstration from the one store
    // Green Agro finished, so it does neither silently: it asks.
    const namesOnly = Array.from({ length: 6 }, (_, i) => [`Store ${i}`, null, null, null, null, null, null, null, null, null, null] as Cell[]);
    const ready: Cell[] = ['Ready Store', 'Owner', '0512345678', 'Shop', 'Street', 'Riyadh', 'WEEKLY', null, '5000', 'Base', 'Seller One'];
    const { loadable, issues } = assessStores(aSheet('6. Stores', STORE_HEADERS, [...namesOnly, ready]));
    expect(loadable).toEqual([]);
    expect(issues.some((i) => i.kind === 'LOOKS_LIKE_TEMPLATE_EXAMPLE' && /confirm whether/.test(i.detail))).toBe(true);
  });

  it('once most stores are properly filled in, they load rather than reading as examples', () => {
    const complete = Array.from({ length: 8 }, (_, i) => (
      [`Store ${i}`, 'Owner', '0512345678', 'Shop', 'Street', 'Riyadh', 'WEEKLY', null, '5000', 'Base', 'Seller One'] as Cell[]
    ));
    const { loadable } = assessStores(aSheet('6. Stores', STORE_HEADERS, complete));
    expect(loadable).toHaveLength(8);
  });

  it('MIG-005: the template\'s own store row is recognised and left out', () => {
    const namesOnly = Array.from({ length: 12 }, (_, i) => [`Store ${i}`, null, null, null, null, null, null, null, null, null, null] as Cell[]);
    const example: Cell[] = ['Demo', 'Demo Owner', '0512345678', 'Shop', 'Street', 'Riyadh', 'WEEKLY', null, '5000', 'Base', 'Seller One'];
    const { issues } = assessStores(aSheet('6. Stores', STORE_HEADERS, [example, ...namesOnly]));
    expect(issues.some((i) => i.kind === 'LOOKS_LIKE_TEMPLATE_EXAMPLE' && i.row === 5)).toBe(true);
  });

  it('a renamed column stops the import rather than shifting every value one across', () => {
    const wrong = ['Shop name', 'Owner name', 'Phone', 'Store category', 'Address', 'City', 'Credit cycle', 'Custom cycle (days)', 'Credit limit (SAR)', 'Price list', 'Assigned seller'];
    expect(() => assessStores(aSheet('6. Stores', wrong, [['A', null, null, null, null, null, null, null, null, null, null]])))
      .toThrow(/no "Store name" column/);
  });
});
