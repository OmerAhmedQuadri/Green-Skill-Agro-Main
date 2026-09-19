import type { DomainError, PermissionCode } from '@gsa/core';
import { describe, expect, it } from 'vitest';
import { ownerQuery } from '../../test/db';
import { anAccount, ctxFor } from '../../test/factories';
import { aPhoto } from '../../test/media';
import { aStore, basePriceListId, SHOP } from '../../test/stores';
import { aSeller, checkInAs } from '../../test/vehicles';
import { listMyNotifications } from '../notifications';
import { updateSettings, updateToggles } from '../system';
import {
  adjustBalance, checkDuplicates, decideStore, getCreditStatus, getStore, grantCreditOverride, listStoreLedger, listStores,
  reassignStore, recordPayment, setCreditCycle, setStoreActive, updateStoreTerms,
} from './index';

const code = async (p: Promise<unknown>) => p.then(() => 'NO_ERROR', (e: DomainError) => e.code ?? String(e));
const admin = async (now?: Date) => ctxFor(await anAccount('ADMIN'), now ? { now } : {});
const manager = async (grants: PermissionCode[]) => ctxFor(await anAccount('MANAGER'), { overrides: new Map(grants.map((g) => [g, true])) });
/** Riyadh wall-clock time. 2026-10-06 is a Tuesday. */
const t = (day: string, hhmm = '10:00') => new Date(`${day}T${hhmm}:00+03:00`);

