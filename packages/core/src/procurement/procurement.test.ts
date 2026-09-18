import { describe, expect, it } from 'vitest';
import { DEFAULT_PRODUCT_TYPES } from '../catalogue';
import type { DomainError } from '../errors';
import type { PermissionCode } from '../identity';
import { checkReceiptLine, resolveReceiptLine, type ReceivingSku } from './receipt-lines';
import { outstandingPacks, poNumber, statusAfterReceipt, transitionPo, type PoAction, type PoStatus } from './transitions';

const code = (fn: () => unknown) => { try { fn(); return 'NO_ERROR'; } catch (e) { return (e as DomainError).code; } };
const perms = (...p: PermissionCode[]) => new Set<PermissionCode>(p);
const manager = perms('procurement.manage_po');
const admin = perms('procurement.manage_po', 'procurement.approve_po');
const go = (s: PoStatus, a: PoAction, p = admin, reason: string | null = null) => transitionPo(s, a, p, reason);

describe('purchase order lifecycle (PO-001, STATE-MACHINES §1)', () => {
  it('PO-001: the order moves through its nine states', () => {
    let s: PoStatus = 'DRAFT';
    for (const a of ['submit', 'approve', 'place', 'confirm', 'despatch'] as const) s = go(s, a).to;
    expect(s).toBe('IN_TRANSIT');
    expect(statusAfterReceipt([{ ordered: 10, received: 4 }])).toBe('PARTIALLY_RECEIVED');
    expect(statusAfterReceipt([{ ordered: 10, received: 10 }, { ordered: 5, received: 6 }])).toBe('FULLY_RECEIVED');
    expect(go('FULLY_RECEIVED', 'close_complete')).toEqual({ to: 'CLOSED', closeReason: 'COMPLETE' });
    expect(go('PLACED', 'despatch').to).toBe('IN_TRANSIT'); // no confirmation seen
  });

  it('PO-003: a manager may enter and submit; approval always rests with an Admin', () => {
    expect(go('DRAFT', 'submit', manager).to).toBe('PENDING_APPROVAL');
    expect(code(() => go('PENDING_APPROVAL', 'approve', manager))).toBe('FORBIDDEN');
    expect(code(() => go('APPROVED', 'place', manager))).toBe('FORBIDDEN');
    expect(go('PENDING_APPROVAL', 'reject', admin, 'Wrong vendor').to).toBe('DRAFT');
    expect(code(() => go('PENDING_APPROVAL', 'reject', admin, ' '))).toBe('REASON_REQUIRED');
  });

  it('PO-005: cancellable before receipt, with a reason; never from a received or closed order', () => {
    expect(go('DRAFT', 'cancel', manager, 'Duplicate')).toEqual({ to: 'CLOSED', closeReason: 'CANCELLED' });
    expect(go('IN_TRANSIT', 'cancel', admin, 'Vendor withdrew')).toEqual({ to: 'CLOSED', closeReason: 'CANCELLED' });
    expect(code(() => go('IN_TRANSIT', 'cancel', manager, 'x'))).toBe('FORBIDDEN'); // approve_po after approval
    expect(code(() => go('DRAFT', 'cancel', manager, null))).toBe('REASON_REQUIRED');
    expect(code(() => go('PARTIALLY_RECEIVED', 'cancel', admin, 'x'))).toBe('INVALID_TRANSITION');
    expect(code(() => go('CLOSED', 'cancel', admin, 'x'))).toBe('INVALID_TRANSITION');
  });

  it('PO-007: closed complete, closed short and cancelled are told apart; short needs a reason', () => {
    expect(go('PARTIALLY_RECEIVED', 'close_short', admin, 'Vendor out of stock').closeReason).toBe('SHORT');
    expect(code(() => go('PARTIALLY_RECEIVED', 'close_short', admin, ''))).toBe('REASON_REQUIRED');
    expect(code(() => go('IN_TRANSIT', 'close_short', admin, 'x'))).toBe('INVALID_TRANSITION');
  });

  it('PO-004, PO-006: only a live order is incoming; a closed or cancelled one leaves the projection', () => {
    expect(outstandingPacks('IN_TRANSIT', 10, 0)).toBe(10);
    expect(outstandingPacks('PARTIALLY_RECEIVED', 10, 4)).toBe(6);
    expect(outstandingPacks('CLOSED', 10, 4)).toBe(0);
    expect(outstandingPacks('DRAFT', 10, 0)).toBe(0);
    expect(poNumber(2026, 7)).toBe('PO-2026-0007');
  });
});

