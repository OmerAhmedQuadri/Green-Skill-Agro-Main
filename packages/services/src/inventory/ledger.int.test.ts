import { packCount, quantity, toBaseUnits, transfer, type DomainError } from '@gsa/core';
import { newId } from '@gsa/db';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { ownerQuery } from '../../test/db';
import { anAccount, ctxFor } from '../../test/factories';
import { okraSkus } from '../../test/procurement';
import { aVehicle } from '../../test/vehicles';
import type { Ctx } from '../context';
import { inTx } from '../platform';
import { defaultBranchId, getDb } from '../runtime';
import { findOrCreateBatch, postStockMovements } from './ledger';

const code = async (p: Promise<unknown>) => p.then(() => 'NO_ERROR', (e: DomainError) => e.code ?? String(e));
const pgCode = async (p: Promise<unknown>) => p.then(() => 'NO_ERROR', (e: { message?: string; cause?: { code?: string; constraint?: string } }) => e.cause?.constraint ?? e.cause?.code ?? e.message ?? 'UNKNOWN');
const bagUnits = { measure: 'WEIGHT', packWeightG: '5000' } as const;

async function world() {
  const ctx = await ctxFor(await anAccount('ADMIN'));
  const okra = await okraSkus(ctx);
  const [warehouse] = await ownerQuery<{ id: string }>(`select id from warehouses limit 1`);
  if (!warehouse) throw new Error('no warehouse');
  const wh = { kind: 'WAREHOUSE', warehouseId: warehouse.id } as const;
  const batch = await inTx(ctx, (tx) => findOrCreateBatch(tx, ctx, { skuId: okra.bag.id, lotNumber: 'L1', manufacturedOn: '2026-01-10', expiresOn: '2028-01-10', receivedAt: ctx.now }));
  const receive = (packs: number, c: Ctx = ctx) => inTx(c, (tx) => postStockMovements(tx, c, {
    referenceType: 'GOODS_RECEIPT', referenceId: newId(), legs: transfer(batch, toBaseUnits(packCount(packs), bagUnits), { kind: 'SUPPLIER' }, wh),
  }));
  return { ctx, okra, wh, batch, receive };
}

