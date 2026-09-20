import { describe, expect, it } from 'vitest';
import { ownerQuery } from '../../test/db';
import { anAccount, ctxFor } from '../../test/factories';
import { getProduct, listCategories, listProducts, listSkus } from '../catalogue';
import { listVehicles } from '../vehicles';
import { listVendors } from '../vendors';
import { assess, type Assessed } from './assess';
import { loadWorkbook } from './load';
import type { Cell, Sheet } from './workbook';

/**
 * Synthetic throughout, shaped like Green Agro's workbook: client data never
 * enters the repo, tests included (CLIENT-DATA.md).
 */
const aSheet = (sheet: string, headers: string[], rows: Cell[][]): Sheet => ({
  sheet, data: [[null], ['title'], ['guidance'], headers, ...rows],
});

const CATEGORIES = ['Category (English)', 'Category (Arabic)', 'Sub-category (English)', 'Sub-category (Arabic)'];
const VENDORS = ['Vendor code', 'Vendor name', 'Contact person', 'Phone', 'Email', 'Country', 'Address'];
const PRODUCTS = ['Product type', 'Category', 'Sub-category', 'Product name (English)', 'Product name (Arabic)',
  'Variety name (English)', 'Variety name (Arabic)', 'Hybrid / Non-hybrid', 'Country of origin', 'Vendor code',
  'Default shelf life', 'Shelf life unit'];
const SKUS = ['SKU code', 'Product name (English)', 'Variety name (English)', 'Packaging type', 'Pack size', 'Unit', 'Base price (SAR)', 'Notes'];
const STORES = ['Store name', 'Owner name', 'Phone', 'Store category', 'Address', 'City', 'Credit cycle', 'Custom cycle (days)', 'Credit limit (SAR)', 'Price list', 'Assigned seller'];
const USERS = ['Full name', 'Email', 'Phone', 'Role', 'Modules this person may access', 'Notes'];
const VEHICLES = ['Registration number', 'Description', 'Current odometer (km)', 'Status', 'Currently assigned to'];

type Overrides = { products?: Cell[][]; skus?: Cell[][]; vendors?: Cell[][]; users?: Cell[][]; vehicles?: Cell[][] };

const workbook = (over: Overrides = {}): Sheet[] => [
  aSheet('1. Categories', CATEGORIES, [
    ['Vegetable Seeds', 'بذور خضروات', 'Hybrid F1', 'هجين إف1'],
    ['Vegetable Seeds', 'بذور خضروات', 'Open Pollinated', 'غير هجين'],
  ]),
  aSheet('2. Vendors', VENDORS, over.vendors ?? [['VEN-001', 'A Supplier', 'A Contact', '0512345678', 'v@example.com', 'India', 'An address']]),
  aSheet('3. Products', PRODUCTS, over.products ?? [
    ['Seeds', 'Vegetable Seeds', 'Open Pollinated', 'Okra', 'بامية', 'Parbhani', 'بارباني', 'Non-hybrid', 'India', 'VEN-001', '24', 'Months'],
    ['Seeds', 'Vegetable Seeds', 'Open Pollinated', 'Okra', 'بامية', 'Pusa', 'بوسا', 'Non-hybrid', 'India', 'VEN-001', '24', 'Months'],
  ]),
  aSheet('4. SKUs & Prices', SKUS, over.skus ?? [
    ['OKRA-PA-1KG', 'Okra', 'Parbhani', 'Pouch', '1', 'kg', '48.00', null],
    ['OKRA-PU-50G', 'Okra', 'Pusa', 'Can', '50', 'gm', '12.50', null],
  ]),
  aSheet('5. Price Lists', ['Price list name', 'SKU code', 'Price (SAR)'], []),
  aSheet('6. Stores', STORES, [['A Store', null, null, null, null, null, null, null, null, null, null]]),
  aSheet('7. Users', USERS, over.users ?? [['A Seller', 'seller@example.com', null, 'Seller', null, null]]),
  aSheet('8. Vehicles', VEHICLES, over.vehicles ?? [['ABC 1234', 'Pickup', '10000', 'Active', 'A Seller']]),
];

const assessed = (over: Overrides = {}): Assessed => assess(workbook(over), new Map());

