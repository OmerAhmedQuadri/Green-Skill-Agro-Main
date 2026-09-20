import {
  assertClosable, auditOutcome, countedPacks, DomainError, isAuditOverdue, packCount, toBaseUnits, transitionAudit,
  type AuditOutcome, type AuditStatus, type CountUnit, type PackSize, type SurplusStatus,
} from '@gsa/core';
import { newId, schema } from '@gsa/db';
import { aliasedTable, and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { sizeOf } from '../catalogue';
import { authorize, authorizeAny, type Ctx } from '../context';
import { batchRefs, postStockMovements } from '../inventory';
import { audit as writeAudit, inTx, nextDocumentNumber, type Executor } from '../platform';
import { getDb } from '../runtime';
import { readSettings } from '../system';
import { unitsOf, vehicleBatches } from './stock';

const { vehicleAudits, vehicleAuditLines, vehicles, vehicleAssignments, users, batches, skus, writeOffs, dispatchOrders, sales } = schema;

type Named = { readonly nameEn: string; readonly nameAr: string };
type Person = { readonly id: string; readonly name: string };

export type AuditLine = {
  readonly id: string; readonly batchId: string; readonly code: string; readonly product: Named; readonly variety: Named | null;
  readonly size: PackSize; readonly countUnit: CountUnit; readonly lotNumber: string | null; readonly expiresOn: string | null;
  readonly expectedPacks: number; readonly countedPacks: number | null; readonly comment: string | null;
  readonly outcome: AuditOutcome | null;
  /** VEH-013: the write-off a shortfall raised, waiting for its own approval. */ readonly writeOffNumber: string | null;
  /** OQ-022: a surplus waits for approval before the stock is added. */
  readonly surplus: { readonly status: SurplusStatus; readonly decidedBy: Person | null; readonly comment: string | null } | null;
};

export type VehicleAudit = {
  readonly id: string; readonly number: string; readonly status: AuditStatus;
  readonly vehicle: { readonly id: string; readonly registration: string };
  readonly seller: Person | null;
  readonly openedAt: Date; readonly openedBy: Person; readonly closedAt: Date | null; readonly closedBy: Person | null;
  readonly note: string | null; readonly version: number;
  readonly lines: readonly AuditLine[];
  /** DSP-010: orders confirmed on the store owner's word since the last audit. */
  readonly remoteConfirmations: readonly { readonly id: string; readonly number: string; readonly store: string; readonly confirmedAt: Date }[];
};

const opener = aliasedTable(users, 'audit_opener');
const closer = aliasedTable(users, 'audit_closer');
const seller = aliasedTable(users, 'audit_seller');
const decider = aliasedTable(users, 'surplus_decider');

export const AUDIT_READERS = ['inventory.audit_vehicle', 'inventory.approve_write_off', 'inventory.view_all_stock'] as const;

/** One audit with its lines, if the caller may see audits at all. */
export async function loadAudit(db: Executor, id: string): Promise<VehicleAudit> {
  const [row] = await db.select({
    a: vehicleAudits, registration: vehicles.registration, sellerName: seller.name, openerName: opener.name, closerName: closer.name,
  }).from(vehicleAudits)
    .innerJoin(vehicles, eq(vehicles.id, vehicleAudits.vehicleId))
    .leftJoin(seller, eq(seller.id, vehicleAudits.sellerId)).leftJoin(opener, eq(opener.id, vehicleAudits.openedBy))
    .leftJoin(closer, eq(closer.id, vehicleAudits.closedBy))
    .where(eq(vehicleAudits.id, id));
  if (!row) throw new DomainError('NOT_FOUND', { entity: 'vehicle_audit', id });
  const a = row.a;
  const lineRows = await db.select({
    l: vehicleAuditLines, sku: skus, lotNumber: batches.lotNumber, expiresOn: batches.expiresOn,
    productEn: sql<string>`(select name_en from products where products.id = ${skus.productId})`,
    productAr: sql<string>`(select name_ar from products where products.id = ${skus.productId})`,
    varietyEn: sql<string | null>`(select name_en from varieties where varieties.id = ${skus.varietyId})`,
    varietyAr: sql<string | null>`(select name_ar from varieties where varieties.id = ${skus.varietyId})`,
    countUnit: sql<CountUnit>`(select count_unit from product_types where product_types.id = (select product_type_id from products where products.id = ${skus.productId}))`,
    writeOffNumber: writeOffs.number, deciderName: decider.name,
  }).from(vehicleAuditLines)
    .innerJoin(batches, eq(batches.id, vehicleAuditLines.batchId)).innerJoin(skus, eq(skus.id, batches.skuId))
    .leftJoin(writeOffs, eq(writeOffs.id, vehicleAuditLines.writeOffId))
    .leftJoin(decider, eq(decider.id, vehicleAuditLines.surplusDecidedBy))
    .where(eq(vehicleAuditLines.auditId, id)).orderBy(asc(skus.code), sql`${batches.expiresOn} asc nulls last`);

  const since = a.openedAt;
  const remote = await db.select({ id: dispatchOrders.id, number: dispatchOrders.number, store: sql<string>`(select name from stores where stores.id = ${dispatchOrders.storeId})`, confirmedAt: dispatchOrders.confirmedAt })
    .from(dispatchOrders).innerJoin(sales, eq(sales.id, dispatchOrders.saleId))
    .where(and(eq(dispatchOrders.confirmationMode, 'OWNER_WORD'), eq(sales.sellerId, a.sellerId ?? ''), sql`${dispatchOrders.confirmedAt} is not null`))
    .orderBy(desc(dispatchOrders.confirmedAt)).limit(50);

  return {
    id: a.id, number: a.number, status: a.status,
    vehicle: { id: a.vehicleId, registration: row.registration },
    seller: a.sellerId ? { id: a.sellerId, name: row.sellerName ?? '' } : null,
    openedAt: a.openedAt, openedBy: { id: a.openedBy, name: row.openerName ?? '' },
    closedAt: a.closedAt, closedBy: a.closedBy ? { id: a.closedBy, name: row.closerName ?? '' } : null,
    note: a.note, version: a.version,
    lines: lineRows.map((r) => ({
      id: r.l.id, batchId: r.l.batchId, code: r.sku.code,
      product: { nameEn: r.productEn, nameAr: r.productAr },
      variety: r.varietyEn !== null && r.varietyAr !== null ? { nameEn: r.varietyEn, nameAr: r.varietyAr } : null,
      size: sizeOf(r.sku), countUnit: r.countUnit, lotNumber: r.lotNumber, expiresOn: r.expiresOn,
      expectedPacks: r.l.expectedPacks, countedPacks: r.l.countedPacks, comment: r.l.comment, outcome: r.l.outcome,
      writeOffNumber: r.writeOffNumber,
      surplus: r.l.surplusStatus
        ? { status: r.l.surplusStatus, decidedBy: r.l.surplusDecidedBy ? { id: r.l.surplusDecidedBy, name: r.deciderName ?? '' } : null, comment: r.l.surplusComment }
        : null,
    })),
    remoteConfirmations: remote.filter((x) => x.confirmedAt && x.confirmedAt >= since).map((x) => ({ id: x.id, number: x.number, store: x.store, confirmedAt: x.confirmedAt as Date })),
  };
}

export async function getVehicleAudit(ctx: Ctx, id: string): Promise<VehicleAudit> {
  authorizeAny(ctx, AUDIT_READERS);
  return loadAudit(ctx.tx ?? getDb(), id);
}

export type AuditSummary = {
  readonly id: string; readonly number: string; readonly status: AuditStatus; readonly openedAt: Date; readonly closedAt: Date | null;
  readonly vehicle: { readonly id: string; readonly registration: string }; readonly seller: Person | null;
  readonly shortfalls: number; readonly surpluses: number;
};

export async function listVehicleAudits(ctx: Ctx, filter: { vehicleId?: string | undefined; status?: AuditStatus | undefined } = {}): Promise<AuditSummary[]> {
  authorizeAny(ctx, AUDIT_READERS);
  const db = ctx.tx ?? getDb();
  const counted = (outcome: AuditOutcome) => sql<number>`(select count(*)::int from ${vehicleAuditLines} l where l.audit_id = ${vehicleAudits.id} and l.outcome = ${outcome})`;
  const rows = await db.select({ a: vehicleAudits, registration: vehicles.registration, sellerName: seller.name, shortfalls: counted('SHORTFALL'), surpluses: counted('SURPLUS') })
    .from(vehicleAudits).innerJoin(vehicles, eq(vehicles.id, vehicleAudits.vehicleId)).leftJoin(seller, eq(seller.id, vehicleAudits.sellerId))
    .where(and(filter.vehicleId ? eq(vehicleAudits.vehicleId, filter.vehicleId) : undefined, filter.status ? eq(vehicleAudits.status, filter.status) : undefined))
    .orderBy(desc(vehicleAudits.openedAt)).limit(100);
  return rows.map((r) => ({
    id: r.a.id, number: r.a.number, status: r.a.status, openedAt: r.a.openedAt, closedAt: r.a.closedAt,
    vehicle: { id: r.a.vehicleId, registration: r.registration }, seller: r.a.sellerId ? { id: r.a.sellerId, name: r.sellerName ?? '' } : null,
    shortfalls: Number(r.shortfalls), surpluses: Number(r.surpluses),
  }));
}

/** Pack sizes for the batches an audit touches — a batch may have left the vehicle since it opened. */
async function sizesOf(db: Executor, batchIds: readonly string[]): Promise<Map<string, PackSize>> {
  if (batchIds.length === 0) return new Map();
  const rows = await db.select({ id: batches.id, sku: skus }).from(batches).innerJoin(skus, eq(skus.id, batches.skuId))
    .where(inArray(batches.id, [...new Set(batchIds)]));
  return new Map(rows.map((r) => [r.id, sizeOf(r.sku)]));
}

/** The lines to count: every batch the vehicle holds now, with the system's figure. */
async function batchLines(db: Executor, vehicleId: string) {
  return (await vehicleBatches(db, [vehicleId])).map((b) => ({ batchId: b.batchId, expectedPacks: b.packs }));
}

/**
 * VEH-011, VEH-014 (STATE-MACHINES §9): a manager opens the count on a
 * vehicle, against the seller who holds it. One open audit per vehicle.
 */
export async function openVehicleAudit(ctx: Ctx, input: { vehicleId: string; note?: string | null | undefined }): Promise<VehicleAudit> {
  authorize(ctx, 'inventory.audit_vehicle');
  return inTx(ctx, async (tx) => {
    const [vehicle] = await tx.select({ id: vehicles.id }).from(vehicles).where(eq(vehicles.id, input.vehicleId));
    if (!vehicle) throw new DomainError('NOT_FOUND', { entity: 'vehicle', id: input.vehicleId });
    const [open] = await tx.select({ id: vehicleAudits.id }).from(vehicleAudits)
      .where(and(eq(vehicleAudits.vehicleId, input.vehicleId), eq(vehicleAudits.status, 'IN_PROGRESS')));
    if (open) throw new DomainError('ALREADY_DECIDED', { entity: 'vehicle_audit', id: open.id });
    const [assignment] = await tx.select({ sellerId: vehicleAssignments.sellerId }).from(vehicleAssignments)
      .where(and(eq(vehicleAssignments.vehicleId, input.vehicleId), isNull(vehicleAssignments.endedAt)));

    const id = newId();
    const number = await nextDocumentNumber(tx, 'VA', ctx.now);
    await tx.insert(vehicleAudits).values({
      id, number, vehicleId: input.vehicleId, sellerId: assignment?.sellerId ?? null, openedAt: ctx.now, openedBy: ctx.user.id,
      note: input.note?.trim() || null, branchId: ctx.branchId, createdBy: ctx.user.id, updatedBy: ctx.user.id,
    });
    const lines = await batchLines(tx, input.vehicleId);
    if (lines.length > 0) {
      await tx.insert(vehicleAuditLines).values(lines.map((l) => ({
        auditId: id, batchId: l.batchId, expectedPacks: l.expectedPacks, createdBy: ctx.user.id, updatedBy: ctx.user.id,
      })));
    }
    await writeAudit(tx, ctx, { action: 'inventory.audit_opened', entityType: 'vehicle_audit', entityId: id, after: { number, vehicleId: input.vehicleId, lines: lines.length } });
    return loadAudit(tx, id);
  });
}

export type CountInput = { readonly version: number; readonly lines: readonly { readonly batchId: string; readonly packs: number; readonly comment?: string | null | undefined }[] };

/** VEH-011, VEH-012: what the manager actually counted, batch by batch, with a comment where it differs. */
export async function recordCount(ctx: Ctx, id: string, input: CountInput): Promise<VehicleAudit> {
  authorize(ctx, 'inventory.audit_vehicle');
  return inTx(ctx, async (tx) => {
    const [row] = await tx.select().from(vehicleAudits).where(eq(vehicleAudits.id, id)).for('update');
    if (!row) throw new DomainError('NOT_FOUND', { entity: 'vehicle_audit', id });
    if (row.status !== 'IN_PROGRESS') throw new DomainError('INVALID_TRANSITION', { from: row.status, action: 'count' });
    if (row.version !== input.version) throw new DomainError('VERSION_CONFLICT', { expected: row.version, given: input.version });
    for (const line of input.lines) {
      const packs = countedPacks(line.packs);
      const [existing] = await tx.select({ id: vehicleAuditLines.id, expectedPacks: vehicleAuditLines.expectedPacks }).from(vehicleAuditLines)
        .where(and(eq(vehicleAuditLines.auditId, id), eq(vehicleAuditLines.batchId, line.batchId)));
      if (!existing) throw new DomainError('NOT_FOUND', { entity: 'batch', id: line.batchId });
      await tx.update(vehicleAuditLines)
        .set({ countedPacks: packs, comment: line.comment?.trim() || null, updatedAt: ctx.now, updatedBy: ctx.user.id })
        .where(eq(vehicleAuditLines.id, existing.id));
    }
    await tx.update(vehicleAudits).set({ version: row.version + 1, updatedAt: ctx.now, updatedBy: ctx.user.id }).where(eq(vehicleAudits.id, id));
    return loadAudit(tx, id);
  });
}

/**
 * VEH-012, VEH-013, OQ-022 (STATE-MACHINES §9): closing needs every batch
 * counted and every difference explained. Shortfalls raise write-offs to be
 * approved like any other; surpluses wait for approval before the stock is
 * added. Batches that arrived while the audit was open join it, counted as
 * zero unless the manager counted them.
 */
export async function closeVehicleAudit(ctx: Ctx, id: string, input: { version: number; note?: string | null | undefined }): Promise<VehicleAudit> {
  authorize(ctx, 'inventory.audit_vehicle');
  return inTx(ctx, async (tx) => {
    const [row] = await tx.select().from(vehicleAudits).where(eq(vehicleAudits.id, id)).for('update');
    if (!row) throw new DomainError('NOT_FOUND', { entity: 'vehicle_audit', id });
    if (row.version !== input.version) throw new DomainError('VERSION_CONFLICT', { expected: row.version, given: input.version });
    const status = transitionAudit(row.status);

    // The position as it stands now — the audit's figures are only as good as the moment it closes.
    const now = await batchLines(tx, row.vehicleId);
    const lines = await tx.select().from(vehicleAuditLines).where(eq(vehicleAuditLines.auditId, id));
    for (const fresh of now.filter((n) => !lines.some((l) => l.batchId === n.batchId))) {
      const [added] = await tx.insert(vehicleAuditLines).values({
        auditId: id, batchId: fresh.batchId, expectedPacks: fresh.expectedPacks, countedPacks: 0, createdBy: ctx.user.id, updatedBy: ctx.user.id,
      }).returning();
      if (added) lines.push(added);
    }
    const current = lines.map((l) => ({ ...l, expectedPacks: now.find((n) => n.batchId === l.batchId)?.expectedPacks ?? 0 }));
    assertClosable(current.map((l) => ({ batchId: l.batchId, expectedPacks: l.expectedPacks, countedPacks: l.countedPacks, comment: l.comment })));

    const sizes = await sizesOf(tx, current.map((l) => l.batchId));
    for (const line of current) {
      const counted = line.countedPacks ?? 0;
      const outcome = auditOutcome(line.expectedPacks, counted);
      const size = sizes.get(line.batchId);
      if (!size) throw new Error('batch missing');
      const units = unitsOf(size);
      let writeOffId: string | null = null;
      if (outcome === 'SHORTFALL') {
        // VEH-013: a shortfall is a write-off request against the vehicle, approved like any other.
        const packs = line.expectedPacks - counted;
        const number = await nextDocumentNumber(tx, 'WO', ctx.now);
        const [wo] = await tx.insert(writeOffs).values({
          number, status: 'SUBMITTED', reason: 'MISSING', note: line.comment, batchId: line.batchId,
          accountKind: 'VEHICLE', warehouseId: null, vehicleId: row.vehicleId,
          requestedPacks: packs, requestedQuantity: toBaseUnits(packCount(packs), units), auditId: id,
          submittedAt: ctx.now, submittedBy: ctx.user.id, branchId: ctx.branchId, createdBy: ctx.user.id, updatedBy: ctx.user.id,
        }).returning({ id: writeOffs.id });
        writeOffId = wo?.id ?? null;
      }
      await tx.update(vehicleAuditLines).set({
        expectedPacks: line.expectedPacks, outcome, writeOffId,
        surplusStatus: outcome === 'SURPLUS' ? 'PENDING' : null,
        updatedAt: ctx.now, updatedBy: ctx.user.id,
      }).where(eq(vehicleAuditLines.id, line.id));
    }

    await tx.update(vehicleAudits).set({
      status, closedAt: ctx.now, closedBy: ctx.user.id, note: input.note?.trim() || row.note,
      version: row.version + 1, updatedAt: ctx.now, updatedBy: ctx.user.id,
    }).where(eq(vehicleAudits.id, id));
    await writeAudit(tx, ctx, {
      action: 'inventory.audit_closed', entityType: 'vehicle_audit', entityId: id,
      after: { number: row.number, shortfalls: current.filter((l) => auditOutcome(l.expectedPacks, l.countedPacks ?? 0) === 'SHORTFALL').length },
    });
    return loadAudit(tx, id);
  });
}

/**
 * OQ-022: stock found over the system's figure is added only once a second
 * manager approves it — `+VEHICLE / −SUPPLIER`, goods entering the business —
 * or is refused with a comment. Never silent, never by the auditor.
 */
export async function decideSurplus(
  ctx: Ctx, auditId: string, input: { lineId: string; approve: boolean; comment?: string | null | undefined },
): Promise<VehicleAudit> {
  authorize(ctx, 'inventory.approve_write_off');
  return inTx(ctx, async (tx) => {
    const [line] = await tx.select().from(vehicleAuditLines).where(and(eq(vehicleAuditLines.id, input.lineId), eq(vehicleAuditLines.auditId, auditId))).for('update');
    if (!line) throw new DomainError('NOT_FOUND', { entity: 'vehicle_audit_line', id: input.lineId });
    if (line.surplusStatus !== 'PENDING') throw new DomainError('ALREADY_DECIDED', { entity: 'surplus', id: input.lineId });
    const [auditRow] = await tx.select({ vehicleId: vehicleAudits.vehicleId, closedBy: vehicleAudits.closedBy, number: vehicleAudits.number })
      .from(vehicleAudits).where(eq(vehicleAudits.id, auditId));
    if (!auditRow) throw new DomainError('NOT_FOUND', { entity: 'vehicle_audit', id: auditId });
    if (auditRow.closedBy === ctx.user.id) throw new DomainError('FOUR_EYES', { entity: 'surplus' });
    const comment = input.comment?.trim() || null;
    if (!input.approve && !comment) throw new DomainError('REASON_REQUIRED', { action: 'reject_surplus' });

    let groupId: string | null = null;
    if (input.approve) {
      const refs = await batchRefs(tx, [line.batchId]);
      const batch = refs.get(line.batchId);
      const size = (await sizesOf(tx, [line.batchId])).get(line.batchId);
      if (!batch || !size) throw new Error('batch missing');
      const packs = (line.countedPacks ?? 0) - line.expectedPacks;
      const amount = toBaseUnits(packCount(packs), unitsOf(size));
      const posted = await postStockMovements(tx, ctx, {
        referenceType: 'VEHICLE_AUDIT', referenceId: auditId,
        legs: [
          { batchId: line.batchId, balanceKey: batch.balanceKey, account: { kind: 'SUPPLIER' }, quantity: `-${amount}` as typeof amount },
          { batchId: line.batchId, balanceKey: batch.balanceKey, account: { kind: 'VEHICLE', vehicleId: auditRow.vehicleId }, quantity: amount },
        ],
      });
      groupId = posted.groupId;
    }
    await tx.update(vehicleAuditLines).set({
      surplusStatus: input.approve ? 'APPROVED' : 'REJECTED', surplusDecidedAt: ctx.now, surplusDecidedBy: ctx.user.id,
      surplusComment: comment, movementGroupId: groupId, updatedAt: ctx.now, updatedBy: ctx.user.id,
    }).where(eq(vehicleAuditLines.id, line.id));
    await writeAudit(tx, ctx, {
      action: input.approve ? 'inventory.surplus_approved' : 'inventory.surplus_rejected', entityType: 'vehicle_audit', entityId: auditId,
      after: { number: auditRow.number, batchId: line.batchId, packs: (line.countedPacks ?? 0) - line.expectedPacks, comment },
    });
    return loadAudit(tx, auditId);
  });
}

export type OverdueVehicle = {
  readonly id: string; readonly registration: string; readonly seller: Person | null;
  readonly lastAuditedAt: Date | null; readonly intervalDays: number;
};

/** VEH-015, OQ-022: vehicles never audited, or not since the Admin's interval — derived when read. */
export async function overdueAudits(ctx: Ctx): Promise<OverdueVehicle[]> {
  authorizeAny(ctx, AUDIT_READERS);
  const db = ctx.tx ?? getDb();
  const intervalDays = (await readSettings(db))['vehicles.audit_interval_days'];
  const rows = await db.select({
    id: vehicles.id, registration: vehicles.registration, sellerId: vehicleAssignments.sellerId, sellerName: seller.name,
    lastAuditedAt: sql<Date | null>`(select max(closed_at) from ${vehicleAudits} va where va.vehicle_id = ${vehicles.id} and va.status = 'CLOSED')`,
  }).from(vehicles)
    .leftJoin(vehicleAssignments, and(eq(vehicleAssignments.vehicleId, vehicles.id), isNull(vehicleAssignments.endedAt)))
    .leftJoin(seller, eq(seller.id, vehicleAssignments.sellerId))
    .where(eq(vehicles.status, 'ACTIVE')).orderBy(asc(vehicles.registration));
  return rows
    .filter((r) => isAuditOverdue(r.lastAuditedAt ? new Date(r.lastAuditedAt) : null, ctx.now, intervalDays))
    .map((r) => ({
      id: r.id, registration: r.registration,
      seller: r.sellerId ? { id: r.sellerId, name: r.sellerName ?? '' } : null,
      lastAuditedAt: r.lastAuditedAt ? new Date(r.lastAuditedAt) : null, intervalDays,
    }));
}


