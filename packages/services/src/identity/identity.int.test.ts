import type { DomainError } from '@gsa/core';
import { describe, expect, it } from 'vitest';
import { anAccount, ctxFor, meta, PASSWORD } from '../../test/factories';
import { ownerQuery } from '../../test/db';
import { getDb } from '../runtime';
import {
  applyPresetToAccount, changeAccountPermissions, changeMyPassword, createAccount, getMe, listAccounts, resolveSession,
  setAccountStatus, signIn,
} from './index';

const code = async (p: Promise<unknown>) => p.then(() => 'NO_ERROR', (e: DomainError) => e.code ?? String(e));
const minutes = (base: Date, m: number) => new Date(base.getTime() + m * 60_000);

describe('sign-in (ADR-0018, SECURITY §1)', () => {
  it('ADR-0018: signs in by email or by phone in local form; stores only an HMAC of the token', async () => {
    const seller = await anAccount('SELLER', { phone: '+966501112233' });
    const byEmail = await signIn({ identifier: seller.email.toUpperCase(), password: PASSWORD }, meta());
    const byPhone = await signIn({ identifier: '050 111 2233', password: PASSWORD }, meta());
    expect(byEmail.user.id).toBe(seller.id);
    expect(byPhone.user.id).toBe(seller.id);
    const stored = await ownerQuery<{ id: string }>('select id from sessions');
    expect(stored).toHaveLength(2);
    for (const s of stored) {
      expect(s.id).toMatch(/^[0-9a-f]{64}$/);
      expect([byEmail.token, byPhone.token]).not.toContain(s.id);
    }
  });

  it('SECURITY §1: an unknown account and a wrong password are indistinguishable', async () => {
    const seller = await anAccount('SELLER');
    expect(await code(signIn({ identifier: 'nobody@test.local', password: PASSWORD }, meta()))).toBe('INVALID_CREDENTIALS');
    expect(await code(signIn({ identifier: seller.email, password: 'wrong password!' }, meta()))).toBe('INVALID_CREDENTIALS');
  });

  it('SECURITY §1: ten consecutive failures lock the account for fifteen minutes', async () => {
    const seller = await anAccount('SELLER');
    const t0 = new Date('2026-09-18T08:00:00Z');
    // One attempt every 61 s stays under the per-account rate limit.
    for (let i = 0; i < 10; i += 1) {
      expect(await code(signIn({ identifier: seller.email, password: 'wrong password!' }, meta(minutes(t0, i * 1.02))))).toBe('INVALID_CREDENTIALS');
    }
    expect(await code(signIn({ identifier: seller.email, password: PASSWORD }, meta(minutes(t0, 11))))).toBe('ACCOUNT_LOCKED');
    expect(await code(signIn({ identifier: seller.email, password: PASSWORD }, meta(minutes(t0, 26))))).toBe('NO_ERROR');
  });

  it('SECURITY §1: sign-in is rate limited per account', async () => {
    const seller = await anAccount('SELLER');
    const t0 = new Date('2026-09-18T09:00:00Z');
    for (let i = 0; i < 5; i += 1) await code(signIn({ identifier: seller.email, password: 'wrong password!' }, meta(t0)));
    expect(await code(signIn({ identifier: seller.email, password: PASSWORD }, meta(t0)))).toBe('RATE_LIMITED');
  });

  it('a deactivated account is revealed only to someone who knows its password', async () => {
    const seller = await anAccount('SELLER', { status: 'DEACTIVATED' });
    expect(await code(signIn({ identifier: seller.email, password: 'wrong password!' }, meta()))).toBe('INVALID_CREDENTIALS');
    expect(await code(signIn({ identifier: seller.email, password: PASSWORD }, meta()))).toBe('ACCOUNT_DEACTIVATED');
  });

  it('AUD-001: refused sign-ins are audited, without the password', async () => {
    await code(signIn({ identifier: 'nobody@test.local', password: 'secret-attempt-1' }, meta()));
    const [row] = await ownerQuery<{ action: string; after: unknown }>("select action, after from audit_log where action = 'identity.sign_in_refused'");
    expect(row?.after).toEqual({ identifier: 'nobody@test.local', reason: 'UNKNOWN_ACCOUNT' });
    expect(JSON.stringify(row)).not.toContain('secret-attempt-1');
  });
});

