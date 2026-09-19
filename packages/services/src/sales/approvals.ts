import { decideDiscount, DomainError, lineAmounts, percent, sumMoney, transitionSale, type Money, type Percent } from '@gsa/core';
import { schema } from '@gsa/db';
import { eq } from 'drizzle-orm';
import { authorize, authorizeAny, type Ctx } from '../context';
import { notify } from '../notifications';
import { audit, inTx } from '../platform';
import { getDb } from '../runtime';
import { querySales, type SaleFilter, type SaleSummary } from './access';
import { viewSale, type SaleView } from './record';

const { sales, saleLines, discountApprovalRequests, users } = schema;

/** A seller's own sales; with `sales.view_all`, everyone's; an approver, the requests (RPT-009, PRC-012). */
export async function listSales(ctx: Ctx, filter: SaleFilter): Promise<{ items: SaleSummary[]; nextCursor: string | null }> {
  authorizeAny(ctx, ['sales.record', 'sales.view_all', 'sales.approve_discount']);
  return querySales(ctx.tx ?? getDb(), ctx, filter);
}

export type DecideDiscountInput = {
  readonly version: number; readonly approve: boolean;
  readonly lines?: readonly { readonly lineId: string; readonly discount: string }[] | undefined;
  readonly comment?: string | null | undefined;
};

/**
 * PRC-012, PRC-013, PRC-017: approve as requested, approve lower, or reject.
 * The first decision wins — anyone after is told who decided — a request past
 * its time is expired, not decided, and nobody decides their own sale.
 */
export async function decideDiscountRequest(ctx: Ctx, saleId: string, input: DecideDiscountInput): Promise<SaleView> {
  authorize(ctx, 'sales.approve_discount');
  return inTx(ctx, async (tx) => {
    const [row] = await tx.select().from(sales).where(eq(sales.id, saleId)).for('update');
    const [request] = row
      ? await tx.select({ r: discountApprovalRequests, decider: users.name }).from(discountApprovalRequests)
        .leftJoin(users, eq(users.id, discountApprovalRequests.decidedBy)).where(eq(discountApprovalRequests.saleId, saleId))
      : [];
    if (!row || !request) throw new DomainError('NOT_FOUND', { entity: 'sale', id: saleId });
    if (row.status !== 'PENDING_DISCOUNT_APPROVAL' || request.r.status !== 'PENDING') {
      throw new DomainError('ALREADY_DECIDED', { status: request.r.status, by: request.decider, at: request.r.decidedAt ?? request.r.closedAt });
    }
    if (request.r.expiresAt.getTime() <= ctx.now.getTime()) throw new DomainError('ALREADY_DECIDED', { status: 'EXPIRED', at: request.r.expiresAt });
    if (row.version !== input.version) throw new DomainError('VERSION_CONFLICT', { expected: input.version, actual: row.version });
    // Nobody decides a sale they sell or raised (ADR-0038: a manager may raise one for a seller).
    if (row.sellerId === ctx.user.id || row.createdBy === ctx.user.id) throw new DomainError('FOUR_EYES');

    const lines = await tx.select().from(saleLines).where(eq(saleLines.saleId, saleId));
    const decision = decideDiscount(lines.map((l) => ({ id: l.id, requested: l.requestedDiscount as Percent })), {
      approve: input.approve, comment: input.comment,
      discounts: new Map((input.lines ?? []).map((l) => [l.lineId, percent(l.discount.trim())])),
    });
    const comment = input.comment?.trim() || null;
    const common = { decidedAt: ctx.now, decidedBy: ctx.user.id, comment };

    if (decision.outcome === 'REJECTED') {
      transitionSale(row.status, 'reject');
      await tx.update(sales).set({ status: 'CANCELLED', cancelReason: 'REJECTED', cancelledAt: ctx.now, updatedAt: ctx.now, updatedBy: ctx.user.id, version: row.version + 1 })
        .where(eq(sales.id, saleId));
      await tx.update(discountApprovalRequests).set({ status: 'REJECTED', ...common }).where(eq(discountApprovalRequests.id, request.r.id));
    } else {
      const status = transitionSale(row.status, 'approve');
      const totals: { discountAmount: Money; total: Money }[] = [];
      for (const line of lines) {
        const given = decision.discounts.get(line.id) ?? (line.requestedDiscount as Percent);
        const amounts = lineAmounts(line.unitPrice as Money, line.packs, given);
        totals.push(amounts);
        await tx.update(saleLines).set({ discount: given, discountAmount: amounts.discountAmount, total: amounts.total }).where(eq(saleLines.id, line.id));
      }
      await tx.update(sales).set({
        status, discount: sumMoney(totals.map((t) => t.discountAmount)), total: sumMoney(totals.map((t) => t.total)),
        updatedAt: ctx.now, updatedBy: ctx.user.id, version: row.version + 1,
      }).where(eq(sales.id, saleId));
      await tx.update(discountApprovalRequests).set({ status: decision.outcome, ...common }).where(eq(discountApprovalRequests.id, request.r.id));
    }

    const sale = await viewSale(tx, ctx, saleId);
    const kind = decision.outcome === 'REJECTED' ? 'DISCOUNT_REJECTED' : decision.outcome === 'REDUCED' ? 'DISCOUNT_REDUCED' : 'DISCOUNT_APPROVED';
    await notify(tx, ctx, { users: [row.sellerId] }, kind, { store: sale.store.name, total: sale.total, comment }, `/field/sales/${saleId}`);
    await audit(tx, ctx, {
      action: 'sales.discount_decided', entityType: 'sale', entityId: saleId,
      before: { lines: lines.map((l) => ({ lineId: l.id, requested: l.requestedDiscount })), total: row.total },
      after: { outcome: decision.outcome, comment, lines: sale.lines.map((l) => ({ lineId: l.id, discount: l.discount })), total: sale.total },
    });
    return sale;
  });
}
