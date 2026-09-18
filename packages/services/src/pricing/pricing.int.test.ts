import type { DomainError, PermissionCode } from '@gsa/core';
import { describe, expect, it } from 'vitest';
import { anOkra } from '../../test/catalogue';
import { ownerQuery } from '../../test/db';
import { anAccount, ctxFor } from '../../test/factories';
import { createSku } from '../catalogue';
import {
  createPriceList, getDiscountCeilings, getPriceList, listPriceLists, setDiscountCeilings, setPriceListItems,
  setSkuDiscountCeiling, updatePriceList,
} from './index';

const code = async (p: Promise<unknown>) => p.then(() => 'NO_ERROR', (e: DomainError) => e.code ?? String(e));
const admin = async () => ctxFor(await anAccount('ADMIN'));
const manager = async (grants: PermissionCode[] = []) =>
  ctxFor(await anAccount('MANAGER'), { overrides: new Map(grants.map((g) => [g, true])) });

async function twoSkus() {
  const ctx = await admin();
  const { product, variety } = await anOkra(ctx);
  await createSku(ctx, product.id, { varietyId: variety.id, size: { measure: 'WEIGHT', value: '5', unit: 'KG' }, packaging: 'BAG' });
  const detail = await createSku(ctx, product.id, { varietyId: variety.id, size: { measure: 'WEIGHT', value: '1', unit: 'KG' }, packaging: 'POUCH' });
  const [bag, pouch] = [...detail.skus].sort((a, b) => a.code.localeCompare(b.code)).reverse(); // 5KG, 1KG
  if (!bag || !pouch) throw new Error('skus missing');
  return { ctx, bag, pouch };
}

describe('price lists (PRC-001..003)', () => {
  it('PRC-002: exactly one base price list exists from setup', async () => {
    const lists = await listPriceLists(await admin());
    expect(lists.filter((l) => l.isBase)).toHaveLength(1);
    await expect(ownerQuery(`insert into price_lists (id, name_en, name_ar, is_base) values (gen_random_uuid(), 'Second', 'ثانية', true)`))
      .rejects.toThrow(/price_lists_single_base/);
  });

  it('PRC-001: prices are per SKU — a 5 kg bag and a 1 kg pouch each have their own', async () => {
    const { ctx, bag, pouch } = await twoSkus();
    const [base] = await listPriceLists(ctx);
    if (!base) throw new Error('no base');
    const { rows } = await setPriceListItems(ctx, base.id, [{ skuId: bag.id, price: '86.10' }, { skuId: pouch.id, price: '48' }]);
    expect(Object.fromEntries(rows.map((r) => [r.code, r.price]))).toEqual({ 'OKRA-PK-5KG': '86.10', 'OKRA-PK-1KG': '48.00' });
    expect(await code(setPriceListItems(ctx, base.id, [{ skuId: bag.id, price: '0' }]))).toBe('INVALID_PRICE');
    expect(await code(setPriceListItems(ctx, base.id, [{ skuId: bag.id, price: '86.105' }]))).toBe('INVALID_MONEY');
  });

  it('PRC-003: an additional list overrides the base price for the SKUs it lists', async () => {
    const { ctx, bag } = await twoSkus();
    const bulk = await createPriceList(ctx, { nameEn: 'Bulk buyers', nameAr: 'كبار المشترين' });
    const { rows } = await setPriceListItems(ctx, bulk.id, [{ skuId: bag.id, price: '80' }]);
    expect(rows.find((r) => r.skuId === bag.id)?.price).toBe('80.00');
    expect(rows.filter((r) => r.price === null)).toHaveLength(1); // the pouch keeps the base price
    const cleared = await setPriceListItems(ctx, bulk.id, [{ skuId: bag.id, price: null }]);
    expect(cleared.rows.every((r) => r.price === null)).toBe(true);
  });

  it('PRC-002: the base list can be renamed but never retired', async () => {
    const ctx = await admin();
    const [base] = await listPriceLists(ctx);
    if (!base) throw new Error('no base');
    expect(await code(updatePriceList(ctx, base.id, { version: base.version, isActive: false }))).toBe('REFERENCE_INACTIVE');
    expect((await updatePriceList(ctx, base.id, { version: base.version, nameEn: 'Standard prices' })).nameEn).toBe('Standard prices');
  });

  it('PRC-001: price changes are audited with the old and new price, and need pricing.manage_price_lists', async () => {
    const { ctx, bag } = await twoSkus();
    const [base] = await listPriceLists(ctx);
    if (!base) throw new Error('no base');
    await setPriceListItems(ctx, base.id, [{ skuId: bag.id, price: '86.10' }]);
    await setPriceListItems(ctx, base.id, [{ skuId: bag.id, price: '90' }]);
    await setPriceListItems(ctx, base.id, [{ skuId: bag.id, price: '90.00' }]); // no change, no entry
    const rows = await ownerQuery<{ after: { changes: unknown[] } }>(`select after from audit_log where action = 'pricing.prices_changed' order by occurred_at`);
    expect(rows.map((r) => r.after.changes)).toEqual([
      [{ skuId: bag.id, before: null, after: '86.10' }],
      [{ skuId: bag.id, before: '86.10', after: '90' }],
    ]);
    expect(await code(getPriceList(await manager(['catalogue.view']), base.id))).toBe('FORBIDDEN');
  });
});