describe('the stock ledger (ADR-0001, STK-013)', () => {
  it('STK-013: movements are append-only for the application — never updated or deleted', async () => {
    const { receive } = await world();
    await receive(2);
    expect(await pgCode(getDb().execute(sql`update stock_movements set quantity = 1`))).toBe('42501');
    expect(await pgCode(getDb().execute(sql`delete from stock_movements`))).toBe('42501');
    expect(await pgCode(getDb().execute(sql`update batches set lot_number = 'X'`))).toBe('42501');
  });

  it('STK-013: the database refuses a group that does not balance, even written directly', async () => {
    const { ctx, batch, wh } = await world();
    const branchId = await defaultBranchId();
    const write = getDb().transaction(async (tx) => {
      await tx.execute(sql`insert into stock_movements (id, group_id, occurred_at, batch_id, quantity, account_kind, warehouse_id, reference_type, reference_id, branch_id, created_by)
        values (${newId()}, ${newId()}, now(), ${batch.id}, 5000, 'WAREHOUSE', ${wh.warehouseId}, 'GOODS_RECEIPT', ${newId()}, ${branchId}, ${ctx.user.id})`);
    });
    expect(await pgCode(write)).toBe('stock_movements_balanced');
  });

  it('STK-013: no internal position may go below zero — checked by the service, and again by the database', async () => {
    const { ctx, batch, wh, receive } = await world();
    await receive(2);
    const sell = (packs: number) => inTx(ctx, (tx) => postStockMovements(tx, ctx, {
      referenceType: 'SALE', referenceId: newId(), legs: transfer(batch, toBaseUnits(packCount(packs), bagUnits), wh, { kind: 'SOLD' }),
    }));
    expect(await code(sell(3))).toBe('INSUFFICIENT_STOCK');
    const branchId = await defaultBranchId();
    const group = newId();
    const direct = getDb().transaction(async (tx) => {
      for (const [q, kind, w] of [[-15000, 'WAREHOUSE', wh.warehouseId], [15000, 'SOLD', null]] as const) {
        await tx.execute(sql`insert into stock_movements (id, group_id, occurred_at, batch_id, quantity, account_kind, warehouse_id, reference_type, reference_id, branch_id, created_by)
          values (${newId()}, ${group}, now(), ${batch.id}, ${q}, ${kind}, ${w}, 'SALE', ${newId()}, ${branchId}, ${ctx.user.id})`);
      }
    });
    expect(await pgCode(direct)).toBe('stock_positions_non_negative');
    expect(await code(sell(2))).toBe('NO_ERROR');
  });

  it('STK-013: nothing is un-sold beyond what was sold — the external accounts keep their direction', async () => {
    const { ctx, batch, wh, receive } = await world();
    await receive(1);
    const vehicle = { kind: 'VEHICLE', vehicleId: (await aVehicle(ctx)).id } as const;
    const returnSaleable = () => inTx(ctx, (tx) => postStockMovements(tx, ctx, {
      referenceType: 'RETURN', referenceId: newId(), legs: transfer(batch, toBaseUnits(packCount(1), bagUnits), { kind: 'SOLD' }, vehicle),
    }));
    expect(await code(returnSaleable())).toBe('INSUFFICIENT_STOCK'); // nothing sold yet: it would create stock
    await inTx(ctx, (tx) => postStockMovements(tx, ctx, { referenceType: 'SALE', referenceId: newId(), legs: transfer(batch, toBaseUnits(packCount(1), bagUnits), wh, { kind: 'SOLD' }) }));
    expect(await code(returnSaleable())).toBe('NO_ERROR');
  });

  it('STK-015: a count SKU moves only in whole seeds', async () => {
    const { ctx, okra, wh } = await world();
    const { createSku } = await import('../catalogue');
    const seedsSku = (await createSku(ctx, okra.product.id, { varietyId: okra.variety.id, size: { measure: 'COUNT', count: 500 }, packaging: 'CAN' }))
      .skus.find((s) => s.size.measure === 'COUNT');
    if (!seedsSku) throw new Error('no count SKU');
    const batch = await inTx(ctx, (tx) => findOrCreateBatch(tx, ctx, { skuId: seedsSku.id, lotNumber: 'C1', manufacturedOn: '2026-01-10', expiresOn: '2028-01-10', receivedAt: ctx.now }));
    const post = (q: string) => inTx(ctx, (tx) => postStockMovements(tx, ctx, { referenceType: 'OPENING_BALANCE', referenceId: newId(), legs: transfer(batch, quantity(q), { kind: 'SUPPLIER' }, wh) }));
    expect(await pgCode(post('250.5'))).toBe('stock_movements_whole_seeds');
    expect(await code(post('500'))).toBe('NO_ERROR');
  });

  it('STK-013: two postings spending the same stock at once cannot both succeed', async () => {
    const { ctx, batch, wh, receive } = await world();
    await receive(3);
    const spend = () => inTx(ctx, (tx) => postStockMovements(tx, ctx, {
      referenceType: 'SALE', referenceId: newId(), legs: transfer(batch, toBaseUnits(packCount(2), bagUnits), wh, { kind: 'SOLD' }),
    }));
    const results = await Promise.all([code(spend()), code(spend()), code(spend())]);
    expect(results.sort()).toEqual(['INSUFFICIENT_STOCK', 'INSUFFICIENT_STOCK', 'NO_ERROR']);
    const [row] = await ownerQuery<{ q: string }>(`select sum(quantity) as q from stock_movements where account_kind = 'WAREHOUSE'`);
    expect(row?.q).toBe('5000.000');
  });
});