describe('onboarding (workflow H, STO-001..010)', () => {
  it('STO-001, STO-002, STO-003, STO-005, STO-006: identity, storefront photo, coordinates and terms; the seller manages it', async () => {
    const seller = await aSeller();
    const store = await aStore(seller.ctx, { name: 'Al Amal Seeds', ownerName: 'Khalid', contactNumber: '050 123 4567', category: 'Nursery', address: 'King Fahd Rd' });
    expect(store).toMatchObject({
      name: 'Al Amal Seeds', ownerName: 'Khalid', contactNumber: '+966501234567', category: 'Nursery', address: 'King Fahd Rd',
      crNumber: null, vatNumber: null, nationalAddress: null, creditMode: 'WEEKLY', creditLimit: '1000.00',
      status: 'PENDING_APPROVAL', seller: { id: seller.account.id },
    });
    expect(store.storefrontMediaId).toBeTruthy();
    expect(store.location.lat).toBeGreaterThan(SHOP.lat);
    const other = await aSeller();
    const theirs = await aPhoto(other.ctx, 'STOREFRONT');
    expect(await code(aStore(seller.ctx, { storefrontPhotoId: theirs }))).toBe('EVIDENCE_REQUIRED');
    expect(await code(aStore(seller.ctx, { contactNumber: '12' }))).toBe('INVALID_PHONE');
  });

  it('STO-004: CR, VAT and National Address are kept when given', async () => {
    const seller = await aSeller();
    const store = await aStore(seller.ctx, { crNumber: '1010123456', vatNumber: '300000000000003', nationalAddress: 'RRRD2929' });
    expect(store).toMatchObject({ crNumber: '1010123456', vatNumber: '300000000000003', nationalAddress: 'RRRD2929' });
  });

  it('STO-008, OQ-006: a store close by, or of a similar name nearby, is shown first and must be acknowledged', async () => {
    const seller = await aSeller();
    const first = await aStore(seller.ctx, { name: 'مؤسسة الأمل للبذور', location: SHOP });
    const near = { lat: SHOP.lat + 60 / 111_195, lng: SHOP.lng };
    expect(await checkDuplicates(seller.ctx, { ...near, name: 'Something Else' })).toMatchObject([{ storeId: first.id, reasons: ['NEARBY'] }]);
    const similar = { lat: SHOP.lat + 700 / 111_195, lng: SHOP.lng };
    expect(await checkDuplicates(seller.ctx, { ...similar, name: 'مؤسسه الامل للبذور' })).toMatchObject([{ storeId: first.id, reasons: ['SIMILAR_NAME'] }]);
    const warned = await aStore(seller.ctx, { name: 'Something Else', location: near }).catch((e: DomainError) => e);
    expect(warned).toMatchObject({ code: 'DUPLICATE_STORE_WARNING', details: { duplicates: [{ storeId: first.id }] } });
    expect((await aStore(seller.ctx, { name: 'Something Else', location: near, acknowledgeDuplicates: true })).name).toBe('Something Else');
  });

  it('CRD-002: only the modes the Admin offers; a custom cycle needs its days', async () => {
    const ctx = await admin();
    const seller = await aSeller();
    await updateSettings(ctx, [{ key: 'credit.monthly_enabled', value: false }]);
    expect(await code(aStore(seller.ctx, { creditMode: 'MONTHLY' }))).toBe('CREDIT_MODE_UNAVAILABLE');
    expect(await code(aStore(seller.ctx, { creditMode: 'CUSTOM' }))).toBe('CREDIT_MODE_UNAVAILABLE');
    expect((await aStore(seller.ctx, { creditMode: 'CUSTOM', creditCycleDays: 21 })).creditCycleDays).toBe(21);
  });

  it('STO-009: a manager approves — never whoever onboarded — and the seller is told; a rejection needs a reason', async () => {
    const ctx = await admin();
    const seller = await aSeller();
    const onBehalf = await aStore(ctx, { sellerId: seller.account.id });
    expect(onBehalf.seller?.id).toBe(seller.account.id);
    expect(await code(decideStore(ctx, onBehalf.id, 'approve', { version: onBehalf.version }))).toBe('FOUR_EYES');
    expect((await listMyNotifications(ctx)).items.map((n) => n.kind)).not.toContain('STORE_PENDING_APPROVAL'); // own action
    const approver = await admin();
    expect((await listMyNotifications(approver)).items).toEqual([]); // created after the store
    const own = await aStore(seller.ctx);
    expect((await listMyNotifications(approver)).items.map((n) => n.kind)).toContain('STORE_PENDING_APPROVAL');
    expect((await decideStore(approver, own.id, 'approve', { version: own.version })).status).toBe('ACTIVE');
    expect((await listMyNotifications(seller.ctx)).items.map((n) => n.kind)).toContain('STORE_APPROVED');
    expect(await code(decideStore(approver, onBehalf.id, 'reject', { version: onBehalf.version, reason: '' }))).toBe('REASON_REQUIRED');
    expect((await decideStore(approver, onBehalf.id, 'reject', { version: onBehalf.version, reason: 'Duplicate' })).status).toBe('REJECTED');
  });

  it('STO-010: with approval off, a new store is active at once', async () => {
    const ctx = await admin();
    await updateToggles(ctx, [{ key: 'stores.approval_required', enabled: false }]);
    const seller = await aSeller();
    expect((await aStore(seller.ctx)).status).toBe('ACTIVE');
  });

  it('STO-006, STO-007: a seller sees their own stores; reassignment keeps who held the account and when', async () => {
    const a = await aSeller();
    const b = await aSeller();
    const store = await aStore(a.ctx);
    const ctx = await admin(); // a request's clock is read when it arrives
    expect(await code(getStore(b.ctx, store.id))).toBe('NOT_FOUND');
    expect((await listStores(a.ctx)).map((s) => s.id)).toEqual([store.id]);
    const moved = await reassignStore(ctx, store.id, { sellerId: b.account.id, note: 'Route change' });
    expect(moved.assignments.map((h) => [h.sellerId, h.endedAt === null])).toEqual([[b.account.id, true], [a.account.id, false]]);
    expect(await code(getStore(a.ctx, store.id))).toBe('NOT_FOUND');
    expect((await getStore(b.ctx, store.id)).name).toBe(store.name);
    expect(await code(reassignStore(await manager(['stores.view_all']), store.id, { sellerId: a.account.id }))).toBe('FORBIDDEN');
  });

  it('STO-005, OQ-010: a manager changes limit and price list; the seller may change the cycle of their own store', async () => {
    const ctx = await admin();
    const seller = await aSeller();
    const store = await aStore(seller.ctx);
    const terms = await updateStoreTerms(ctx, store.id, { version: store.version, creditLimit: '2500.50', priceListId: await basePriceListId() });
    expect(terms.creditLimit).toBe('2500.50');
    expect(await code(updateStoreTerms(seller.ctx, store.id, { version: terms.version, creditLimit: '1' }))).toBe('FORBIDDEN');
    expect((await setCreditCycle(seller.ctx, store.id, { version: terms.version, creditMode: 'CUSTOM', creditCycleDays: 10 })).creditMode).toBe('CUSTOM');
    const approved = await decideStore(ctx, store.id, 'approve', { version: terms.version + 1 });
    expect((await setStoreActive(ctx, store.id, { version: approved.version, active: false })).status).toBe('INACTIVE');
  });
});

