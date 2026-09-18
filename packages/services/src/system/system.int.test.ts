import type { DomainError, PermissionCode } from '@gsa/core';
import { describe, expect, it } from 'vitest';
import { ownerQuery } from '../../test/db';
import { anAccount, ctxFor } from '../../test/factories';
import {
  getCeilings, getCommissionRates, getSettings, getToggles, readSettings, setCeiling, setCommissionRate, updateSettings,
  updateToggles,
} from './index';

const code = async (p: Promise<unknown>) => p.then(() => 'NO_ERROR', (e: DomainError) => e.code ?? String(e));
const admin = async () => ctxFor(await anAccount('ADMIN'));
const manager = async (grants: PermissionCode[] = []) =>
  ctxFor(await anAccount('MANAGER'), { overrides: new Map(grants.map((g) => [g, true])) });

describe('system settings (SYS-001..009)', () => {
  it('SYS-003: the Admin sets return rules and separate windows', async () => {
    const ctx = await admin();
    await updateSettings(ctx, [
      { key: 'returns.uncleared_payment_allowed', value: false },
      { key: 'returns.defective_window_days', value: 14 },
    ]);
    const s = await readSettings();
    expect(s['returns.uncleared_payment_allowed']).toBe(false);
    expect(s['returns.defective_window_days']).toBe(14);
    expect(s['returns.uncleared_payment_window_days']).toBe(30);
  });

  it('SYS-006: the expiry basis and the default warning window; a category may set its own', async () => {
    const ctx = await admin();
    await updateSettings(ctx, [{ key: 'expiry.rate_basis', value: 'CONSERVATIVE' }, { key: 'expiry.warning_days', value: 120 }]);
    expect((await getSettings(ctx)).values).toMatchObject({ 'expiry.rate_basis': 'CONSERVATIVE', 'expiry.warning_days': 120 });
  });

  it('SYS-007: the unconfirmed-dispatch threshold is configurable', async () => {
    const ctx = await admin();
    await updateSettings(ctx, [{ key: 'dispatch.unconfirmed_after_days', value: 3 }]);
    expect((await readSettings())['dispatch.unconfirmed_after_days']).toBe(3);
    expect(await code(updateSettings(ctx, [{ key: 'dispatch.unconfirmed_after_days', value: 0 }]))).toBe('INVALID_SETTING');
    expect(await code(updateSettings(ctx, [{ key: 'no.such_setting', value: 1 }]))).toBe('INVALID_SETTING');
  });

  it('SYS-001: each setting is governed by its own permission', async () => {
    const returnsOnly = await manager(['returns.set_rules']);
    expect((await getSettings(returnsOnly)).editable).toEqual([
      'returns.uncleared_payment_allowed', 'returns.uncleared_payment_window_days', 'returns.defective_allowed', 'returns.defective_window_days',
    ]);
    expect(await code(updateSettings(returnsOnly, [{ key: 'returns.defective_window_days', value: 10 }]))).toBe('NO_ERROR');
    expect(await code(updateSettings(returnsOnly, [{ key: 'expiry.warning_days', value: 10 }]))).toBe('FORBIDDEN');
    expect(await code(getSettings(await manager()))).toBe('FORBIDDEN');
  });

  it('SYS-009: configuration changes are audited with before and after', async () => {
    const ctx = await admin();
    await updateSettings(ctx, [{ key: 'vehicles.audit_interval_days', value: 14 }]);
    await updateSettings(ctx, [{ key: 'vehicles.audit_interval_days', value: 14 }]); // unchanged: no entry
    const rows = await ownerQuery<{ before: unknown; after: unknown; actor_id: string }>(`select before, after, actor_id from audit_log where action = 'system.settings_changed'`);
    expect(rows).toEqual([{ before: { 'vehicles.audit_interval_days': 30 }, after: { 'vehicles.audit_interval_days': 14 }, actor_id: ctx.user.id }]);
  });

  it('SYS-005: feature toggles are switched by the Admin, audited', async () => {
    const ctx = await admin();
    expect((await getToggles(ctx))['stores.approval_required']).toBe(true);
    expect((await updateToggles(ctx, [{ key: 'stores.approval_required', enabled: false }]))['stores.approval_required']).toBe(false);
    expect(await code(updateToggles(ctx, [{ key: 'nope', enabled: true }]))).toBe('INVALID_SETTING');
    expect(await code(updateToggles(await manager(['catalogue.view']), [{ key: 'stores.approval_required', enabled: true }]))).toBe('FORBIDDEN');
    const [row] = await ownerQuery<{ after: unknown }>(`select after from audit_log where action = 'system.toggles_changed'`);
    expect(row?.after).toEqual({ 'stores.approval_required': false });
  });
});

describe('ceilings and commission (LIM-001, SYS-002, SYS-008)', () => {
  it('LIM-001: ceilings for cash in hand and vehicle stock value, globally and per seller', async () => {
    const ctx = await admin();
    const seller = await anAccount('SELLER');
    await setCeiling(ctx, { kind: 'CASH_IN_HAND', sellerId: null, amount: '5000' });
    await setCeiling(ctx, { kind: 'VEHICLE_STOCK_VALUE', sellerId: null, amount: '20000' });
    const result = await setCeiling(ctx, { kind: 'CASH_IN_HAND', sellerId: seller.id, amount: '8000' });
    expect(result.global).toEqual({ CASH_IN_HAND: '5000.00', VEHICLE_STOCK_VALUE: '20000.00' });
    expect(result.sellers.find((s) => s.sellerId === seller.id)?.effective).toEqual({ CASH_IN_HAND: '8000.00', VEHICLE_STOCK_VALUE: '20000.00' });
  });

  it('SYS-002: removing a seller\'s own ceiling falls back to the global one (OQ-005)', async () => {
    const ctx = await admin();
    const seller = await anAccount('SELLER');
    await setCeiling(ctx, { kind: 'CASH_IN_HAND', sellerId: null, amount: '5000' });
    await setCeiling(ctx, { kind: 'CASH_IN_HAND', sellerId: seller.id, amount: '8000' });
    const after = await setCeiling(ctx, { kind: 'CASH_IN_HAND', sellerId: seller.id, amount: null });
    expect(after.sellers.find((s) => s.sellerId === seller.id)?.effective.CASH_IN_HAND).toBe('5000.00');
    expect(await code(setCeiling(ctx, { kind: 'CASH_IN_HAND', sellerId: (await anAccount('MANAGER')).id, amount: '1' }))).toBe('NOT_FOUND');
    expect(await code(setCeiling(ctx, { kind: 'CASH_IN_HAND', sellerId: null, amount: '0' }))).toBe('INVALID_MONEY');
    expect(await code(getCeilings(await manager(['cash.view_cash_in_hand'])))).toBe('FORBIDDEN');
  });

  it('SYS-008: commission rates per seller, on target and below target', async () => {
    const ctx = await admin();
    const seller = await anAccount('SELLER');
    const rates = await setCommissionRate(ctx, seller.id, { onTarget: '3', belowTarget: '1.5' });
    expect(rates.find((r) => r.sellerId === seller.id)).toMatchObject({ onTarget: '3.000', belowTarget: '1.500' });
    expect(await code(setCommissionRate(ctx, seller.id, { onTarget: '101', belowTarget: '1' }))).toBe('INVALID_PERCENT');
    expect(await code(getCommissionRates(await manager()))).toBe('FORBIDDEN');
    expect((await setCommissionRate(ctx, seller.id, null)).find((r) => r.sellerId === seller.id)?.onTarget).toBeNull();
  });
});
