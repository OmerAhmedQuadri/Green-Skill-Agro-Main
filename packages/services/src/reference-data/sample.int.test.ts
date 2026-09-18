import { describe, expect, it } from 'vitest';
import { ownerQuery } from '../../test/db';
import { anAccount, ctxFor } from '../../test/factories';
import { listCategories, listProducts, listSkus } from '../catalogue';
import { listPriceLists } from '../pricing';
import { loadSampleCatalogue } from './sample';

describe('sample catalogue (MIG-006, CAT-003)', () => {
  it('CAT-003: a working category structure can be loaded for Green Agro to refine', async () => {
    const ctx = await ctxFor(await anAccount('SUPER_ADMIN'));
    expect(await loadSampleCatalogue(ctx, { withProducts: false })).toEqual({ loaded: true });
    const categories = await listCategories(ctx);
    expect(categories.map((c) => [c.nameEn, c.subCategories.map((s) => s.nameEn)])).toEqual([
      ['Agriculture Essentials', ['Shade Nets & Mesh']],
      ['Vegetable Seeds', ['Hybrid F1', 'Open Pollinated']],
    ]);
    expect((await listProducts(ctx)).items).toEqual([]);
  });

  it('MIG-006: the sample catalogue is usable from day one, and loading twice changes nothing', async () => {
    const ctx = await ctxFor(await anAccount('SUPER_ADMIN'));
    await loadSampleCatalogue(ctx, { withProducts: true });
    expect(await loadSampleCatalogue(ctx, { withProducts: true })).toEqual({ loaded: false });
    const skus = (await listSkus(ctx)).items;
    expect(skus.map((s) => s.code)).toEqual(expect.arrayContaining(['OKRA-PK-5KG', 'OKRA-PK-1KG', 'OKRA-PK-50G', 'PAPA-SS-500S', 'SHAD-1PC']));
    expect(skus.every((s) => s.basePrice !== null)).toBe(true);
    expect((await listPriceLists(ctx)).map((l) => l.itemCount)).toEqual([skus.length, 2]);
    // Every sample change is audited like any other.
    const [row] = await ownerQuery<{ n: number }>(`select count(*)::int as n from audit_log where action = 'catalogue.sku_created'`);
    expect(row?.n).toBe(skus.length);
  });
});
