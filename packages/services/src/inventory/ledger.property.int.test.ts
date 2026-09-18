import { packCount, quantity, toBaseUnits, transfer, type DomainError, type Leg, type SkuUnits, type StockAccount, type StockReferenceType } from '@gsa/core';
import { newId } from '@gsa/db';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ownerQuery, resetDatabase } from '../../test/db';
import { anAccount, ctxFor } from '../../test/factories';
import { okraSkus } from '../../test/procurement';
import { createSku } from '../catalogue';
import type { Ctx } from '../context';
import { inTx } from '../platform';
import { findOrCreateBatch, postStockMovements, type BatchRef } from './ledger';

/**
 * NFR-010, TESTING §2.1: random sequences of stock operations — legal and
 * not — against the real database. After every step the ledger must agree
 * with a simple model, and every invariant must hold.
 */

type Sku = 'bag' | 'pouch' | 'seeds';
const UNITS: Record<Sku, SkuUnits> = {
  bag: { measure: 'WEIGHT', packWeightG: '5000' },
  pouch: { measure: 'WEIGHT', packWeightG: '1000' },
  seeds: { measure: 'COUNT', packCount: 500 },
};
const VEHICLES = ['01920000-0000-7000-8000-000000000001', '01920000-0000-7000-8000-000000000002'] as const;

type Op =
  | { kind: 'receive'; sku: Sku; packs: number }
  | { kind: 'issue'; sku: Sku; vehicle: 0 | 1; packs: number }
  | { kind: 'sell'; sku: Sku; vehicle: 0 | 1; packs: number }
  | { kind: 'dispatch'; sku: Sku; packs: number }
  | { kind: 'confirm'; sku: Sku; packs: number }
  | { kind: 'writeOff'; sku: Sku; from: 'WAREHOUSE' | 'DISPATCHED' | 0 | 1; packs: number }
  | { kind: 'return'; sku: Sku; vehicle: 0 | 1; packs: number }
  | { kind: 'convert'; bags: number; pouches: number };

const sku = fc.constantFrom<Sku>('bag', 'pouch', 'seeds');
const packs = fc.integer({ min: 1, max: 12 });
const vehicle = fc.constantFrom<0 | 1>(0, 1);
const op: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant('receive' as const), sku, packs }),
  fc.record({ kind: fc.constant('issue' as const), sku, vehicle, packs }),
  fc.record({ kind: fc.constant('sell' as const), sku, vehicle, packs }),
  fc.record({ kind: fc.constant('dispatch' as const), sku, packs }),
  fc.record({ kind: fc.constant('confirm' as const), sku, packs }),
  fc.record({ kind: fc.constant('writeOff' as const), sku, from: fc.constantFrom<'WAREHOUSE' | 'DISPATCHED' | 0 | 1>('WAREHOUSE', 'DISPATCHED', 0, 1), packs }),
  fc.record({ kind: fc.constant('return' as const), sku, vehicle, packs }),
  fc.record({ kind: fc.constant('convert' as const), bags: fc.integer({ min: 1, max: 4 }), pouches: fc.integer({ min: 1, max: 20 }) }),
);

/** The model: packs per SKU per account. External accounts are tracked as totals. */
type Model = Record<Sku, { WAREHOUSE: number; DISPATCHED: number; v0: number; v1: number; SOLD: number; received: number; writtenOff: number }>;
const emptyModel = (): Model => Object.fromEntries((['bag', 'pouch', 'seeds'] as const).map((s) => [s, { WAREHOUSE: 0, DISPATCHED: 0, v0: 0, v1: 0, SOLD: 0, received: 0, writtenOff: 0 }])) as Model;

async function world() {
  const ctx = await ctxFor(await anAccount('ADMIN'));
  const okra = await okraSkus(ctx);
  const seedsSku = (await createSku(ctx, okra.product.id, { varietyId: okra.variety.id, size: { measure: 'COUNT', count: 500 }, packaging: 'CAN' }))
    .skus.find((s) => s.size.measure === 'COUNT');
  if (!seedsSku) throw new Error('no count SKU');
  const [warehouse] = await ownerQuery<{ id: string }>(`select id from warehouses limit 1`);
  if (!warehouse) throw new Error('no warehouse');
  const batchFor = (skuId: string) => inTx(ctx, (tx) => findOrCreateBatch(tx, ctx, { skuId, lotNumber: 'P1', manufacturedOn: '2026-01-10', expiresOn: '2028-01-10', receivedAt: ctx.now }));
  const batches: Record<Sku, BatchRef> = { bag: await batchFor(okra.bag.id), pouch: await batchFor(okra.pouch.id), seeds: await batchFor(seedsSku.id) };
  return { ctx, batches, wh: { kind: 'WAREHOUSE', warehouseId: warehouse.id } as const };
}

