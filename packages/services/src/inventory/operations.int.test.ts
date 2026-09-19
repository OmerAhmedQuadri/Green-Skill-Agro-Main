import type { DomainError, PermissionCode } from '@gsa/core';
import { describe, expect, it } from 'vitest';
import { ownerQuery } from '../../test/db';
import { anAccount, ctxFor } from '../../test/factories';
import { aPhoto } from '../../test/media';
import { okraInWarehouse } from '../../test/stock';
import { createSku, getProduct } from '../catalogue';
import { updateToggles } from '../system';
import { convertStock, decideWriteOffRequest, getSkuStock, getWriteOff, listConversions, listWriteOffs, submitWriteOff } from './index';

const code = async (p: Promise<unknown>) => p.then(() => 'NO_ERROR', (e: DomainError) => e.code ?? String(e));
const admin = async () => ctxFor(await anAccount('ADMIN'));
const manager = async (grants: PermissionCode[]) => ctxFor(await anAccount('MANAGER'), { overrides: new Map(grants.map((g) => [g, true])) });
const warehouse = async () => ctxFor(await anAccount('MANAGER', { preset: 'WAREHOUSE' }), {
  overrides: new Map<PermissionCode, boolean>([['catalogue.view', true], ['inventory.view_all_stock', true], ['inventory.convert', true], ['inventory.submit_write_off', true], ['inventory.receive_goods', true]]),
});

async function stockOf(ctx: Awaited<ReturnType<typeof admin>>, skuId: string) {
  const { batches } = await getSkuStock(ctx, skuId);
  return batches.map((b) => ({ lot: b.lotNumber, mfd: b.manufacturedOn, exp: b.expiresOn, warehouse: b.positions.warehouse }));
}

