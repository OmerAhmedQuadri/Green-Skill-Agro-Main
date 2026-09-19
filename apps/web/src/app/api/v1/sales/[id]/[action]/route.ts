import { sales as contract } from '@gsa/contracts';
import { DomainError } from '@gsa/core';
import { dispatch, sales } from '@gsa/services';
import { z } from 'zod';
import { mutation } from '@/server/route';

type P = { id: string; action: string };
const Body = z.record(z.string(), z.unknown());

/** PRC-014: `complete` an approved sale; PRC-015: `withdraw` a pending or approved one; `dispatch` an approved dispatch sale. Seller of record, or whoever raised it. */
export const POST = mutation<typeof Body, P>(Body, async ({ ctx, params, input }) => {
  switch (params.action) {
    case 'complete': return { status: 200, body: await sales.completeSale(ctx, params.id, contract.CompleteSaleRequest.parse(input)) };
    case 'withdraw': return { status: 200, body: await sales.withdrawSale(ctx, params.id, contract.WithdrawSaleRequest.parse(input)) };
    // ADR-0038: an approved dispatch sale goes to the warehouse.
    case 'dispatch': return { status: 200, body: await dispatch.dispatchApprovedSale(ctx, params.id, contract.WithdrawSaleRequest.parse(input)) };
    default: throw new DomainError('NOT_FOUND', { entity: 'action', id: params.action });
  }
});
