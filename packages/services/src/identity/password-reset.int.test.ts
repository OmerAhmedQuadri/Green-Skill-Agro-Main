import type { DomainError } from '@gsa/core';
import { schema } from '@gsa/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { ownerQuery } from '../../test/db';
import { anAccount, meta, PASSWORD } from '../../test/factories';
import { mailer } from '../../test/mailer';
import { deliverPendingEmails } from '../notifications';
import { getDb } from '../runtime';
import { requestPasswordReset, resetPasswordWithToken, resolveSession, signIn } from './index';

const code = (p: Promise<unknown>) => p.then(() => 'NO_ERROR', (e: DomainError) => e.code);
const minutes = (base: Date, m: number) => new Date(base.getTime() + m * 60_000);
const tokenFrom = (text: string) => /token=([A-Za-z0-9_-]+)/.exec(text)?.[1] ?? '';
const NEW = 'a brand new passphrase';

describe('password reset by email (ADR-0018, SECURITY §1)', () => {
  it('ADR-0018: a reset link is emailed, works once, and ends every existing session', async () => {
    const seller = await anAccount('SELLER');
    const { token: session } = await signIn({ identifier: seller.email, password: PASSWORD }, meta());
    const t0 = new Date();
    await requestPasswordReset({ email: seller.email.toUpperCase() }, meta(t0));
    expect(await deliverPendingEmails(mailer, t0)).toEqual({ sent: 1, failed: 0 });
    const email = mailer.sent[0];
    expect(email?.to).toBe(seller.email);
    const token = tokenFrom(email?.text ?? '');
    expect(token.length).toBeGreaterThan(30);

    await resetPasswordWithToken({ token, newPassword: NEW }, meta(minutes(t0, 5)));
    expect(await resolveSession(session, meta())).toBeNull();
    expect(await code(signIn({ identifier: seller.email, password: NEW }, meta()))).toBe('NO_ERROR');
    expect(await code(resetPasswordWithToken({ token, newPassword: 'yet another passphrase' }, meta()))).toBe('RESET_LINK_INVALID');
  });

  it('SECURITY §1: an unknown or deactivated address gets the same answer, and no email', async () => {
    const gone = await anAccount('SELLER', { status: 'DEACTIVATED' });
    await expect(requestPasswordReset({ email: 'nobody@test.local' }, meta())).resolves.toBeUndefined();
    await expect(requestPasswordReset({ email: gone.email }, meta())).resolves.toBeUndefined();
    await expect(requestPasswordReset({ email: 'not an email' }, meta())).resolves.toBeUndefined();
    await deliverPendingEmails(mailer, new Date());
    expect(mailer.sent).toHaveLength(0);
  });

  it('ADR-0018: the link expires after 30 minutes, and only the hash is stored', async () => {
    const seller = await anAccount('SELLER');
    const t0 = new Date();
    await requestPasswordReset({ email: seller.email }, meta(t0));
    await deliverPendingEmails(mailer, t0);
    const token = tokenFrom(mailer.sent[0]?.text ?? '');
    const [stored] = await ownerQuery<{ id: string }>('select id from password_reset_tokens');
    expect(stored?.id).not.toBe(token);
    expect(await code(resetPasswordWithToken({ token, newPassword: NEW }, meta(minutes(t0, 31))))).toBe('RESET_LINK_INVALID');
  });

  it('ADR-0018: asking again cancels the earlier link', async () => {
    const seller = await anAccount('SELLER');
    const t0 = new Date();
    await requestPasswordReset({ email: seller.email }, meta(t0));
    await requestPasswordReset({ email: seller.email }, meta(minutes(t0, 1)));
    await deliverPendingEmails(mailer, minutes(t0, 1));
    const [first, second] = mailer.sent.map((m) => tokenFrom(m.text));
    expect(await code(resetPasswordWithToken({ token: first ?? '', newPassword: NEW }, meta(minutes(t0, 2))))).toBe('RESET_LINK_INVALID');
    expect(await code(resetPasswordWithToken({ token: second ?? '', newPassword: NEW }, meta(minutes(t0, 2))))).toBe('NO_ERROR');
  });

  it('SECURITY §1: the new password must meet the policy', async () => {
    const seller = await anAccount('SELLER');
    const t0 = new Date();
    await requestPasswordReset({ email: seller.email }, meta(t0));
    await deliverPendingEmails(mailer, t0);
    const token = tokenFrom(mailer.sent[0]?.text ?? '');
    expect(await code(resetPasswordWithToken({ token, newPassword: 'short' }, meta(t0)))).toBe('PASSWORD_TOO_WEAK');
  });

  it('I18N-001: the email is written in the recipient\'s language, right-to-left for Arabic', async () => {
    const seller = await anAccount('SELLER');
    await getDb().update(schema.users).set({ locale: 'ar' }).where(eq(schema.users.id, seller.id));
    await requestPasswordReset({ email: seller.email }, meta());
    await deliverPendingEmails(mailer, new Date());
    expect(mailer.sent[0]?.subject).toContain('كلمة المرور');
    expect(mailer.sent[0]?.html).toContain('dir="rtl"');
  });
});

describe('email outbox (ADR-0023)', () => {
  it('ADR-0023: an email is queued in the caller\'s transaction — a rolled-back change sends nothing', async () => {
    const { enqueueEmail } = await import('../notifications');
    const { defaultBranchId } = await import('../runtime');
    const branchId = await defaultBranchId();
    await getDb().transaction(async (tx) => {
      await enqueueEmail(tx, { to: 'x@test.local', template: 'password-reset', locale: 'en', params: { name: 'X', link: 'L' }, branchId }, new Date());
      tx.rollback();
    }).catch(() => undefined);
    expect(await ownerQuery('select 1 from email_outbox')).toHaveLength(0);
  });

  it('ADR-0023: a failed send is retried later with backoff, then delivered', async () => {
    const seller = await anAccount('SELLER');
    const t0 = new Date();
    await requestPasswordReset({ email: seller.email }, meta(t0));
    mailer.failNextSends(1);
    expect(await deliverPendingEmails(mailer, t0)).toEqual({ sent: 0, failed: 1 });
    expect(await deliverPendingEmails(mailer, minutes(t0, 0.25))).toEqual({ sent: 0, failed: 0 }); // not due yet
    expect(await deliverPendingEmails(mailer, minutes(t0, 1))).toEqual({ sent: 1, failed: 0 });
    const [row] = await ownerQuery<{ status: string; attempts: number; last_error: string | null }>('select status, attempts, last_error from email_outbox');
    expect(row).toEqual({ status: 'SENT', attempts: 2, last_error: null });
  });
});
