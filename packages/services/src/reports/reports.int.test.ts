import { businessDate } from '@gsa/core';
import { describe, expect, it } from 'vitest';
import { ownerQuery } from '../../test/db';
import { anAccount, ctxFor } from '../../test/factories';
import { aSellingSeller } from '../../test/sales';
import { recordSale } from '../sales';
import { updateSettings } from '../system';
import { buildRecommendations, listRecommendations, rebuildRollup, recordRecommendations } from './index';

const admin = async (now?: Date) => ctxFor(await anAccount('ADMIN'), now ? { now } : {});
const today = () => businessDate(new Date());
const dayAfterToday = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const setCover = (skuId: string, days: number | null) =>
  ownerQuery('update skus set safety_cover_days = $2 where id = $1', [skuId, days]);

describe('the sales rollup (RPT-001, RPT-002, ADR-0043)', () => {
  it('RPT-001: what sold lands in the rollup, by day, SKU, seller and store', async () => {
    const ctx = await admin();
    const setup = await aSellingSeller(ctx, { packs: 20 });
    await recordSale(setup.seller.ctx, { storeId: setup.store.id, lines: [{ skuId: setup.bag.id, packs: 4 }] });
    const built = await rebuildRollup(ctx, today(), dayAfterToday());
    expect(built.rows).toBeGreaterThan(0);
    const [row] = await ownerQuery<{ packs: number; revenue: string }>(
      'select packs, revenue::text from sales_daily_rollup where sku_id = $1 and seller_id = $2 and day = $3',
      [setup.bag.id, setup.seller.account.id, today()],
    );
    expect(row).toMatchObject({ packs: 4, revenue: '360.00' }); // 4 bags at 90.00
  });

  it('ADR-0043: a rebuild replaces the day rather than adding to it, so running twice is safe', async () => {
    const ctx = await admin();
    const setup = await aSellingSeller(ctx, { packs: 20 });
    await recordSale(setup.seller.ctx, { storeId: setup.store.id, lines: [{ skuId: setup.bag.id, packs: 3 }] });
    await rebuildRollup(ctx, today(), dayAfterToday());
    await rebuildRollup(ctx, today(), dayAfterToday());
    const [row] = await ownerQuery<{ packs: number }>(
      'select packs from sales_daily_rollup where sku_id = $1 and seller_id = $2',
      [setup.bag.id, setup.seller.account.id],
    );
    expect(row?.packs).toBe(3); // not 6
  });
});

describe('the reorder recommendation (RPT-004..006, RPT-011, ADR-0043)', () => {
  it('RPT-004: a SKU with no safety cover set is not forecast at all', async () => {
    const ctx = await admin();
    const setup = await aSellingSeller(ctx, { packs: 20 });
    await setCover(setup.bag.id, null);
    expect((await buildRecommendations(ctx)).map((r) => r.skuId)).not.toContain(setup.bag.id);
  });

  it('RPT-006: the projection runs to today plus the lead time, and says what it assumed', async () => {
    const ctx = await admin();
    const setup = await aSellingSeller(ctx, { packs: 20 });
    await setCover(setup.bag.id, 21);
    await updateSettings(ctx, [{ key: 'imports.lead_time_days', value: 45 }]);
    await recordSale(setup.seller.ctx, { storeId: setup.store.id, lines: [{ skuId: setup.bag.id, packs: 9 }] });
    await rebuildRollup(ctx, today(), dayAfterToday());

    const [item] = (await buildRecommendations(ctx)).filter((r) => r.skuId === setup.bag.id);
    expect(item).toMatchObject({ leadTimeDays: 45, safetyCoverDays: 21, basisUsed: 'TRAILING' });
    // 9 packs over the 90-day window is 0.1 a day.
    expect(item?.perDay).toBe('0.100');
    // RPT-011: no season of history behind it yet.
    expect(item?.guide).toBe(true);
  });

  it('RPT-004: what is already on the water counts towards the projection', async () => {
    const ctx = await admin();
    const setup = await aSellingSeller(ctx, { packs: 20 });
    await setCover(setup.bag.id, 21);
    const [item] = (await buildRecommendations(ctx)).filter((r) => r.skuId === setup.bag.id);
    expect(item?.onHand).toBeGreaterThan(0);
    expect(item).toHaveProperty('inTransit');
    // Nothing sells, so nothing is suggested however little is held.
    expect(item?.suggested).toBe(0);
  });

  it('RPT-005: the pass is recorded, and reading it needs the forecast permission', async () => {
    const ctx = await admin();
    const setup = await aSellingSeller(ctx, { packs: 20 });
    await setCover(setup.bag.id, 21);
    const recorded = await recordRecommendations(ctx);
    expect(recorded.built).toBeGreaterThan(0);
    const [stored] = await ownerQuery<{ n: string }>('select count(*)::text n from reorder_recommendations where sku_id = $1', [setup.bag.id]);
    expect(Number(stored?.n ?? 0)).toBeGreaterThan(0);
    // A seller has no business seeing the import plan.
    await expect(listRecommendations(setup.seller.ctx)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await listRecommendations(ctx)).builtAt).not.toBeNull();
  });
});