describe('sessions (ADR-0010, ADR-0018)', () => {
  it('ADR-0018: a seller session idles out after seven days and is deleted', async () => {
    const seller = await anAccount('SELLER');
    const t0 = new Date('2026-09-18T08:00:00Z');
    const { token } = await signIn({ identifier: seller.email, password: PASSWORD }, meta(t0));
    expect(await resolveSession(token, meta(minutes(t0, 6 * 24 * 60)))).not.toBeNull();
    expect(await resolveSession(token, meta(minutes(t0, 6 * 24 * 60 + 7 * 24 * 60 + 1)))).toBeNull();
    expect(await ownerQuery('select 1 from sessions')).toHaveLength(0);
  });

  it('USR-010: a permission change applies on the user\'s next request', async () => {
    const admin = await anAccount('ADMIN');
    const manager = await anAccount('MANAGER');
    const { token } = await signIn({ identifier: manager.email, password: PASSWORD }, meta());
    expect((await resolveSession(token, meta()))?.ctx.permissions.has('stores.approve')).toBe(false);
    await changeAccountPermissions(await ctxFor(admin), manager.id, [{ permission: 'stores.approve', granted: true }]);
    expect((await resolveSession(token, meta()))?.ctx.permissions.has('stores.approve')).toBe(true);
  });

  it('ADR-0018: deactivation ends every session immediately', async () => {
    const admin = await anAccount('ADMIN');
    const seller = await anAccount('SELLER');
    const { token } = await signIn({ identifier: seller.email, password: PASSWORD }, meta());
    await setAccountStatus(await ctxFor(admin), seller.id, 'DEACTIVATED', 1);
    expect(await resolveSession(token, meta())).toBeNull();
  });
});

describe('account administration (USR)', () => {
  it('USR-003: an Admin cannot create an Admin account', async () => {
    const admin = await anAccount('ADMIN');
    expect(await code(createAccount(await ctxFor(admin), { role: 'ADMIN', name: 'X', email: 'x@test.local' }))).toBe('ACCOUNT_TIER_FORBIDDEN');
  });

  it('ADR-0018: a new account gets a temporary password it must change; changing it rotates sessions', async () => {
    const admin = await anAccount('ADMIN');
    const { account, temporaryPassword } = await createAccount(await ctxFor(admin), { role: 'SELLER', name: 'Omar', phone: '0509998877' });
    expect(account.phone).toBe('+966509998877');

    const first = await signIn({ identifier: '0509998877', password: temporaryPassword }, meta());
    expect(first.user.mustChangePassword).toBe(true);
    const session = await resolveSession(first.token, meta());
    if (!session) throw new Error('expected a session');

    const { token } = await changeMyPassword(session.ctx, { currentPassword: temporaryPassword, newPassword: 'a much better passphrase' }, meta());
    expect(await resolveSession(first.token, meta())).toBeNull();
    const renewed = await resolveSession(token, meta());
    expect(renewed?.mustChangePassword).toBe(false);
    if (!renewed) throw new Error('expected a renewed session');
    expect((await getMe(renewed.ctx)).mustChangePassword).toBe(false);
  });

  it('a duplicate email is refused with a clear error', async () => {
    const admin = await anAccount('ADMIN');
    const seller = await anAccount('SELLER');
    expect(await code(createAccount(await ctxFor(admin), { role: 'SELLER', name: 'Dup', email: seller.email }))).toBe('DUPLICATE_EMAIL');
  });

  it('USR-011: permission changes are audited with the acting Admin, before and after', async () => {
    const admin = await anAccount('ADMIN');
    const manager = await anAccount('MANAGER');
    await changeAccountPermissions(await ctxFor(admin), manager.id, [{ permission: 'cash.approve_settlement', granted: true }]);
    const [row] = await ownerQuery<{ actor_id: string; before: { permissions: string[] }; after: { permissions: string[] } }>(
      "select actor_id, before, after from audit_log where action = 'identity.permissions_changed'");
    expect(row?.actor_id).toBe(admin.id);
    expect(row?.before.permissions).not.toContain('cash.approve_settlement');
    expect(row?.after.permissions).toContain('cash.approve_settlement');
  });

  it('USR-014: applying a preset replaces every Config grant', async () => {
    const admin = await anAccount('ADMIN');
    const manager = await anAccount('MANAGER');
    const ctx = await ctxFor(admin);
    await changeAccountPermissions(ctx, manager.id, [{ permission: 'sales.approve_discount', granted: true }]);
    const after = await applyPresetToAccount(ctx, manager.id, 'WAREHOUSE');
    expect(after.permissions).toContain('inventory.receive_goods');
    expect(after.permissions).not.toContain('sales.approve_discount');
  });

  it('SECURITY §3: an account outside the actor\'s tier is reported as not found', async () => {
    const admin = await anAccount('ADMIN');
    const other = await anAccount('ADMIN');
    expect(await code(setAccountStatus(await ctxFor(admin), other.id, 'DEACTIVATED', 1))).toBe('NOT_FOUND');
  });
});

