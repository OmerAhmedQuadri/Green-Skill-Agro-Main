import { packCount, toBaseUnits, transfer, type DomainError, type PermissionCode } from '@gsa/core';
import { newId } from '@gsa/db';
import { describe, expect, it } from 'vitest';
import { ownerQuery } from '../../test/db';
import { anAccount, ctxFor } from '../../test/factories';
import { okraInWarehouse } from '../../test/stock';
import { updateCategory } from '../catalogue';
import type { Ctx } from '../context';
import { inTx } from '../platform';
import { updateSettings } from '../system';
import { flaggedBatchIds, getSkuStock, listExpiryFlags, postStockMovements, setClearancePriority } from './index';

const code = async (p: Promise<unknown>) => p.then(() => 'NO_ERROR', (e: DomainError) => e.code ?? String(e));
const NOW = new Date('2026-09-19T09:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const admin = async () => ctxFor(await anAccount('ADMIN'), { now: NOW });
const bag = { measure: 'WEIGHT', packWeightG: '5000' } as const;

/** Sells bags of a batch from the warehouse on a given day, as a test shortcut for the sales module (M6). */
async function sell(ctx: Ctx, batch: { id: string; balanceKey: string }, warehouseId: string, packs: number, at: Date) {
  await inTx(ctx, (tx) => postStockMovements(tx, ctx, {
    referenceType: 'SALE', referenceId: newId(), occurredAt: at,
    legs: transfer(batch, toBaseUnits(packCount(packs), bag), { kind: 'WAREHOUSE', warehouseId }, { kind: 'SOLD' }),
  }));
}

async function world(opts: { expiresOn: string; receivedDaysAgo?: number }) {
  const ctx = await admin();
  const stock = await okraInWarehouse(ctx, { expiresOn: opts.expiresOn, receivedAt: daysAgo(opts.receivedDaysAgo ?? 60) });
  const [b] = (await getSkuStock(ctx, stock.bag.id)).batches;
  if (!b) throw new Error('no batch');
  const batch = { id: b.batchId, balanceKey: stock.variety.id };
  const flagFor = async (c: Ctx = ctx) => (await listExpiryFlags(c)).find((f) => f.batchId === b.batchId);
  return { ctx, stock, batch, flagFor };
}

describe('expiry flags (EXP-001..008)', () => {
  it('EXP-001: a batch is flagged within its category\'s warning window, or the default', async () => {
    const { ctx, stock, flagFor } = await world({ expiresOn: '2026-11-18' }); // 60 days away
    expect(await flagFor()).toMatchObject({ daysLeft: 60, warningDays: 90, time: true, heldPacks: 20 });
    await updateCategory(ctx, stock.category.id, { version: stock.category.version, expiryWarningDays: 30 });
    expect(await flagFor()).toMatchObject({ warningDays: 30, time: false });
    await updateSettings(ctx, [{ key: 'expiry.warning_days', value: 120 }]);
    expect((await flagFor())?.warningDays).toBe(30); // the category's own window wins
  });

  it('EXP-002, EXP-003: flagged when, at the batch\'s trailing rate, it will not clear before expiry', async () => {
    const { ctx, stock, batch, flagFor } = await world({ expiresOn: '2027-01-17' }); // 120 days
    await sell(ctx, batch, stock.po.warehouseId, 2, daysAgo(10)); // 10 kg in 30 days; 90 kg left takes 270 days
    expect((await flagFor())?.rate).toMatchObject({ flagged: true, reason: 'WONT_CLEAR', daysToClear: 270, basisUsed: 'TRAILING' });
    await sell(ctx, batch, stock.po.warehouseId, 10, daysAgo(5)); // 60 kg in 30 days; 40 kg left takes 20 days
    expect((await flagFor())?.rate).toMatchObject({ flagged: false, daysToClear: 20 });
  });

  it('EXP-002: a batch that has not sold at all in a full window is flagged as not moving', async () => {
    const { flagFor } = await world({ expiresOn: '2028-06-30' });
    expect((await flagFor())?.rate).toMatchObject({ flagged: true, reason: 'NO_RECENT_SALES' });
  });

  it('EXP-003: a batch received less than a full window ago is not judged on rate yet', async () => {
    const { flagFor } = await world({ expiresOn: '2027-01-17', receivedDaysAgo: 5 });
    expect((await flagFor())?.rate).toMatchObject({ flagged: false, tooSoon: true });
  });

  it('EXP-004, EXP-005, EXP-008: the seasonal rate needs a year of history; then the Admin chooses the basis', async () => {
    const { ctx, stock, batch, flagFor } = await world({ expiresOn: '2027-01-17', receivedDaysAgo: 420 });
    await sell(ctx, batch, stock.po.warehouseId, 12, daysAgo(10)); // brisk now: 20 days to clear
    await updateSettings(ctx, [{ key: 'expiry.rate_basis', value: 'CONSERVATIVE' }]);
    expect((await flagFor())?.rate).toMatchObject({ basisUsed: 'TRAILING', flagged: false }); // EXP-008: no season yet
    await sell(ctx, batch, stock.po.warehouseId, 1, daysAgo(380)); // a slow month, a year ago
    expect((await flagFor())?.rate).toMatchObject({ basisUsed: 'SEASONAL', flagged: true });
    await updateSettings(ctx, [{ key: 'expiry.rate_basis', value: 'TRAILING' }]);
    expect((await flagFor())?.rate).toMatchObject({ basisUsed: 'TRAILING', flagged: false });
  });

  it('CAT-016: a product type with expiry disabled never appears in expiry flags', async () => {
    const { ctx } = await world({ expiresOn: '2026-10-01' });
    const [row] = await ownerQuery<{ n: number }>(`select count(*)::int as n from batches where expires_on is null`);
    expect(row?.n).toBe(0);
    expect((await listExpiryFlags(ctx)).every((f) => f.expiresOn !== null)).toBe(true);
  });

  it('EXP-006: a manager can put a batch first in line; flagged batches are proposed first', async () => {
    const { ctx, stock, batch, flagFor } = await world({ expiresOn: '2028-06-30' });
    await sell(ctx, batch, stock.po.warehouseId, 1, daysAgo(3)); // selling steadily: nothing to flag
    expect(await flagFor()).toMatchObject({ time: false, rate: { flagged: false }, prioritised: false });
    expect((await flaggedBatchIds(ctx)).has(batch.id)).toBe(false);
    const viewer = await ctxFor(await anAccount('MANAGER'), { now: NOW, overrides: new Map<PermissionCode, boolean>([['inventory.view_all_stock', true]]) });
    expect(await code(setClearancePriority(viewer, batch.id, { prioritised: true }))).toBe('FORBIDDEN');
    await setClearancePriority(ctx, batch.id, { prioritised: true, note: 'Clear before the new season' });
    expect(await flagFor(viewer)).toMatchObject({ prioritised: true, note: 'Clear before the new season' });
    expect((await flaggedBatchIds(ctx)).has(batch.id)).toBe(true);
  });
});
