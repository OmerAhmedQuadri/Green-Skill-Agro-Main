import { expect, test, type Page } from '@playwright/test';
import ar from '../src/messages/ar.json' with { type: 'json' };
import en from '../src/messages/en.json' with { type: 'json' };
import { freshSeller, sessionPage, takePhoto } from './helpers';

type M = typeof en;
const headers = (origin: string) => ({ origin, 'idempotency-key': crypto.randomUUID() });

/** Onboarding on the phone: identity, location found, a storefront photo, terms (workflow H steps 1–5). */
async function onboard(phone: Page, m: M, name: string) {
  await phone.goto('/field/stores/new');
  await expect(phone.getByTestId('location')).not.toContainText(m.stores.locating, { timeout: 20_000 });
  await phone.getByLabel(m.stores.name, { exact: true }).fill(name);
  await phone.getByLabel(m.stores.ownerName).fill('Khalid Al-Harbi');
  await phone.getByLabel(m.stores.contactNumber).fill('0501234567');
  await phone.getByLabel(m.stores.category).fill('Nursery');
  await phone.getByLabel(m.stores.address, { exact: true }).fill('King Fahd Road');
  await takePhoto(phone, 'st-photo', m);
  await phone.getByLabel(m.stores.creditMode).selectOption('WEEKLY');
  await phone.getByLabel(m.stores.creditLimit).fill('500');
  await phone.getByRole('button', { name: m.stores.onboard, exact: true }).click();
}

/**
 * Workflow H — onboarding a new store (WORKFLOWS.md), in English and Arabic:
 * the seller onboards on the phone, a likely duplicate is acknowledged, a
 * manager approves, and a store past due is blocked — with the reason — before
 * any sale starts; a payment clears it; a manager may release it for one sale.
 */
for (const [locale, m] of [['en', en], ['ar', ar]] as const) {
  test(`Workflow H (${locale}) — STO-001..010, CRD-001..007: onboard on the phone, duplicate warning, approval, blocking shown before a sale`, async ({ browser, baseURL }) => {
    test.setTimeout(240_000);
    const origin = baseURL ?? '';
    const stamp = String(Date.now()).slice(-6);
    const admin = await sessionPage(browser, 'admin@dev.local', locale, origin);
    await admin.request.patch('/api/v1/feature-toggles', { headers: headers(origin), data: { changes: [{ key: 'stores.approval_required', enabled: true }] } });
    const seller = await freshSeller(browser, admin, origin, locale, `H Seller ${locale} ${stamp}`);
    const phone = seller.page;
    // Somewhere in the Kingdom no earlier run has put a store.
    await phone.context().setGeolocation({ latitude: 18 + Math.random() * 10, longitude: 40 + Math.random() * 10, accuracy: 12 });

    // STO-001..005: onboarded, waiting for approval, the seller its account manager.
    const name = `Al Amal Seeds ${locale} ${stamp}`;
    await onboard(phone, m, name);
    await phone.waitForURL(/\/field\/stores\/[0-9a-f-]{36}$/);
    const storeId = phone.url().split('/').at(-1) ?? '';
    await expect(phone.getByText(m.stores.waitingApproval)).toBeVisible();
    await expect(phone.getByTestId('credit-blocked')).toContainText(m.stores.reasons.NOT_APPROVED);
    await expect(phone.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');

    // STO-008: the same spot, a similar name — shown first, and continued only when the seller says it is different.
    await onboard(phone, m, `Al-Amal Seeds ${locale} ${stamp}`);
    await expect(phone.getByTestId('duplicate-warning')).toContainText(name);
    await phone.getByRole('button', { name: m.stores.notDuplicate }).click();
    await phone.waitForURL(/\/field\/stores\/[0-9a-f-]{36}$/);
    expect(phone.url()).not.toContain(storeId);

    // STO-009: a manager approves; the storefront photo is there to check.
    await admin.goto('/console/stores');
    await admin.getByRole('link', { name, exact: true }).click();
    await expect(admin.getByRole('link', { name: m.stores.viewPhoto })).toHaveAttribute('href', /\/api\/v1\/media\//);
    await admin.getByRole('button', { name: m.stores.approve, exact: true }).click();
    await expect(admin.getByText(m.stores.statuses.ACTIVE).first()).toBeVisible();
    await phone.goto(`/field/stores/${storeId}`);
    await expect(phone.getByTestId('credit-clear')).toBeVisible();

    // CRD-004, CRD-005: a debt past due — the store is blocked, with the reason, before any sale starts.
    await admin.request.post(`/api/v1/stores/${storeId}/adjustments`, { headers: headers(origin), data: { amount: '300.00', reason: 'Opening balance', dueOn: '2026-01-15' } });
    await phone.reload();
    await expect(phone.getByTestId('credit-blocked')).toContainText(m.stores.blocked);
    await phone.goto('/field/stores');
    await expect(phone.getByTestId(`store-${name}`)).toContainText(m.stores.blocked);

    // CRD-003: the seller, checked in, collects the payment; the block lifts.
    await phone.goto('/field/today');
    await phone.getByRole('button', { name: m.field.checkIn, exact: true }).click();
    await expect(phone.getByTestId('location')).not.toContainText(m.field.locating, { timeout: 20_000 });
    await takePhoto(phone, 'in-selfie', m);
    await phone.getByRole('form', { name: m.field.checkIn }).getByRole('button', { name: m.field.checkIn, exact: true }).click();
    await expect(phone.getByTestId('day-card')).toContainText(m.field.status.OPEN);
    await phone.goto(`/field/stores/${storeId}`);
    await phone.getByRole('button', { name: m.stores.collect }).click();
    await phone.getByLabel(m.stores.amount).fill('300');
    await phone.getByRole('button', { name: m.stores.recordPayment }).click();
    await expect(phone.getByTestId('credit-clear')).toBeVisible();
    await expect(phone.getByTestId('ledger-PAYMENT')).toBeVisible();

    // CRD-006, CRD-007: past due again — a manager releases it for one sale today, with a reason.
    await admin.request.post(`/api/v1/stores/${storeId}/adjustments`, { headers: headers(origin), data: { amount: '120.00', reason: 'Second debt', dueOn: '2026-02-01' } });
    await admin.reload();
    await admin.getByLabel(m.stores.overrideReason).fill('Owner pays on Thursday');
    await admin.getByRole('button', { name: m.stores.releaseForOneSale }).click();
    await expect(admin.getByText(m.stores.overridden)).toBeVisible();
    await phone.reload();
    await expect(phone.getByTestId('credit-overridden')).toBeVisible();
  });
}
