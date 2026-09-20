import type { DomainError } from '@gsa/core';
import { describe, expect, it } from 'vitest';
import { ownerQuery } from '../../test/db';
import { anAccount, ctxFor } from '../../test/factories';
import { aSellingSeller } from '../../test/sales';
import { decideWriteOffRequest, getWriteOff, listWriteOffs } from '../inventory';
import { recordSale } from '../sales';
import { updateSettings } from '../system';
import {
  closeVehicleAudit, decideSurplus, getMyVehicle, getVehicleAudit, listVehicleAudits, openVehicleAudit, overdueAudits, recordCount,
} from './index';

const code = async (p: Promise<unknown>) => p.then(() => 'NO_ERROR', (e: DomainError) => e.code ?? String(e));
const admin = async (now?: Date) => ctxFor(await anAccount('ADMIN'), now ? { now } : {});
const days = (n: number) => new Date(Date.now() + n * 86_400_000);
const year = new Date().toISOString().slice(0, 4);
const positions = async (batchId: string) => Object.fromEntries((await ownerQuery<{ account_kind: string; q: string }>(
  'select account_kind, sum(quantity)::text q from stock_movements where batch_id = $1 group by 1', [batchId])).map((r) => [r.account_kind, r.q]));

/** A seller with ten bags on the vehicle, and the manager who audits them. */
async function aVehicleToAudit() {
  const ctx = await admin();
  const setup = await aSellingSeller(ctx);
  const mine = await getMyVehicle(setup.seller.ctx);
  if (!mine.vehicle) throw new Error('the seller has no vehicle');
  return { ...setup, admin: ctx, vehicleId: mine.vehicle.id };
}

