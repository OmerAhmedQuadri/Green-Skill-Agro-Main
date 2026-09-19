import {
  allocateSale, assertReturnAllowed, assertReturnKind, businessDate, checkReturnLines, creditFor, dec, DomainError, packCount, packsHeld, returnOutcome,
  splitCredit, sumMoney, toBaseUnits, toMoney, toQuantity, type Leg, type Money, type Quantity, type ReturnCondition, type ReturnKind,
  type ReturnOutcome, type StockAccount,
} from '@gsa/core';
import { newId, schema } from '@gsa/db';
import { and, eq, sql } from 'drizzle-orm';
import { sellerVehicleAccount } from '../attendance';
import { postCashRefund } from '../cash';
import { authorize, type Ctx } from '../context';
import { batchRefs, postStockMovements, recordReturnWriteOff } from '../inventory';
import { audit, inTx, nextDocumentNumber, type Tx } from '../platform';
import { sellableBatches } from '../sales';
import { debtsAround, postStoreCredit } from '../stores';
import { batchInfo, heldFromSaleOf, loadReturn, type ReturnRecord } from './access';
import { returnableSale, returnRules, saleLineUnits } from './returnable';

const { returns, returnLines, returnReplacements, sales, warehouses } = schema;

export type RecordReturnInput = {
  readonly saleId: string; readonly kind: ReturnKind; readonly condition: ReturnCondition;
  /** RET-007: `saleable` false sends the packs to write-off; a defect always does. */
  readonly lines: readonly { readonly saleLineId: string; readonly batchId: string; readonly packs: number; readonly saleable?: boolean | undefined }[];
  readonly note?: string | null | undefined;
  /** From the console: the warehouse saleable goods go back to (ADR-0039). */ readonly warehouseId?: string | null | undefined;
};