describe('SKU conversion (workflow D, CNV-001..011)', () => {
  it('CNV-001, CNV-005, WRO-006: 4 bags into 19 pouches, the lost kilogram written off, stock reconciled', async () => {
    const ctx = await admin();
    const { bag, pouch } = await okraInWarehouse(ctx);
    const [bagBatch] = (await getSkuStock(ctx, bag.id)).batches;
    if (!bagBatch) throw new Error('no batch');
    const done = await convertStock(ctx, { sourceBatchId: bagBatch.batchId, targetSkuId: pouch.id, sourcePacks: 4, targetPacks: 19, reason: 'Retail demand for pouches' });
    expect(done).toMatchObject({ sourcePacks: 4, targetPacks: 19, lossQuantity: '1000.000', lotNumber: 'W1' });
    expect(done.writeOffNumber).toMatch(/^WO-\d{4}-\d{4}$/);
    expect((await stockOf(ctx, bag.id))[0]?.warehouse).toBe(16);
    expect((await stockOf(ctx, pouch.id)).reduce((a, b) => a + b.warehouse, 0)).toBe(29);
    const [row] = await ownerQuery<{ held: string; out: string }>(`
      select sum(quantity) filter (where account_kind = 'WAREHOUSE') as held, sum(quantity) filter (where account_kind = 'WRITTEN_OFF') as out
      from stock_movements`);
    expect(row).toEqual({ held: '109000.000', out: '1000.000' }); // 100 kg + 10 kg received, 1 kg lost
    const [loss] = await ownerQuery<{ status: string; reason: string; requested_quantity: string }>(`select status, reason, requested_quantity from write_offs`);
    expect(loss).toEqual({ status: 'APPROVED', reason: 'CONVERSION_LOSS', requested_quantity: '1000.000' });
  });

  it('CNV-006: the resulting batch carries the source LOT, manufacturing and expiry dates', async () => {
    const ctx = await admin();
    const { bag, pouch } = await okraInWarehouse(ctx, { expiresOn: '2027-06-30' });
    const [bagBatch] = (await getSkuStock(ctx, bag.id)).batches;
    await convertStock(ctx, { sourceBatchId: bagBatch?.batchId ?? '', targetSkuId: pouch.id, sourcePacks: 1, targetPacks: 5, reason: 'Repack' });
    expect(await stockOf(ctx, pouch.id)).toEqual([{ lot: 'W1', mfd: '2026-01-10', exp: '2027-06-30', warehouse: 15 }]);
  });

  it('CNV-003: smaller packs combine back into larger ones', async () => {
    const ctx = await admin();
    const { bag, pouch } = await okraInWarehouse(ctx);
    const [pouchBatch] = (await getSkuStock(ctx, pouch.id)).batches;
    await convertStock(ctx, { sourceBatchId: pouchBatch?.batchId ?? '', targetSkuId: bag.id, sourcePacks: 10, targetPacks: 2, reason: 'Bulk order' });
    expect((await stockOf(ctx, bag.id))[0]?.warehouse).toBe(22);
  });

  it('CNV-011: the third quantity is derived; a conversion that does not balance is refused', async () => {
    const ctx = await admin();
    const { bag, pouch } = await okraInWarehouse(ctx);
    const [bagBatch] = (await getSkuStock(ctx, bag.id)).batches;
    const id = bagBatch?.batchId ?? '';
    expect(await code(convertStock(ctx, { sourceBatchId: id, targetSkuId: pouch.id, sourcePacks: 2, targetPacks: 9, loss: '2000', reason: 'x' }))).toBe('CONVERSION_UNBALANCED');
    expect((await convertStock(ctx, { sourceBatchId: id, targetSkuId: pouch.id, sourcePacks: 2, loss: '500', reason: 'x' }).catch((e: DomainError) => e)))
      .toMatchObject({ code: 'CONVERSION_UNBALANCED' }); // 9.5 pouches
    expect((await convertStock(ctx, { sourceBatchId: id, targetSkuId: pouch.id, sourcePacks: 2, loss: '1000', reason: 'x' })).targetPacks).toBe(9);
  });

  it('CNV-002, CNV-010: the target is the same product and variety, in the same measure', async () => {
    const ctx = await admin();
    const { bag, product, variety } = await okraInWarehouse(ctx);
    const seeds = (await createSku(ctx, product.id, { varietyId: variety.id, size: { measure: 'COUNT', count: 500 }, packaging: 'CAN' })).skus.find((s) => s.size.measure === 'COUNT');
    const [bagBatch] = (await getSkuStock(ctx, bag.id)).batches;
    expect(await code(convertStock(ctx, { sourceBatchId: bagBatch?.batchId ?? '', targetSkuId: seeds?.id ?? '', sourcePacks: 1, targetPacks: 1, reason: 'x' }))).toBe('INVALID_CONVERSION');
    const other = await okraInWarehouse(ctx); // another Okra product
    expect(await code(convertStock(ctx, { sourceBatchId: bagBatch?.batchId ?? '', targetSkuId: other.pouch.id, sourcePacks: 1, targetPacks: 5, reason: 'x' }))).toBe('INVALID_CONVERSION');
  });

  it('CNV-004: the target SKU\'s price can be set as part of the conversion', async () => {
    const ctx = await admin();
    const { bag, pouch, product } = await okraInWarehouse(ctx);
    const [bagBatch] = (await getSkuStock(ctx, bag.id)).batches;
    await convertStock(ctx, { sourceBatchId: bagBatch?.batchId ?? '', targetSkuId: pouch.id, sourcePacks: 1, targetPacks: 5, reason: 'x', targetBasePrice: '19.50' });
    expect((await getProduct(ctx, product.id)).skus.find((s) => s.id === pouch.id)?.basePrice).toBe('19.50');
    const noPricing = await warehouse();
    expect(await code(convertStock(noPricing, { sourceBatchId: bagBatch?.batchId ?? '', targetSkuId: pouch.id, sourcePacks: 1, targetPacks: 5, reason: 'x', targetBasePrice: '20' }))).toBe('FORBIDDEN');
  });

  it('CNV-007, CNV-008: who, when and why are recorded; a reason is required; nothing waits for approval', async () => {
    const ctx = await admin();
    const { bag, pouch } = await okraInWarehouse(ctx);
    const staff = await warehouse();
    const [bagBatch] = (await getSkuStock(ctx, bag.id)).batches;
    expect(await code(convertStock(staff, { sourceBatchId: bagBatch?.batchId ?? '', targetSkuId: pouch.id, sourcePacks: 1, targetPacks: 5, reason: ' ' }))).toBe('REASON_REQUIRED');
    const done = await convertStock(staff, { sourceBatchId: bagBatch?.batchId ?? '', targetSkuId: pouch.id, sourcePacks: 1, targetPacks: 5, reason: 'Shop order' });
    expect((await listConversions(ctx)).items[0]).toMatchObject({ id: done.id, reason: 'Shop order', performedBy: done.performedBy });
    const [row] = await ownerQuery<{ action: string; actor_id: string }>(`select action, actor_id from audit_log where entity_id = $1`, [done.id]);
    expect(row).toEqual({ action: 'inventory.sku_converted', actor_id: staff.user.id });
  });

  it('CNV-009: a seller converts only when the Admin allows it — and then only on their own vehicle', async () => {
    const ctx = await admin();
    const { bag, pouch } = await okraInWarehouse(ctx);
    const [bagBatch] = (await getSkuStock(ctx, bag.id)).batches;
    const seller = await ctxFor(await anAccount('SELLER'), { overrides: new Map([['inventory.convert', true]]) });
    const attempt = () => convertStock(seller, { sourceBatchId: bagBatch?.batchId ?? '', targetSkuId: pouch.id, sourcePacks: 1, targetPacks: 5, reason: 'Field repack' });
    expect(await code(attempt())).toBe('FEATURE_DISABLED');
    await updateToggles(ctx, [{ key: 'inventory.seller_conversion', enabled: true }]);
    expect(await code(attempt())).toBe('FORBIDDEN'); // warehouse stock is not theirs; their vehicle arrives in M4
  });
});