describe('auditing a vehicle (workflow N, VEH-011..015)', () => {
  it('VEH-011, VEH-014: the count opens against the vehicle and its seller, with the system\'s figure per batch', async () => {
    const { admin: ctx, seller, vehicleId, bagBatch } = await aVehicleToAudit();
    const opened = await openVehicleAudit(ctx, { vehicleId });
    expect(opened).toMatchObject({
      number: `VA-${year}-0001`, status: 'IN_PROGRESS', vehicle: { id: vehicleId }, seller: { id: seller.account.id },
      openedBy: { id: ctx.user.id },
      lines: [{ batchId: bagBatch.batchId, code: 'OKRA-PK-5KG', expectedPacks: 10, countedPacks: null, outcome: null }],
    });
    // STATE-MACHINES §9: one open audit per vehicle.
    expect(await code(openVehicleAudit(ctx, { vehicleId }))).toBe('ALREADY_DECIDED');
    expect((await listVehicleAudits(ctx, { vehicleId })).map((a) => a.id)).toEqual([opened.id]);
  });

  it('VEH-012: every batch must be counted and every difference explained before it closes', async () => {
    const { admin: ctx, vehicleId, bagBatch } = await aVehicleToAudit();
    const opened = await openVehicleAudit(ctx, { vehicleId });
    expect(await code(closeVehicleAudit(ctx, opened.id, { version: opened.version }))).toBe('AUDIT_NOT_COUNTED');
    const counted = await recordCount(ctx, opened.id, { version: opened.version, lines: [{ batchId: bagBatch.batchId, packs: 8 }] });
    expect(counted.lines[0]).toMatchObject({ countedPacks: 8, comment: null });
    expect(await code(closeVehicleAudit(ctx, counted.id, { version: counted.version }))).toBe('REASON_REQUIRED');
    expect(await code(recordCount(ctx, opened.id, { version: counted.version, lines: [{ batchId: bagBatch.batchId, packs: -1 }] }))).toBe('INVALID_PACK_COUNT');
  });

  it('VEH-013: a shortfall closes into a write-off for approval — the stock moves only when that is approved', async () => {
    const { admin: ctx, vehicleId, bagBatch } = await aVehicleToAudit();
    const opened = await openVehicleAudit(ctx, { vehicleId });
    const counted = await recordCount(ctx, opened.id, { version: opened.version, lines: [{ batchId: bagBatch.batchId, packs: 8, comment: 'Two bags missing since Tuesday' }] });
    const closed = await closeVehicleAudit(ctx, counted.id, { version: counted.version });
    expect(closed).toMatchObject({ status: 'CLOSED', closedBy: { id: ctx.user.id }, lines: [{ outcome: 'SHORTFALL' }] });
    expect(closed.lines[0]?.writeOffNumber).toMatch(/^WO-/);
    expect(await positions(bagBatch.batchId)).toMatchObject({ VEHICLE: '50000.000' }); // nothing has moved yet
    const [request] = (await listWriteOffs(ctx, { status: 'SUBMITTED' })).items.filter((w) => w.number === closed.lines[0]?.writeOffNumber);
    expect(request).toMatchObject({ reason: 'MISSING', requestedPacks: 2, note: 'Two bags missing since Tuesday' });
    const approver = await admin();
    const decided = await decideWriteOffRequest(approver, request?.id ?? '', { version: (await getWriteOff(ctx, request?.id ?? '')).version, approve: true });
    expect(decided.status).toBe('APPROVED');
    expect(await positions(bagBatch.batchId)).toMatchObject({ VEHICLE: '40000.000', WRITTEN_OFF: '10000.000' });
  });

  it('OQ-022: a surplus is added only once another manager approves it — never by the auditor, never silently', async () => {
    const { admin: ctx, vehicleId, bagBatch } = await aVehicleToAudit();
    const opened = await openVehicleAudit(ctx, { vehicleId });
    const counted = await recordCount(ctx, opened.id, { version: opened.version, lines: [{ batchId: bagBatch.batchId, packs: 12, comment: 'Three bags found under the seat' }] });
    const closed = await closeVehicleAudit(ctx, counted.id, { version: counted.version });
    const line = closed.lines[0];
    expect(line).toMatchObject({ outcome: 'SURPLUS', surplus: { status: 'PENDING', decidedBy: null } });
    expect(await positions(bagBatch.batchId)).toMatchObject({ VEHICLE: '50000.000' }); // not added yet
    expect(await code(decideSurplus(ctx, closed.id, { lineId: line?.id ?? '', approve: true }))).toBe('FOUR_EYES');
    const approver = await admin();
    expect(await code(decideSurplus(approver, closed.id, { lineId: line?.id ?? '', approve: false }))).toBe('REASON_REQUIRED');
    const after = await decideSurplus(approver, closed.id, { lineId: line?.id ?? '', approve: true });
    expect(after.lines[0]?.surplus).toMatchObject({ status: 'APPROVED', decidedBy: { id: approver.user.id } });
    expect(await positions(bagBatch.batchId)).toMatchObject({ VEHICLE: '60000.000' });
    // Found stock enters the business: the audit's own posting is +VEHICLE / −SUPPLIER.
    expect(await ownerQuery("select account_kind, quantity from stock_movements where reference_type = 'VEHICLE_AUDIT' and batch_id = $1 order by quantity", [bagBatch.batchId]))
      .toEqual([{ account_kind: 'SUPPLIER', quantity: '-10000.000' }, { account_kind: 'VEHICLE', quantity: '10000.000' }]);
    expect(await code(decideSurplus(approver, closed.id, { lineId: line?.id ?? '', approve: true }))).toBe('ALREADY_DECIDED');
  });

  it('VEH-011: a batch sold while the audit is open joins it at close, counted as zero unless entered', async () => {
    const { admin: ctx, seller, store, bag, vehicleId, bagBatch } = await aVehicleToAudit();
    const opened = await openVehicleAudit(ctx, { vehicleId });
    await recordSale(seller.ctx, { storeId: store.id, lines: [{ skuId: bag.id, packs: 3 }] });   // 10 → 7 on the vehicle
    const counted = await recordCount(ctx, opened.id, { version: opened.version, lines: [{ batchId: bagBatch.batchId, packs: 7 }] });
    const closed = await closeVehicleAudit(ctx, counted.id, { version: counted.version });
    // The figure is the one at close, so counting seven against seven is no variance at all.
    expect(closed.lines[0]).toMatchObject({ expectedPacks: 7, countedPacks: 7, outcome: 'MATCH', writeOffNumber: null });
  });

  it('VEH-015, OQ-022: a vehicle never audited is overdue, and stays under the Admin\'s interval once counted', async () => {
    const { admin: ctx, vehicleId, bagBatch } = await aVehicleToAudit();
    expect((await overdueAudits(ctx)).map((v) => v.id)).toContain(vehicleId);
    const opened = await openVehicleAudit(ctx, { vehicleId });
    const counted = await recordCount(ctx, opened.id, { version: opened.version, lines: [{ batchId: bagBatch.batchId, packs: 10 }] });
    await closeVehicleAudit(ctx, counted.id, { version: counted.version });
    expect((await overdueAudits(ctx)).map((v) => v.id)).not.toContain(vehicleId);
    // Past the interval it is overdue again; the Admin can shorten or lengthen it.
    expect((await overdueAudits(await admin(days(31)))).map((v) => v.id)).toContain(vehicleId);
    await updateSettings(ctx, [{ key: 'vehicles.audit_interval_days', value: 60 }]);
    expect((await overdueAudits(await admin(days(31)))).map((v) => v.id)).not.toContain(vehicleId);
  });

  it('SECURITY §3: auditing needs the permission, and a seller cannot audit their own vehicle', async () => {
    const { seller, vehicleId, admin: ctx } = await aVehicleToAudit();
    expect(await code(openVehicleAudit(seller.ctx, { vehicleId }))).toBe('FORBIDDEN');
    const opened = await openVehicleAudit(ctx, { vehicleId });
    expect(await code(getVehicleAudit(seller.ctx, opened.id))).toBe('FORBIDDEN');
  });
});