const lockVehicle = (tx: Tx, vehicleId: string) => tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`vehicle-stock:${vehicleId}`}, 0))`);

type PlannedLine = {
  id: string; saleLineId: string; batchId: string; packs: number; quantity: Quantity; outcome: ReturnOutcome; amount: Money;
  writeOffReason: 'DEFECTIVE' | 'EXPIRED' | 'DAMAGED' | null;
  replacements: { batchId: string; quantity: Quantity; packs: number }[];
};

/**
 * Workflow L (RET-001..012, WRO-007, ADR-0039). One transaction: the stock
 * back on its original batch or written off, a replacement handed over from
 * the vehicle, and — for a credit note — the store ledger settled (this sale
 * first) and any remainder refunded in cash from the seller's cash in hand.
 */
export async function recordReturn(ctx: Ctx, input: RecordReturnInput): Promise<ReturnRecord> {
  authorize(ctx, 'returns.process');
  assertReturnKind(input.kind, input.condition);
  const note = input.note?.trim() || null;

  return inTx(ctx, async (tx) => {
    // Who and where: the seller on their vehicle, or the console into a warehouse.
    const onVehicle = ctx.user.role === 'SELLER';
    const vehicle = onVehicle ? await sellerVehicleAccount(tx, ctx) : null;
    if (!vehicle && input.kind === 'REPLACEMENT') throw new DomainError('REPLACEMENT_NEEDS_VEHICLE');
    if (vehicle) await lockVehicle(tx, vehicle.vehicleId);

    const { sale, ledgerEntryId, completedAt } = await returnableSale(tx, ctx, input.saleId);
    await tx.select({ id: sales.id }).from(sales).where(eq(sales.id, sale.id)).for('update'); // one return at a time per sale
    const debts = await debtsAround(tx, sale.store.id, ledgerEntryId);                         // under the ledger's lock
    assertReturnAllowed(await returnRules(tx), input.condition, { completedAt, unpaid: debts.unpaid }, ctx.now);

    const units = saleLineUnits(sale);
    const { held, credited } = await heldFromSaleOf(tx, sale.id, units);
    checkReturnLines(input.lines, held);

    const today = businessDate(ctx.now);
    const info = await batchInfo(tx, input.lines.map((l) => l.batchId));
    const creditedNow = new Map(credited);
    const planned: PlannedLine[] = input.lines.map((l) => {
      const line = sale.lines.find((x) => x.id === l.saleLineId);
      const u = units.get(l.saleLineId);
      if (!line || !u) throw new DomainError('RETURN_EXCEEDS_HELD', { saleLineId: l.saleLineId });
      const expiresOn = info.get(l.batchId)?.expiresOn ?? null;
      const { outcome, writeOffReason } = returnOutcome(input.condition, l.saleable ?? true, Boolean(expiresOn && expiresOn < today));
      let amount = toMoney(dec('0'));
      if (input.kind === 'CREDIT_NOTE') {
        const before = creditedNow.get(l.saleLineId) ?? 0;
        amount = creditFor({ total: line.total, packs: line.packs }, before, l.packs);
        creditedNow.set(l.saleLineId, before + l.packs);
      }
      return {
        id: newId(), saleLineId: l.saleLineId, batchId: l.batchId, packs: l.packs, quantity: toBaseUnits(packCount(l.packs), u),
        outcome, amount, writeOffReason, replacements: [],
      };
    });

    // RET-010: like for like from the vehicle, soonest expiry first — never an expired pack.
    if (input.kind === 'REPLACEMENT' && vehicle) {
      let pool = (await sellableBatches(tx, vehicle.vehicleId, ctx.now)).filter((b) => !(b.expiresOn && b.expiresOn < today));
      for (const p of planned) {
        const skuId = sale.lines.find((x) => x.id === p.saleLineId)?.skuId ?? '';
        const u = units.get(p.saleLineId);
        if (!u) throw new Error('sale line units missing');
        const [taken] = allocateSale([{ skuId, quantity: p.quantity }], pool);
        for (const a of taken?.allocations ?? []) {
          pool = pool.map((b) => (b.batchId === a.batchId ? { ...b, available: toQuantity(dec(b.available).minus(dec(a.quantity))) } : b));
          p.replacements.push({ batchId: a.batchId, quantity: a.quantity, packs: packsHeld(a.quantity, u) });
        }
      }
    }

    // RET-008, OQ-020: this sale's unpaid part, the store's other debts, then cash back.
    const amount = input.kind === 'CREDIT_NOTE' ? sumMoney(planned.map((p) => p.amount)) : toMoney(dec('0'));
    const split = input.kind === 'CREDIT_NOTE'
      ? splitCredit(amount, input.condition, debts.unpaid, debts.otherDebts)
      : { toSale: amount, toOtherDebts: amount, refund: amount, collectedPortion: amount };
    if (dec(split.refund).gt(0) && !onVehicle) throw new DomainError('REFUND_NEEDS_SELLER', { refund: split.refund });

    // RET-007: saleable goods back where the return is taken; the rest written off.
    let place: StockAccount | null = vehicle;
    if (!vehicle && planned.some((p) => p.outcome === 'RESTOCK')) {
      const [w] = input.warehouseId
        ? await tx.select({ id: warehouses.id }).from(warehouses).where(and(eq(warehouses.id, input.warehouseId), eq(warehouses.isActive, true)))
        : [];
      if (!w) throw new DomainError('NOT_FOUND', { entity: 'warehouse', id: input.warehouseId ?? null });
      place = { kind: 'WAREHOUSE', warehouseId: w.id };
    }
    const refs = await batchRefs(tx, [...planned.map((p) => p.batchId), ...planned.flatMap((p) => p.replacements.map((r) => r.batchId))]);
    const ref = (id: string) => { const b = refs.get(id); if (!b) throw new Error('batch missing'); return b; };
    const legs: Leg[] = planned.flatMap((p) => {
      const to: StockAccount = p.outcome === 'RESTOCK' && place ? place : { kind: 'WRITTEN_OFF' };
      const back: Leg[] = [
        { batchId: p.batchId, balanceKey: ref(p.batchId).balanceKey, account: { kind: 'SOLD' }, quantity: `-${dec(p.quantity).toFixed(3)}` as Quantity },
        { batchId: p.batchId, balanceKey: ref(p.batchId).balanceKey, account: to, quantity: dec(p.quantity).toFixed(3) as Quantity },
      ];
      const handed: Leg[] = vehicle ? p.replacements.flatMap((r) => [
        { batchId: r.batchId, balanceKey: ref(r.batchId).balanceKey, account: vehicle, quantity: `-${dec(r.quantity).toFixed(3)}` as Quantity },
        { batchId: r.batchId, balanceKey: ref(r.batchId).balanceKey, account: { kind: 'SOLD' }, quantity: dec(r.quantity).toFixed(3) as Quantity },
      ]) : [];
      return [...back, ...handed];
    });

    const id = newId();
    const { groupId } = await postStockMovements(tx, ctx, { referenceType: input.kind === 'CREDIT_NOTE' ? 'RETURN' : 'DEFECTIVE_REPLACEMENT', referenceId: id, legs });
    const toLedger = toMoney(dec(split.toSale).plus(dec(split.toOtherDebts)));
    const ledger = dec(toLedger).gt(0)
      ? await postStoreCredit(tx, ctx, { storeId: sale.store.id, entryType: 'CREDIT_NOTE', amount: toLedger, referenceType: 'RETURN', referenceId: id, firstDebitId: ledgerEntryId })
      : null;
    const cashEntryId = dec(split.refund).gt(0)
      ? await postCashRefund(tx, ctx, { sellerId: ctx.user.id, amount: split.refund, referenceType: 'RETURN', referenceId: id })
      : null;

    const number = await nextDocumentNumber(tx, input.kind === 'CREDIT_NOTE' ? 'CN' : 'RP', ctx.now, 6);
    await tx.insert(returns).values({
      id, number, kind: input.kind, condition: input.condition, saleId: sale.id, storeId: sale.store.id, sellerId: sale.seller.id,
      processedBy: ctx.user.id, vehicleId: vehicle?.vehicleId ?? null, warehouseId: place?.kind === 'WAREHOUSE' ? place.warehouseId : null,
      amount, toSale: split.toSale, toOtherDebts: split.toOtherDebts, refund: split.refund, collectedPortion: split.collectedPortion,
      storeLedgerEntryId: ledger?.entryId ?? null, cashLedgerEntryId: cashEntryId, movementGroupId: groupId, note,
      occurredAt: ctx.now, branchId: ctx.branchId,
    });
    await tx.insert(returnLines).values(planned.map((p) => ({
      id: p.id, returnId: id, saleLineId: p.saleLineId, batchId: p.batchId, packs: p.packs, quantity: p.quantity, outcome: p.outcome, amount: p.amount,
    })));
    const handedOver = planned.flatMap((p) => p.replacements.map((r) => ({ returnLineId: p.id, batchId: r.batchId, packs: r.packs, quantity: r.quantity })));
    if (handedOver.length > 0) await tx.insert(returnReplacements).values(handedOver);
    // WRO-007, RET-011: written off at once, already approved.
    for (const p of planned) {
      if (p.outcome !== 'WRITE_OFF' || !p.writeOffReason) continue;
      await recordReturnWriteOff(tx, ctx, { reason: p.writeOffReason, batchId: p.batchId, packs: p.packs, quantity: p.quantity, returnId: id, movementGroupId: groupId, note });
    }

    await audit(tx, ctx, {
      action: input.kind === 'CREDIT_NOTE' ? 'returns.credit_note' : 'returns.replacement', entityType: 'return', entityId: id,
      after: { number, saleId: sale.id, condition: input.condition, amount, refund: split.refund, packs: planned.reduce((s, p) => s + p.packs, 0) },
    });
    return loadReturn(tx, ctx, id);
  });
}