type World = Awaited<ReturnType<typeof world>>;

function plan(w: World, m: Model, o: Op): { legs: Leg[]; ref: StockReferenceType; legal: boolean; apply: () => void } {
  const vAccount = (v: 0 | 1): StockAccount => ({ kind: 'VEHICLE', vehicleId: VEHICLES[v] });
  const move = (s: Sku, n: number, from: StockAccount, to: StockAccount) => transfer(w.batches[s], toBaseUnits(packCount(n), UNITS[s]), from, to);
  switch (o.kind) {
    case 'receive': return { ref: 'GOODS_RECEIPT', legs: move(o.sku, o.packs, { kind: 'SUPPLIER' }, w.wh), legal: true, apply: () => { m[o.sku].WAREHOUSE += o.packs; m[o.sku].received += o.packs; } };
    case 'issue': return { ref: 'VEHICLE_LOADOUT', legs: move(o.sku, o.packs, w.wh, vAccount(o.vehicle)), legal: m[o.sku].WAREHOUSE >= o.packs, apply: () => { m[o.sku].WAREHOUSE -= o.packs; m[o.sku][`v${o.vehicle}`] += o.packs; } };
    case 'sell': return { ref: 'SALE', legs: move(o.sku, o.packs, vAccount(o.vehicle), { kind: 'SOLD' }), legal: m[o.sku][`v${o.vehicle}`] >= o.packs, apply: () => { m[o.sku][`v${o.vehicle}`] -= o.packs; m[o.sku].SOLD += o.packs; } };
    case 'dispatch': return { ref: 'DISPATCH_ORDER', legs: move(o.sku, o.packs, w.wh, { kind: 'DISPATCHED' }), legal: m[o.sku].WAREHOUSE >= o.packs, apply: () => { m[o.sku].WAREHOUSE -= o.packs; m[o.sku].DISPATCHED += o.packs; } };
    case 'confirm': return { ref: 'DISPATCH_ORDER', legs: move(o.sku, o.packs, { kind: 'DISPATCHED' }, { kind: 'SOLD' }), legal: m[o.sku].DISPATCHED >= o.packs, apply: () => { m[o.sku].DISPATCHED -= o.packs; m[o.sku].SOLD += o.packs; } };
    case 'writeOff': {
      const key = o.from === 0 || o.from === 1 ? (`v${o.from}` as const) : o.from;
      const from: StockAccount = o.from === 'WAREHOUSE' ? w.wh : o.from === 'DISPATCHED' ? { kind: 'DISPATCHED' } : vAccount(o.from);
      return { ref: 'WRITE_OFF', legs: move(o.sku, o.packs, from, { kind: 'WRITTEN_OFF' }), legal: m[o.sku][key] >= o.packs, apply: () => { m[o.sku][key] -= o.packs; m[o.sku].writtenOff += o.packs; } };
    }
    case 'return': return { ref: 'RETURN', legs: move(o.sku, o.packs, { kind: 'SOLD' }, vAccount(o.vehicle)), legal: m[o.sku].SOLD >= o.packs, apply: () => { m[o.sku].SOLD -= o.packs; m[o.sku][`v${o.vehicle}`] += o.packs; } };
    case 'convert': {
      // 5 kg bags into 1 kg pouches, the rest lost to write-off: three legs, one group, in grams (DATA-MODEL §3.1).
      const pouches = Math.min(o.pouches, o.bags * 5);
      const lossG = o.bags * 5000 - pouches * 1000;
      const legs: Leg[] = [
        { batchId: w.batches.bag.id, balanceKey: w.batches.bag.balanceKey, account: w.wh, quantity: quantity(`-${o.bags * 5000}`) },
        { batchId: w.batches.pouch.id, balanceKey: w.batches.pouch.balanceKey, account: w.wh, quantity: quantity(`${pouches * 1000}`) },
        ...(lossG > 0 ? [{ batchId: w.batches.bag.id, balanceKey: w.batches.bag.balanceKey, account: { kind: 'WRITTEN_OFF' } as const, quantity: quantity(`${lossG}`) }] : []),
      ];
      return {
        ref: 'SKU_CONVERSION', legs, legal: m.bag.WAREHOUSE >= o.bags,
        apply: () => { m.bag.WAREHOUSE -= o.bags; m.pouch.WAREHOUSE += pouches; m.bag.writtenOff += lossG / 5000; },
      };
    }
  }
}