describe('write-offs (workflow E, WRO-001..006)', () => {
  async function aReport() {
    const ctx = await admin();
    const stock = await okraInWarehouse(ctx);
    const staff = await warehouse();
    const [bagBatch] = (await getSkuStock(ctx, stock.bag.id)).batches;
    const photoId = await aPhoto(staff, 'WRITE_OFF_EVIDENCE');
    const report = await submitWriteOff(staff, { batchId: bagBatch?.batchId ?? '', packs: 3, reason: 'DAMAGED', note: 'Torn bags', photoId });
    return { ctx, staff, stock, report, batchId: bagBatch?.batchId ?? '' };
  }

  it('WRO-001, WRO-002: warehouse staff report SKU, batch, quantity, reason and a photo', async () => {
    const { report } = await aReport();
    expect(report).toMatchObject({ status: 'SUBMITTED', code: 'OKRA-PK-5KG', lotNumber: 'W1', requestedPacks: 3, reason: 'DAMAGED', note: 'Torn bags', location: 'WAREHOUSE' });
    expect(report.photoId).not.toBeNull();
    expect(report.number).toMatch(/^WO-/);
  });

  it('WRO-002: the photo is required, and must be the reporter\'s own confirmed upload', async () => {
    const { staff, batchId } = await aReport();
    expect(await code(submitWriteOff(staff, { batchId, packs: 1, reason: 'DAMAGED' }))).toBe('EVIDENCE_REQUIRED');
    const someoneElses = await aPhoto(await warehouse(), 'WRITE_OFF_EVIDENCE');
    expect(await code(submitWriteOff(staff, { batchId, packs: 1, reason: 'DAMAGED', photoId: someoneElses }))).toBe('EVIDENCE_REQUIRED');
    expect(await code(submitWriteOff(staff, { batchId, packs: 1, reason: 'OTHER', photoId: await aPhoto(staff, 'WRITE_OFF_EVIDENCE') }))).toBe('REASON_REQUIRED');
    expect(await code(submitWriteOff(await ctxFor(await anAccount('MANAGER')), { batchId, packs: 1, reason: 'DAMAGED', photoId: someoneElses }))).toBe('FORBIDDEN');
  });

  it('WRO-003: stock is unchanged until approval — but held, so it cannot be converted meanwhile', async () => {
    const { ctx, stock, batchId } = await aReport();
    expect((await stockOf(ctx, stock.bag.id))[0]?.warehouse).toBe(20);
    expect(await code(convertStock(ctx, { sourceBatchId: batchId, targetSkuId: stock.pouch.id, sourcePacks: 18, targetPacks: 90, reason: 'x' }))).toBe('INSUFFICIENT_STOCK');
    expect(await code(convertStock(ctx, { sourceBatchId: batchId, targetSkuId: stock.pouch.id, sourcePacks: 17, targetPacks: 85, reason: 'x' }))).toBe('NO_ERROR');
  });

  it('WRO-004, WRO-005: a manager approves fewer packs; the holding location\'s stock falls into the write-off ledger', async () => {
    const { stock, report } = await aReport();
    const approver = await manager(['inventory.approve_write_off', 'inventory.view_all_stock']);
    const approved = await decideWriteOffRequest(approver, report.id, { version: report.version, approve: true, approvedPacks: 2, comment: 'One bag is fine' });
    expect(approved).toMatchObject({ status: 'APPROVED', approvedQuantity: '10000.000', decisionComment: 'One bag is fine' });
    expect((await stockOf(approver, stock.bag.id))[0]?.warehouse).toBe(18);
    const [row] = await ownerQuery<{ account_kind: string; warehouse_id: string | null; quantity: string }>(`select account_kind, warehouse_id, quantity from stock_movements where reference_type = 'WRITE_OFF' order by quantity`);
    expect(row).toMatchObject({ account_kind: 'WAREHOUSE', warehouse_id: stock.po.warehouseId, quantity: '-10000.000' });
    expect(await code(decideWriteOffRequest(approver, report.id, { version: approved.version, approve: false, comment: 'x' }))).toBe('ALREADY_DECIDED');
  });

  it('WRO-004: a rejection returns the report with a comment; nothing moves', async () => {
    const { stock, report } = await aReport();
    const approver = await manager(['inventory.approve_write_off', 'inventory.view_all_stock']);
    expect(await code(decideWriteOffRequest(approver, report.id, { version: report.version, approve: false }))).toBe('REASON_REQUIRED');
    const rejected = await decideWriteOffRequest(approver, report.id, { version: report.version, approve: false, comment: 'Still saleable' });
    expect(rejected).toMatchObject({ status: 'REJECTED', decisionComment: 'Still saleable', approvedQuantity: null });
    expect((await stockOf(approver, stock.bag.id))[0]?.warehouse).toBe(20);
  });

  it('WRO-003: the submitter cannot approve their own write-off (four-eyes)', async () => {
    const { report } = await aReport();
    const both = await ctxFor(await anAccount('MANAGER', { preset: 'WAREHOUSE' }), { overrides: new Map<PermissionCode, boolean>([['inventory.approve_write_off', true], ['inventory.submit_write_off', true], ['inventory.view_all_stock', true]]) });
    const photoId = await aPhoto(both, 'WRITE_OFF_EVIDENCE');
    const own = await submitWriteOff(both, { batchId: report.batchId, packs: 1, reason: 'EXPIRED', photoId });
    expect(await code(decideWriteOffRequest(both, own.id, { version: own.version, approve: true }))).toBe('FOUR_EYES');
  });

  it('WRO-001: a submitter sees their own reports; an approver sees all', async () => {
    const { staff, report } = await aReport();
    const other = await warehouse();
    expect((await listWriteOffs(staff)).items.map((w) => w.id)).toEqual([report.id]);
    expect((await listWriteOffs(other)).items).toEqual([]);
    expect(await code(getWriteOff(other, report.id))).toBe('NOT_FOUND');
    expect((await listWriteOffs(await manager(['inventory.approve_write_off']), { status: 'SUBMITTED' })).items.map((w) => w.id)).toContain(report.id);
  });

  it('WRO-001: a seller writes off only their own vehicle stock (M4); warehouse stock is refused', async () => {
    const { batchId } = await aReport();
    const seller = await ctxFor(await anAccount('SELLER'));
    const photoId = await aPhoto(seller, 'WRITE_OFF_EVIDENCE');
    expect(await code(submitWriteOff(seller, { batchId, packs: 1, reason: 'DAMAGED', photoId }))).toBe('FORBIDDEN');
  });
});