describe('discount ceilings (PRC-004..007, PRC-015, PRC-016)', () => {
  it('PRC-004, PRC-005: an overall ceiling and a default item ceiling, with defaults', async () => {
    const ceilings = await getDiscountCeilings(await admin());
    expect(ceilings).toMatchObject({ orderCeiling: '10', itemCeiling: '5', absoluteMaximum: '25', approvalExpiryMinutes: 30, skuCeilings: [] });
  });

  it('PRC-007: the Admin sets the ceilings; a manager needs pricing.set_discount_ceilings', async () => {
    expect((await setDiscountCeilings(await admin(), { orderCeiling: '12.5', itemCeiling: '7' })).orderCeiling).toBe('12.5');
    expect(await code(setDiscountCeilings(await manager(['pricing.manage_price_lists']), { orderCeiling: '15' }))).toBe('FORBIDDEN');
    expect(await code(setDiscountCeilings(await manager(['pricing.set_discount_ceilings']), { orderCeiling: '15' }))).toBe('NO_ERROR');
  });

  it('PRC-005: a SKU can carry its own ceiling, and return to the default', async () => {
    const { ctx, bag } = await twoSkus();
    expect((await setSkuDiscountCeiling(ctx, bag.id, '3')).skuCeilings).toEqual([{ skuId: bag.id, code: 'OKRA-PK-5KG', ceiling: '3' }]);
    expect((await setSkuDiscountCeiling(ctx, bag.id, null)).skuCeilings).toEqual([]);
  });

  it('PRC-016: no ceiling may exceed the absolute maximum, whichever side moves', async () => {
    const { ctx, bag } = await twoSkus();
    expect(await code(setDiscountCeilings(ctx, { orderCeiling: '30' }))).toBe('CEILING_ABOVE_MAXIMUM');
    expect(await code(setSkuDiscountCeiling(ctx, bag.id, '26'))).toBe('CEILING_ABOVE_MAXIMUM');
    await setSkuDiscountCeiling(ctx, bag.id, '20');
    expect(await code(setDiscountCeilings(ctx, { absoluteMaximum: '15' }))).toBe('CEILING_ABOVE_MAXIMUM');
    expect((await getDiscountCeilings(ctx)).absoluteMaximum).toBe('25'); // the refused change left nothing behind
  });

  it('PRC-015: the approval expiry is configurable within bounds', async () => {
    const ctx = await admin();
    expect((await setDiscountCeilings(ctx, { approvalExpiryMinutes: 45 })).approvalExpiryMinutes).toBe(45);
    expect(await code(setDiscountCeilings(ctx, { approvalExpiryMinutes: 2 }))).toBe('INVALID_SETTING');
  });
});