describe('credit (CRD-001..007, OQ-018)', () => {
  async function activeStore(opts: { creditMode?: 'WEEKLY' | 'MONTHLY' | 'CUSTOM' | 'BILL_TO_BILL'; creditCycleDays?: number; creditLimit?: string } = {}) {
    const ctx = await admin(t('2026-10-06'));
    const seller = await aSeller(t('2026-10-06'));
    const store = await aStore(seller.ctx, opts);
    await decideStore(await admin(t('2026-10-06')), store.id, 'approve', { version: store.version });
    return { ctx, seller, store };
  }

  it('CRD-001, OQ-018: a debt falls due by the store\'s cycle as posted — weekly on the Saturday closing its week', async () => {
    const { ctx, store } = await activeStore();
    await adjustBalance(ctx, store.id, { amount: '300.00', reason: 'Opening balance' });
    const [entry] = await listStoreLedger(ctx, store.id);
    expect(entry).toMatchObject({ entryType: 'ADJUSTMENT', amount: '300.00', dueOn: '2026-10-10', open: '300.00', balance: '300.00', note: 'Opening balance' });
    const later = await ctxFor({ id: ctx.user.id, role: 'ADMIN' }, { now: t('2026-10-10', '23:00') });
    expect(await getCreditStatus(later, store.id)).toMatchObject({ blocked: false, outstanding: '300.00' }); // due today, not yet past
  });

  it('CRD-004, CRD-005: a store past due is blocked with the reason and the oldest due date; paying clears it', async () => {
    const { ctx, seller, store } = await activeStore();
    await adjustBalance(ctx, store.id, { amount: '400.00', reason: 'Opening balance', dueOn: '2026-10-01' });
    const status = await getCreditStatus(seller.ctx, store.id);
    expect(status).toMatchObject({ blocked: true, pastDue: '400.00', reasons: [{ code: 'PAST_DUE', amount: '400.00', oldestDueOn: '2026-10-01' }] });
    const working = await ctxFor(seller.account, { now: t('2026-10-06', '11:00') });
    expect(await code(recordPayment(working, { storeId: store.id, amount: '100.00', method: 'CASH' }))).toBe('CHECK_IN_REQUIRED');
    await checkInAs(working, { withoutVehicle: true });
    const partial = await recordPayment(working, { storeId: store.id, amount: '150.00', method: 'CASH' });
    expect(partial.number).toMatch(/^PM-2026-\d{4}$/);
    expect(partial.credit).toMatchObject({ blocked: true, pastDue: '250.00', outstanding: '250.00' }); // CRD-003: the rest carries forward
    const full = await recordPayment(working, { storeId: store.id, amount: '250.00', method: 'BANK_TRANSFER', reference: 'TRX-991' });
    expect(full.credit).toMatchObject({ blocked: false, outstanding: '0.00' });
    expect(await code(recordPayment(working, { storeId: store.id, amount: '0.01', method: 'CASH' }))).toBe('PAYMENT_EXCEEDS_BALANCE');
    expect(await code(recordPayment(working, { storeId: store.id, amount: '1.00', method: 'BANK_TRANSFER' }))).toBe('REASON_REQUIRED');
  });

  it('CRD-003: payments settle the oldest due debts first, and the ledger keeps a running balance', async () => {
    const { ctx, seller, store } = await activeStore();
    await adjustBalance(ctx, store.id, { amount: '100.00', reason: 'Later debt', dueOn: '2026-10-20' });
    await adjustBalance(ctx, store.id, { amount: '200.00', reason: 'Older debt', dueOn: '2026-10-10' });
    await checkInAs(seller.ctx, { withoutVehicle: true });
    await recordPayment(seller.ctx, { storeId: store.id, amount: '250.00', method: 'CASH' });
    const ledger = await listStoreLedger(seller.ctx, store.id);
    expect(ledger.map((e) => [e.entryType, e.amount, e.balance, e.open])).toEqual([
      ['ADJUSTMENT', '100.00', '100.00', '50.00'],
      ['ADJUSTMENT', '200.00', '300.00', '0.00'],
      ['PAYMENT', '-250.00', '50.00', null],
    ]);
    await adjustBalance(ctx, store.id, { amount: '-50.00', reason: 'Goodwill' });
    expect((await getCreditStatus(ctx, store.id)).outstanding).toBe('0.00');
  });

  it('CRD-004: owing more than the limit blocks; a limit of 0 means no credit at all', async () => {
    const { ctx, store } = await activeStore({ creditLimit: '500.00' });
    await adjustBalance(ctx, store.id, { amount: '500.00', reason: 'At the limit' });
    expect((await getCreditStatus(ctx, store.id)).blocked).toBe(false);
    await adjustBalance(ctx, store.id, { amount: '0.01', reason: 'Over' });
    expect((await getCreditStatus(ctx, store.id)).reasons).toEqual([{ code: 'OVER_LIMIT', outstanding: '500.01', limit: '500.00' }]);
    const zero = await activeStore({ creditLimit: '0.00' });
    await adjustBalance(zero.ctx, zero.store.id, { amount: '1.00', reason: 'Any debt' });
    expect((await getCreditStatus(zero.ctx, zero.store.id)).blocked).toBe(true);
  });

  it('OQ-018: the grace setting gives days after the due date before a store is blocked', async () => {
    const { ctx, store } = await activeStore();
    await adjustBalance(ctx, store.id, { amount: '100.00', reason: 'Debt', dueOn: '2026-10-04' });
    expect((await getCreditStatus(ctx, store.id)).blocked).toBe(true);
    await updateSettings(await admin(), [{ key: 'credit.grace_days', value: 3 }]);
    expect((await getCreditStatus(ctx, store.id)).blocked).toBe(false);
  });

  it('CRD-006, CRD-007, OQ-018: a delegated manager releases a blocked store for one sale today, with a reason', async () => {
    const { ctx, seller, store } = await activeStore();
    expect(await code(grantCreditOverride(ctx, store.id, { reason: 'Nothing owed' }))).toBe('NOT_BLOCKED');
    await adjustBalance(ctx, store.id, { amount: '100.00', reason: 'Debt', dueOn: '2026-10-01' });
    const plain = await manager(['stores.view_all']);
    expect(await code(grantCreditOverride(plain, store.id, { reason: 'x' }))).toBe('FORBIDDEN');
    const delegated = await ctxFor(await anAccount('MANAGER'), { now: t('2026-10-06'), overrides: new Map([['stores.override_credit_block', true], ['stores.view_all', true]]) });
    expect(await code(grantCreditOverride(delegated, store.id, { reason: ' ' }))).toBe('REASON_REQUIRED');
    const released = await grantCreditOverride(delegated, store.id, { reason: 'Owner paying tomorrow, confirmed by phone' });
    expect(released).toMatchObject({ blocked: false, overridden: true, reasons: [{ code: 'PAST_DUE' }] });
    expect((await listMyNotifications(seller.ctx)).items.map((n) => n.kind)).toContain('CREDIT_OVERRIDE_GRANTED');
    const tomorrow = await ctxFor(seller.account, { now: t('2026-10-07') });
    expect((await getCreditStatus(tomorrow, store.id)).blocked).toBe(true); // lapses at midnight
  });

  it('STO-009, CRD-006: a store not yet approved cannot be sold to, and no override changes that', async () => {
    const ctx = await admin(t('2026-10-06'));
    const seller = await aSeller(t('2026-10-06'));
    const store = await aStore(seller.ctx);
    expect((await getCreditStatus(seller.ctx, store.id)).reasons).toEqual([{ code: 'NOT_APPROVED' }]);
    expect(await code(grantCreditOverride(ctx, store.id, { reason: 'x' }))).toBe('STORE_NOT_ACTIVE');
  });

  it('ADR-0036: the database refuses a credit that settles nothing, even from its owner', async () => {
    const { ctx, store } = await activeStore();
    await adjustBalance(ctx, store.id, { amount: '10.00', reason: 'Debt' });
    const bad = ownerQuery(`insert into store_ledger_entries (id, store_id, occurred_at, entry_type, amount, reference_type, reference_id, branch_id, created_by)
      select gen_random_uuid(), $1, now(), 'PAYMENT', -5, 'PAYMENT', gen_random_uuid(), branch_id, created_by from stores where id = $1`, [store.id]);
    expect(await bad.then(() => 'NO_ERROR', (e: { constraint?: string }) => e.constraint)).toBe('store_credits_allocated');
    expect(await code(adjustBalance(await manager(['stores.view_all']), store.id, { amount: '1', reason: 'x' }))).toBe('FORBIDDEN');
  });
});