describe('loading the setup workbook (MIG-004, MIG-006)', () => {
  it('MIG-004: the workbook loads through the ordinary use cases, audited as any change is', async () => {
    const ctx = await ctxFor(await anAccount('SUPER_ADMIN'));
    const { loaded, refused, accounts } = await loadWorkbook(ctx, assessed());

    expect(refused).toEqual([]);
    expect(loaded).toEqual({
      categories: 1, subCategories: 2, vendors: 1, products: 1, varieties: 2, skus: 2, users: 1, vehicles: 1, assignments: 1,
    });

    const categories = await listCategories(ctx);
    expect(categories.map((c) => c.subCategories.map((s) => s.nameEn))).toEqual([['Hybrid F1', 'Open Pollinated']]);
    expect((await listVendors(ctx)).items.map((v) => [v.code, v.country])).toEqual([['VEN-001', 'IN']]);

    // CAT-008: Green Agro's own codes are kept — they are printed on the packs.
    const skus = (await listSkus(ctx)).items;
    expect(skus.map((s) => s.code).sort()).toEqual(['OKRA-PA-1KG', 'OKRA-PU-50G']);
    expect(skus.every((s) => s.basePrice !== null)).toBe(true);

    expect(accounts.map((a) => a.identifier)).toEqual(['seller@example.com']);
    const [audited] = await ownerQuery<{ n: number }>(`select count(*)::int as n from audit_log where action = 'catalogue.sku_created'`);
    expect(audited?.n).toBe(2);
  });

  it('MIG-004: a credential never reaches the result twice — it is returned, and nothing else carries it', async () => {
    const ctx = await ctxFor(await anAccount('SUPER_ADMIN'));
    const { accounts } = await loadWorkbook(ctx, assessed());
    const [account] = accounts;
    expect(account?.temporaryPassword).toBeTruthy();
    // USR-003: it is a first password, not a password — it must be changed.
    const [row] = await ownerQuery<{ must: boolean }>(`select must_change_password as must from users where email = 'seller@example.com'`);
    expect(row?.must).toBe(true);
  });

  it('MIG-004: importing twice is refused rather than doubling the catalogue', async () => {
    const ctx = await ctxFor(await anAccount('SUPER_ADMIN'));
    await loadWorkbook(ctx, assessed());
    await expect(loadWorkbook(ctx, assessed())).rejects.toThrow(/already holds categories/);
  });

  it('MIG-004: one row the system refuses does not cost the run — it is named and the rest goes in', async () => {
    const ctx = await ctxFor(await anAccount('SUPER_ADMIN'));
    const { loaded, refused } = await loadWorkbook(ctx, assessed({
      skus: [
        ['OKRA-PA-1KG', 'Okra', 'Parbhani', 'Pouch', '1', 'kg', '48.00', null],
        ['OKRA-XX-50G', 'Okra', 'Not A Variety', 'Can', '50', 'gm', '12.50', null],
      ],
    }));
    expect(loaded.skus).toBe(1);
    expect(refused).toMatchObject([{ sheet: '4. SKUs & Prices', row: 6, code: 'NOT_FOUND' }]);
  });

  it('a product whose vendor the system refused says so, rather than failing for a reason nobody can place', async () => {
    const ctx = await ctxFor(await anAccount('SUPER_ADMIN'));
    // The assessment passes this vendor — a name is a name — and the service
    // refuses it for being too long. Its products then have no vendor, and a
    // Seeds product must have one (CAT-013): the cause is named, not the symptom.
    const { loaded, refused } = await loadWorkbook(ctx, assessed({
      vendors: [['VEN-001', 'A'.repeat(300), 'A Contact', null, null, 'India', 'An address']],
    }));
    expect(loaded.vendors).toBe(0);
    expect(loaded.products).toBe(0);
    expect(refused).toMatchObject([
      { sheet: '2. Vendors', code: 'INVALID_NAME' },
      { sheet: '3. Products', code: 'NOT_FOUND' },
      { sheet: '4. SKUs & Prices' }, { sheet: '4. SKUs & Prices' },
    ]);
    expect(refused[1]?.detail).toContain('VEN-001');
  });

  it('VEH-002: a vehicle loads unassigned when the seller it names did not', async () => {
    const ctx = await ctxFor(await anAccount('SUPER_ADMIN'));
    const { loaded } = await loadWorkbook(ctx, assessed({
      vehicles: [['ABC 1234', 'Pickup', '10000', 'Active', null]],
    }));
    expect(loaded.vehicles).toBe(1);
    expect(loaded.assignments).toBe(0);
    expect((await listVehicles(ctx)).map((v) => v.seller)).toEqual([null]);
  });

  it('MIG-005: stores are not imported — sellers onboard their own in the app', async () => {
    const ctx = await ctxFor(await anAccount('SUPER_ADMIN'));
    await loadWorkbook(ctx, assessed());
    const [row] = await ownerQuery<{ n: number }>('select count(*)::int as n from stores');
    expect(row?.n).toBe(0);
  });

  it('ADR-0005: an operator without the permissions cannot import, however the script was run', async () => {
    const ctx = await ctxFor(await anAccount('SELLER'));
    await expect(loadWorkbook(ctx, assessed())).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('CAT-013: every loaded product carries what its type requires', async () => {
    const ctx = await ctxFor(await anAccount('SUPER_ADMIN'));
    await loadWorkbook(ctx, assessed());
    const [summary] = (await listProducts(ctx)).items;
    expect(summary).toBeDefined();
    const product = await getProduct(ctx, summary?.id ?? '');
    expect(product).toMatchObject({ nameEn: 'Okra', hybrid: 'NON_HYBRID', countryOfOrigin: 'IN', shelfLifeMonths: 24 });
  });
});
