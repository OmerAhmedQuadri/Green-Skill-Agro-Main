import { correctionReason, DomainError, type ImportWarningKind, type ImportWarningResolution, type Money } from '@gsa/core';
import { schema } from '@gsa/db';
import { aliasedTable, and, asc, eq, inArray, isNull, isNotNull } from 'drizzle-orm';
import { authorize, authorizeAny, type Ctx } from '../context';
import { audit, inTx } from '../platform';
import { getDb } from '../runtime';
import { requireCorrectionSession } from './sessions';

const { correctionSessions, importBatches, importWarnings, importedPayments, importedSales, stores, users } = schema;

/** IMP-009: one thing the import could not settle, with what it is about and how it was resolved. */
export type ImportWarningView = {
  readonly id: string; readonly kind: ImportWarningKind; readonly batch: number;
  readonly params: Readonly<Record<string, string | number>>;
  readonly store: { readonly id: string; readonly name: string } | null;
  readonly sale: {
    readonly id: string; readonly book: string; readonly bookRow: number; readonly serial: number; readonly soldOn: string; readonly total: Money;
    readonly store: { readonly id: string; readonly name: string };
  } | null;
  readonly payment: {
    readonly id: string; readonly book: string; readonly bookRow: number; readonly voucherNumber: string | null; readonly paidOn: string;
    readonly amount: Money; readonly storeNameWritten: string;
  } | null;
  readonly resolution: {
    readonly as: ImportWarningResolution; readonly note: string; readonly by: string; readonly at: Date; readonly session: number | null;
  } | null;
};

/** IMP-009: the warnings of the batches in use — the open ones, or those resolved — oldest first. */
export async function listImportWarnings(ctx: Ctx, filter: { resolved?: boolean | undefined } = {}): Promise<ImportWarningView[]> {
  authorizeAny(ctx, ['system.correct_history', 'system.view_audit_log']);
  const db = getDb();
  const resolver = aliasedTable(users, 'resolver');
  const rows = await db.select({ w: importWarnings, batch: importBatches.number, by: resolver.name, session: correctionSessions.number })
    .from(importWarnings)
    .innerJoin(importBatches, eq(importBatches.id, importWarnings.batchId))
    .leftJoin(resolver, eq(resolver.id, importWarnings.resolvedBy))
    .leftJoin(correctionSessions, eq(correctionSessions.id, importWarnings.sessionId))
    .where(and(eq(importBatches.status, 'LOADED'), filter.resolved ? isNotNull(importWarnings.resolution) : isNull(importWarnings.resolution)))
    .orderBy(asc(importBatches.number), asc(importWarnings.createdAt), asc(importWarnings.id));
  const ids = (pick: (w: typeof importWarnings.$inferSelect) => string | null) => [...new Set(rows.flatMap((r) => { const id = pick(r.w); return id ? [id] : []; }))];
  const saleIds = ids((w) => w.importedSaleId);
  const paymentIds = ids((w) => w.importedPaymentId);
  const sales = saleIds.length ? await db.select({ s: importedSales }).from(importedSales).where(inArray(importedSales.id, saleIds)) : [];
  const paid = paymentIds.length ? await db.select({ p: importedPayments }).from(importedPayments).where(inArray(importedPayments.id, paymentIds)) : [];
  const storeIds = [...new Set([...ids((w) => w.storeId), ...sales.map((s) => s.s.storeId)])];
  const names = new Map((storeIds.length ? await db.select({ id: stores.id, name: stores.name }).from(stores).where(inArray(stores.id, storeIds)) : [])
    .map((s) => [s.id, s.name]));
  const saleById = new Map(sales.map((s) => [s.s.id, s.s]));
  const paidById = new Map(paid.map((p) => [p.p.id, p.p]));
  return rows.map((r) => {
    const sale = r.w.importedSaleId ? saleById.get(r.w.importedSaleId) : undefined;
    const payment = r.w.importedPaymentId ? paidById.get(r.w.importedPaymentId) : undefined;
    return {
      id: r.w.id, kind: r.w.kind, batch: r.batch, params: r.w.params as Record<string, string | number>,
      store: r.w.storeId ? { id: r.w.storeId, name: names.get(r.w.storeId) ?? '' } : null,
      sale: sale ? {
        id: sale.id, book: sale.book, bookRow: sale.bookRow, serial: sale.serial, soldOn: sale.soldOn, total: sale.total as Money,
        store: { id: sale.storeId, name: names.get(sale.storeId) ?? '' },
      } : null,
      payment: payment ? {
        id: payment.id, book: payment.book, bookRow: payment.bookRow, voucherNumber: payment.voucherNumber, paidOn: payment.paidOn,
        amount: payment.amount as Money, storeNameWritten: payment.storeNameWritten,
      } : null,
      resolution: r.w.resolution && r.w.resolvedAt ? {
        as: r.w.resolution, note: r.w.resolutionNote ?? '', by: r.by ?? '', at: r.w.resolvedAt, session: r.session,
      } : null,
    };
  });
}

/**
 * IMP-009 (ADR-0059): a warning resolved, once, with a note — kept as it is, or marked corrected, which needs the
 * Super Admin's open correction session, the one the correction was made in.
 */
export async function resolveImportWarning(
  ctx: Ctx, id: string, input: { resolution: ImportWarningResolution; note: string },
): Promise<void> {
  authorize(ctx, 'system.correct_history');
  const note = correctionReason(input.note, 'note');
  await inTx(ctx, async (tx) => {
    const session = input.resolution === 'CORRECTED' ? await requireCorrectionSession(tx, ctx) : null;
    const [resolved] = await tx.update(importWarnings).set({
      resolution: input.resolution, resolutionNote: note, sessionId: session?.id ?? null, resolvedAt: ctx.now, resolvedBy: ctx.user.id,
    }).where(and(eq(importWarnings.id, id), isNull(importWarnings.resolution))).returning({ kind: importWarnings.kind });
    if (!resolved) {
      const [exists] = await tx.select({ id: importWarnings.id }).from(importWarnings).where(eq(importWarnings.id, id));
      throw new DomainError(exists ? 'ALREADY_DECIDED' : 'NOT_FOUND', { entity: 'import_warning', id });
    }
    await audit(tx, ctx, {
      action: 'corrections.import_warning_resolved', entityType: 'import_warning', entityId: id,
      after: { kind: resolved.kind, resolution: input.resolution, note, session: session?.number ?? null },
    });
  });
}