describe('receipt lines (RCV-003..008, CAT-016, CAT-017)', () => {
  const seeds: ReceivingSku = { skuId: 's1', code: 'OKRA-PK-5KG', template: DEFAULT_PRODUCT_TYPES.SEEDS.template, shelfLifeMonths: 24 };
  const essentials: ReceivingSku = { skuId: 's2', code: 'SHAD-1PC', template: DEFAULT_PRODUCT_TYPES.ESSENTIALS.template, shelfLifeMonths: null };

  it('RCV-003, RCV-008: a seed line carries LOT, manufacture and expiry — the batch identity', () => {
    expect(resolveReceiptLine(seeds, { packs: 20, lotNumber: '8251', manufacturedOn: '2026-01-10', expiresOn: '2027-06-30', unitCost: '70.5' }))
      .toEqual({ skuId: 's1', packs: 20, lotNumber: '8251', manufacturedOn: '2026-01-10', expiresOn: '2027-06-30', unitCost: '70.5' });
  });

  it('RCV-006, CAT-017: expiry from a period, or from the product\'s default shelf life', () => {
    expect(resolveReceiptLine(seeds, { packs: 1, lotNumber: 'A', manufacturedOn: '2026-01-10', shelfLife: { years: 1 } }).expiresOn).toBe('2027-01-10');
    expect(resolveReceiptLine(seeds, { packs: 1, lotNumber: 'A', manufacturedOn: '2026-01-10' }).expiresOn).toBe('2028-01-10');
    expect(code(() => resolveReceiptLine({ ...seeds, shelfLifeMonths: null }, { packs: 1, lotNumber: 'A', manufacturedOn: '2026-01-10' }))).toBe('EXPIRY_REQUIRED');
  });

  it('RCV-005: the template\'s required attributes are enforced', () => {
    expect(code(() => resolveReceiptLine(seeds, { packs: 1, manufacturedOn: '2026-01-10', expiresOn: '2027-01-10' }))).toBe('ATTRIBUTE_REQUIRED');
    expect(code(() => resolveReceiptLine(seeds, { packs: 1, lotNumber: 'A', expiresOn: '2027-01-10' }))).toBe('ATTRIBUTE_REQUIRED');
    expect(code(() => resolveReceiptLine(seeds, { packs: 0, lotNumber: 'A', manufacturedOn: '2026-01-10' }))).toBe('INVALID_PACK_COUNT');
    expect(code(() => resolveReceiptLine(seeds, { packs: 2.5, lotNumber: 'A', manufacturedOn: '2026-01-10' }))).toBe('INVALID_PACK_COUNT');
  });

  it('CAT-016: a type with expiry disabled never gets dates or a LOT, whatever is typed', () => {
    expect(resolveReceiptLine(essentials, { packs: 3, lotNumber: 'X1', manufacturedOn: '2026-01-10', expiresOn: '2027-01-10' }))
      .toEqual({ skuId: 's2', packs: 3, lotNumber: null, manufacturedOn: null, expiresOn: null, unitCost: null });
  });

  it('RCV-002: an imported row reports its problem and the field, without throwing', () => {
    expect(checkReceiptLine(seeds, { packs: 1, lotNumber: 'A', manufacturedOn: '2026-13-01' })).toEqual({ error: { code: 'INVALID_DATE', field: 'manufacturedOn' } });
    expect(checkReceiptLine(seeds, { packs: 1, lotNumber: 'A', manufacturedOn: '2026-01-10', unitCost: 'abc' })).toEqual({ error: { code: 'INVALID_MONEY', field: 'unitCost' } });
  });
});
