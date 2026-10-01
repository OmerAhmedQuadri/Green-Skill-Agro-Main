import { businessDate, type DomainError, type PermissionCode } from '@gsa/core';
import { describe, expect, it } from 'vitest';
import { anAccount, ctxFor } from '../../test/factories';
import { aSellingSeller, paid } from '../../test/sales';
import { recordSale } from '../sales';
import { adjustBalance, recordPayment } from '../stores';
import { collectionsView } from './collections';

const code = async (p: Promise<unknown>) => p.then(() => 'NO_ERROR', (e: DomainError) => e.code ?? String(e));
const today = businessDate(new Date());

/**
 * A weekly store that bought 450.00 on account today and paid 150.00 of it —
 * 100.00 in cash and 50.00 by transfer — and owes an old 200.00 besides, due
 * on 1 June.
 */
async function aStoreThatPaidSome() {
  const admin = await ctxFor(await anAccount('ADMIN'));
  const setup = await aSellingSeller(admin, { creditMode: 'WEEKLY', creditLimit: '100000.00' });
  await recordSale(setup.seller.ctx, { storeId: setup.store.id, lines: [{ skuId: setup.bag.id, packs: 3 }] });
  await recordSale(setup.seller.ctx, { storeId: setup.store.id, lines: [{ skuId: setup.bag.id, packs: 2 }] });
  await recordPayment(setup.seller.ctx, { storeId: setup.store.id, ...(await paid(setup.seller.ctx, '100.00')) });
  await recordPayment(setup.seller.ctx, { storeId: setup.store.id, ...(await paid(setup.seller.ctx, '50.00', 'BANK_TRANSFER', 'TRX-77')) });
  await adjustBalance(admin, setup.store.id, { amount: '200.00', reason: 'Opening balance', dueOn: '2026-06-01' });
  return { ...setup, admin };
}

describe('collections (RPT-008, ADR-0048)', () => {
  it('RPT-008: what each seller collected in the period, by method', async () => {
    const s = await aStoreThatPaidSome();
    const view = await collectionsView(s.admin, { from: today, to: today, sellerId: s.seller.account.id });
    expect(view.collected).toMatchObject({ cash: '100.00', bank: '50.00', total: '150.00', payments: 2 });
    expect(view.collected.bySeller.map((r) => [r.seller.id, r.cash, r.bank, r.total, r.payments]))
      .toEqual([[s.seller.account.id, '100.00', '50.00', '150.00', 2]]);
  });

  it('RPT-008: what each store owes now, by how late — whatever the period', async () => {
    const s = await aStoreThatPaidSome();
    const view = await collectionsView(s.admin, { from: today, to: today, storeId: s.store.id });
    // The 150 paid went to the oldest due first — the old 200 came after it, so it is all still owed.
    expect(view.owed.byStore.map((r) => [r.store.id, r.seller?.id, r.aged.total])).toEqual([[s.store.id, s.seller.account.id, '500.00']]);
    expect(view.owed.byStore[0]?.aged).toMatchObject({ NOT_DUE: '300.00', OVER_90: '200.00' });
    // A period before any of it: nothing collected then, the same owed now.
    const before = await collectionsView(s.admin, { from: '2026-01-01', to: '2026-01-31', storeId: s.store.id });
    expect(before.collected).toMatchObject({ total: '0.00', payments: 0, bySeller: [] });
    expect(before.owed.aged.total).toBe('500.00');
  });

  it('RPT-008: the seller and store filters narrow both halves; another store has nothing', async () => {
    const s = await aStoreThatPaidSome();
    const other = await aSellingSeller(s.admin);
    const view = await collectionsView(s.admin, { from: today, to: today, storeId: other.store.id });
    expect(view.collected.total).toBe('0.00');
    expect(view.owed.byStore).toEqual([]);
    const theirs = await collectionsView(s.admin, { from: today, to: today, sellerId: other.seller.account.id });
    expect(theirs.owed.byStore.map((r) => r.store.id)).not.toContain(s.store.id);
  });

  it('ADR-0048: store balances need stores.view_all as well as the reports permission', async () => {
    const s = await aStoreThatPaidSome();
    const manager = async (grants: PermissionCode[]) => ctxFor(await anAccount('MANAGER'), { overrides: new Map(grants.map((g) => [g, true])) });
    expect(await code(collectionsView(await manager(['reports.view_trends']), { from: today, to: today }))).toBe('FORBIDDEN');
    expect(await code(collectionsView(await manager(['stores.view_all']), { from: today, to: today }))).toBe('FORBIDDEN');
    expect(await code(collectionsView(await manager(['reports.view_trends', 'stores.view_all']), { from: today, to: today, storeId: s.store.id })))
      .toBe('NO_ERROR');
    expect(await code(collectionsView(s.seller.ctx, { from: today, to: today }))).toBe('FORBIDDEN');
  });
});
