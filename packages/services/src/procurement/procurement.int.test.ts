import type { DomainError, PermissionCode } from '@gsa/core';
import { describe, expect, it } from 'vitest';
import { ownerQuery } from '../../test/db';
import { anAccount, ctxFor } from '../../test/factories';
import { anOrderInTransit, okraSkus } from '../../test/procurement';
import { listStock } from '../inventory';
import {
  createPurchaseOrder, getPurchaseOrder, listIncoming, listPurchaseOrders, receiveGoods, transitionPurchaseOrder, updatePurchaseOrder,
} from './index';

const code = async (p: Promise<unknown>) => p.then(() => 'NO_ERROR', (e: DomainError) => e.code ?? String(e));
const admin = async () => ctxFor(await anAccount('ADMIN'));
const manager = async (grants: PermissionCode[]) => ctxFor(await anAccount('MANAGER'), { overrides: new Map(grants.map((g) => [g, true])) });
const buyer = () => manager(['procurement.view', 'procurement.manage_po']);

describe('purchase orders (PO-001..008)', () => {
  it('PO-002: an order records vendor, items, quantities, expected unit costs and arrival', async () => {
    const ctx = await admin();
    const okra = await okraSkus(ctx);
    const po = await createPurchaseOrder(ctx, {
      vendorId: okra.vendor.id, expectedArrival: '2026-11-01', notes: 'Autumn stock',
      lines: [{ skuId: okra.bag.id, orderedPacks: 20, expectedUnitCost: '70.50' }],
    });
    expect(po).toMatchObject({
      status: 'DRAFT', vendor: { id: okra.vendor.id }, expectedArrival: '2026-11-01', notes: 'Autumn stock', orderValue: '1410.00',
      lines: [{ code: 'OKRA-PK-5KG', orderedPacks: 20, expectedUnitCost: '70.50', receivedPacks: 0 }],
    });
    expect(po.number).toMatch(/^PO-\d{4}-0001$/);
    const second = await createPurchaseOrder(ctx, { vendorId: okra.vendor.id, lines: [{ skuId: okra.pouch.id, orderedPacks: 1, expectedUnitCost: '1' }] });
    expect(second.number).toMatch(/-0002$/);
  });

  it('PO-001: the order moves through its states, each transition recorded with actor and time', async () => {
    const ctx = await admin();
    const { po } = await anOrderInTransit(ctx);
    expect(po.status).toBe('IN_TRANSIT');
    expect(po.events.map((e) => `${e.action}:${e.to}`)).toEqual([
      'create:DRAFT', 'submit:PENDING_APPROVAL', 'approve:APPROVED', 'place:PLACED', 'despatch:IN_TRANSIT',
    ]);
  });

  it('PO-003: a permitted manager enters and submits; only an Admin approves', async () => {
    const ctx = await admin();
    const okra = await okraSkus(ctx);
    const m = await buyer();
    const draft = await createPurchaseOrder(m, { vendorId: okra.vendor.id, lines: [{ skuId: okra.bag.id, orderedPacks: 5, expectedUnitCost: '70' }] });
    const pending = await transitionPurchaseOrder(m, draft.id, 'submit', { version: draft.version });
    expect(pending.status).toBe('PENDING_APPROVAL');
    expect(await code(transitionPurchaseOrder(m, pending.id, 'approve', { version: pending.version }))).toBe('FORBIDDEN');
    expect(await code(createPurchaseOrder(await manager(['procurement.view']), { vendorId: okra.vendor.id, lines: [{ skuId: okra.bag.id, orderedPacks: 1, expectedUnitCost: '1' }] }))).toBe('FORBIDDEN');
    const approver = await admin(); // a request's clock is read when it arrives
    const rejected = await transitionPurchaseOrder(approver, pending.id, 'reject', { version: pending.version, reason: 'Check the cost' });
    expect(rejected).toMatchObject({ status: 'DRAFT' });
    expect(rejected.events.at(-1)).toMatchObject({ action: 'reject', reason: 'Check the cost' });
  });

  it('PO-003: only a draft is edited, and a stale version is refused', async () => {
    const ctx = await admin();
    const okra = await okraSkus(ctx);
    const draft = await createPurchaseOrder(ctx, { vendorId: okra.vendor.id, lines: [{ skuId: okra.bag.id, orderedPacks: 5, expectedUnitCost: '70' }] });
    const edited = await updatePurchaseOrder(ctx, draft.id, { version: draft.version, lines: [{ skuId: okra.bag.id, orderedPacks: 8, expectedUnitCost: '69' }, { skuId: okra.pouch.id, orderedPacks: 4, expectedUnitCost: '16' }] });
    expect(edited.lines.map((l) => [l.code, l.orderedPacks])).toEqual([['OKRA-PK-1KG', 4], ['OKRA-PK-5KG', 8]]);
    expect(await code(updatePurchaseOrder(ctx, draft.id, { version: draft.version, notes: 'late' }))).toBe('VERSION_CONFLICT');
    const submitted = await transitionPurchaseOrder(ctx, edited.id, 'submit', { version: edited.version });
    expect(await code(updatePurchaseOrder(ctx, submitted.id, { version: submitted.version, notes: 'x' }))).toBe('PO_NOT_EDITABLE');
    expect(await code(createPurchaseOrder(ctx, { vendorId: okra.vendor.id, lines: [{ skuId: okra.bag.id, orderedPacks: 1, expectedUnitCost: '1' }, { skuId: okra.bag.id, orderedPacks: 2, expectedUnitCost: '1' }] }))).toBe('DUPLICATE_SKU');
  });

  it('PO-004, STK-007: an order in transit shows in incoming stock with its expected arrival — not as stock', async () => {
    const ctx = await admin();
    const { po, bag } = await anOrderInTransit(ctx, { expectedArrival: '2026-10-20' });
    const incoming = await listIncoming(ctx);
    expect(incoming.find((l) => l.skuId === bag.id)).toMatchObject({ number: po.number, status: 'IN_TRANSIT', expectedArrival: '2026-10-20', outstandingPacks: 20 });
    const stock = (await listStock(ctx, { search: 'OKRA-PK-5KG' })).items[0];
    expect(stock?.positions).toEqual({ warehouse: 0, vehicles: 0, dispatched: 0, total: 0 });
    expect(stock?.incoming).toEqual({ onOrder: 0, inTransit: 20 });
  });

  it('PO-005, PO-006: cancelling before receipt needs a reason and leaves incoming stock at once', async () => {
    const ctx = await admin();
    const { po, bag } = await anOrderInTransit(ctx);
    expect(await code(transitionPurchaseOrder(ctx, po.id, 'cancel', { version: po.version, reason: '' }))).toBe('REASON_REQUIRED');
    const cancelled = await transitionPurchaseOrder(ctx, po.id, 'cancel', { version: po.version, reason: 'Vendor withdrew' });
    expect(cancelled).toMatchObject({ status: 'CLOSED', closeReason: 'CANCELLED', closeNote: 'Vendor withdrew' });
    expect((await listIncoming(ctx)).filter((l) => l.skuId === bag.id)).toEqual([]);
  });

  it('PO-005: an order with anything received cannot be cancelled — it is closed short', async () => {
    const ctx = await admin();
    const { po, bagLine } = await anOrderInTransit(ctx);
    const part = await receiveGoods(ctx, po.id, { version: po.version, lines: [{ purchaseOrderLineId: bagLine.id, packs: 5, lotNumber: 'L1', manufacturedOn: '2026-01-10' }] });
    expect(await code(transitionPurchaseOrder(ctx, part.id, 'cancel', { version: part.version, reason: 'x' }))).toBe('INVALID_TRANSITION');
  });

  it('PO-007: closed complete, closed short and cancelled are distinguished, each with its reason', async () => {
    const ctx = await admin();
    const a = await anOrderInTransit(ctx);
    const part = await receiveGoods(ctx, a.po.id, { version: a.po.version, lines: [{ purchaseOrderLineId: a.bagLine.id, packs: 20, lotNumber: 'L1', manufacturedOn: '2026-01-10' }] });
    const short = await transitionPurchaseOrder(ctx, part.id, 'close_short', { version: part.version, reason: 'Pouches discontinued' });
    expect(short).toMatchObject({ status: 'CLOSED', closeReason: 'SHORT', closeNote: 'Pouches discontinued' });
    const b = await anOrderInTransit(ctx);
    const full = await receiveGoods(ctx, b.po.id, { version: b.po.version, lines: [
      { purchaseOrderLineId: b.bagLine.id, packs: 20, lotNumber: 'L2', manufacturedOn: '2026-01-10' },
      { purchaseOrderLineId: b.pouchLine.id, packs: 10, lotNumber: 'L2', manufacturedOn: '2026-01-10' },
    ] });
    expect(full).toMatchObject({ status: 'CLOSED', closeReason: 'COMPLETE' });
    expect(full.events.slice(-2).map((e) => e.to)).toEqual(['FULLY_RECEIVED', 'CLOSED']);
    const [row] = await ownerQuery<{ n: number }>(`select count(*)::int as n from purchase_orders where status = 'CLOSED' and close_reason is null`);
    expect(row?.n).toBe(0);
  });

  it('PO-008: a draft proposed by the forecast is reviewed, adjusted and submitted by a manager', async () => {
    const ctx = await admin();
    const okra = await okraSkus(ctx);
    const m = await buyer();
    const proposed = await createPurchaseOrder(m, { vendorId: okra.vendor.id, origin: 'FORECAST', lines: [{ skuId: okra.bag.id, orderedPacks: 30, expectedUnitCost: '70' }] });
    expect(proposed).toMatchObject({ status: 'DRAFT', origin: 'FORECAST' });
    const adjusted = await updatePurchaseOrder(m, proposed.id, { version: proposed.version, lines: [{ skuId: okra.bag.id, orderedPacks: 25, expectedUnitCost: '70' }] });
    expect((await transitionPurchaseOrder(m, adjusted.id, 'submit', { version: adjusted.version })).status).toBe('PENDING_APPROVAL');
  });

  it('PO-001: orders list newest first, filtered by state; reading needs a procurement permission', async () => {
    const ctx = await admin();
    const { po } = await anOrderInTransit(ctx);
    expect((await listPurchaseOrders(ctx, { status: 'IN_TRANSIT' })).items.map((p) => p.id)).toContain(po.id);
    expect((await listPurchaseOrders(ctx, { status: 'DRAFT' })).items.map((p) => p.id)).not.toContain(po.id);
    expect(await code(getPurchaseOrder(await manager(['catalogue.view']), po.id))).toBe('FORBIDDEN');
    expect((await getPurchaseOrder(await manager(['procurement.view']), po.id)).number).toBe(po.number);
  });
});