async function assertInvariants(w: World, m: Model) {
  // Every group balances per batch — per variety for a conversion.
  const unbalanced = await ownerQuery(`
    select group_id from stock_movements m join batches b on b.id = m.batch_id join skus s on s.id = b.sku_id
    group by group_id, case when m.reference_type = 'SKU_CONVERSION' then coalesce(s.variety_id, s.product_id) else m.batch_id end
    having sum(quantity) <> 0`);
  expect(unbalanced).toEqual([]);
  // No internal position is negative, and each is a whole number of packs.
  const bad = await ownerQuery(`
    select p.* from stock_positions p join batches b on b.id = p.batch_id join skus s on s.id = b.sku_id
    where p.account_kind in ('WAREHOUSE', 'VEHICLE', 'DISPATCHED')
      and (p.quantity < 0 or mod(p.quantity, coalesce(s.pack_weight_g, s.pack_count)) <> 0)`);
  expect(bad).toEqual([]);
  // DSP-008: dispatched stock is never on a vehicle.
  expect(await ownerQuery(`select id from stock_movements where account_kind = 'DISPATCHED' and vehicle_id is not null`)).toEqual([]);
  // Held = received − sold − written off, exactly, per variety.
  const [total] = await ownerQuery<{ q: string | null }>(`select sum(quantity) as q from stock_movements`);
  expect(total?.q === null || Number(total?.q) === 0).toBe(true);
  // And the ledger agrees with the model, account by account.
  const rows = await ownerQuery<{ batch_id: string; account_kind: string; vehicle_id: string | null; quantity: string }>(`select batch_id, account_kind, vehicle_id, quantity from stock_positions`);
  for (const s of ['bag', 'pouch', 'seeds'] as const) {
    const size = UNITS[s].measure === 'WEIGHT' ? 5000 / (s === 'bag' ? 1 : 5) : 500;
    const packsIn = (kind: string, vehicleId: string | null = null) =>
      rows.filter((r) => r.batch_id === w.batches[s].id && r.account_kind === kind && r.vehicle_id === vehicleId).reduce((a, r) => a + Number(r.quantity), 0) / size;
    expect([packsIn('WAREHOUSE'), packsIn('DISPATCHED'), packsIn('VEHICLE', VEHICLES[0]), packsIn('VEHICLE', VEHICLES[1]), packsIn('SOLD')])
      .toEqual([m[s].WAREHOUSE, m[s].DISPATCHED, m[s].v0, m[s].v1, m[s].SOLD]);
  }
}

async function run(w: World, ctx: Ctx, m: Model, o: Op) {
  const p = plan(w, m, o);
  const result = await inTx(ctx, (tx) => postStockMovements(tx, ctx, { referenceType: p.ref, referenceId: newId(), legs: p.legs }))
    .then(() => 'OK', (e: DomainError) => e.code ?? String(e));
  // A legal operation is posted; an illegal one is refused and changes nothing.
  expect(result).toBe(p.legal ? 'OK' : 'INSUFFICIENT_STOCK');
  if (p.legal) p.apply();
  await assertInvariants(w, m);
}

describe('ledger properties (NFR-010, TESTING §2.1)', () => {
  it('NFR-010: no sequence of operations leaves a position its movement history cannot explain', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 14 }), async (ops) => {
        await resetDatabase();
        const w = await world();
        const m = emptyModel();
        for (const o of ops) await run(w, w.ctx, m, o);
      }),
      { numRuns: 25 },
    );
  }, 240_000);
});