describe('append-only audit log (ADR-0008, AUD-004)', () => {
  it('AUD-004: the runtime role cannot edit or delete audit history', async () => {
    await code(signIn({ identifier: 'nobody@test.local', password: 'x' }, meta()));
    // Drizzle wraps the driver error; the Postgres error is the cause (SQLSTATE 42501 = insufficient_privilege).
    const sqlState = (p: Promise<unknown>) => p.then(() => 'ALLOWED', (e: { cause?: { code?: string } }) => e.cause?.code);
    expect(await sqlState(getDb().execute("update audit_log set action = 'tampered'"))).toBe('42501');
    expect(await sqlState(getDb().execute('delete from audit_log'))).toBe('42501');
    expect(await ownerQuery('select 1 from audit_log')).toHaveLength(1);
  });
});

describe('Phase 1 has no branch scoping (USR-012, ADR-0004)', () => {
  it('USR-012: every manager holding a permission sees all of that module\'s data, whoever created it', async () => {
    const staffAdmin = new Map([['users.manage_staff', true]] as const);
    const a = await ctxFor(await anAccount('MANAGER'), { overrides: staffAdmin });
    const b = await ctxFor(await anAccount('MANAGER'), { overrides: staffAdmin });
    const byA = await createAccount(a, { role: 'SELLER', name: 'Seller of A', phone: '0501000001' });
    const byB = await createAccount(b, { role: 'SELLER', name: 'Seller of B', phone: '0501000002' });
    for (const ctx of [a, b]) {
      const ids = (await listAccounts(ctx)).items.map((u) => u.id);
      expect(ids).toEqual(expect.arrayContaining([byA.account.id, byB.account.id]));
    }
  });

  it('NFR-007: every table holding operational data carries branch_id, so multi-branch is an addition', async () => {
    // Exempt, each for a reason: the branch table itself; identity plumbing
    // that belongs to a user, not a branch; the permission catalogue synced
    // from code; and what the whole company shares — the product catalogue,
    // the vendor register, prices and system configuration (DATA-MODEL §1.5).
    // A branch-specific price list later is a nullable column, an addition.
    // Lines and events belong to a parent that carries the branch; the
    // document counter is keyed by series, and a branch can be part of the key.
    const exempt = new Set([
      'branches', 'sessions', 'user_permissions', 'permissions', 'permission_presets',
      'permission_preset_grants', 'rate_limits', 'idempotency_keys', 'password_reset_tokens',
      'categories', 'sub_categories', 'product_types', 'product_type_attributes', 'products', 'varieties', 'skus',
      'vendors', 'price_lists', 'price_list_items', 'sku_discount_ceilings',
      'system_settings', 'feature_toggles', 'ceilings', 'commission_rates',
      'purchase_order_lines', 'purchase_order_events', 'goods_receipt_lines', 'document_sequences', 'stock_flags',
    ]);
    const rows = await ownerQuery<{ table_name: string; has_branch: boolean }>(`
      select t.table_name, bool_or(c.column_name = 'branch_id') as has_branch
      from information_schema.tables t join information_schema.columns c using (table_schema, table_name)
      where t.table_schema = 'public' and t.table_type = 'BASE TABLE'
      group by t.table_name order by t.table_name`);
    const missing = rows.filter((r) => !exempt.has(r.table_name) && !r.has_branch).map((r) => r.table_name);
    expect(missing, 'add branch_id, or add the table to the exemptions with a reason').toEqual([]);
    expect(rows.map((r) => r.table_name)).toEqual(expect.arrayContaining(['users', 'audit_log', 'media_assets', 'warehouses']));
  });
});

