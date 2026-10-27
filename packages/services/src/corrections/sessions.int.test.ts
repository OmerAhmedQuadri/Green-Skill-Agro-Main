import { type DomainError } from '@gsa/core';
import { schema } from '@gsa/db';
import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { anAccount, ctxFor, PASSWORD } from '../../test/factories';
import type { Ctx } from '../context';
import { inTx } from '../platform';
import { getDb } from '../runtime';
import {
  closeCorrectionSession, correctionStatus, listCorrectionSessions, openCorrectionSession, requireCorrectionSession,
} from './sessions';

const HOUR = 60 * 60 * 1000;
const codeOf = async (p: Promise<unknown>) => p.then(() => 'NO_ERROR', (e: DomainError) => e.code);
const pgCode = async (p: Promise<unknown>) =>
  p.then(() => 'NO_ERROR', (e: { message?: string; cause?: { code?: string } }) => e.cause?.code ?? e.message ?? 'UNKNOWN');
const at = (ctx: Ctx, ms: number): Ctx => ({ ...ctx, now: new Date(ctx.now.getTime() + ms) });
const required = (ctx: Ctx) => inTx(ctx, (tx) => requireCorrectionSession(tx, ctx));
const nameOf = async (ctx: Ctx) => (await getDb().select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, ctx.user.id)))[0]?.name;
const REASON = 'Two vouchers of the October book carry the wrong store';

describe('correction sessions: history is corrected only inside one (ADR-0059)', () => {
  it('COR-001: a Super Admin opens one with their password and a reason; a wrong password is refused and logged', async () => {
    const owner = await ctxFor(await anAccount('SUPER_ADMIN'));
    expect(await codeOf(openCorrectionSession(owner, { password: 'not the password', reason: REASON }))).toBe('WRONG_PASSWORD');
    const [refused] = await getDb().select().from(schema.auditLog)
      .where(and(eq(schema.auditLog.actorId, owner.user.id), eq(schema.auditLog.action, 'corrections.session_refused')));
    expect(refused).toBeDefined();
    expect(await codeOf(openCorrectionSession(owner, { password: PASSWORD, reason: '   ' }))).toBe('REASON_REQUIRED');

    const session = await openCorrectionSession(owner, { password: PASSWORD, reason: `  ${REASON} ` });
    expect(session).toMatchObject({ reason: REASON, state: 'OPEN', endedBy: null, closing: null, by: { id: owner.user.id } });
    expect(session.endsAt.getTime() - session.openedAt.getTime()).toBe(HOUR);
    const [opened] = await getDb().select().from(schema.auditLog).where(eq(schema.auditLog.entityId, session.id));
    expect(opened).toMatchObject({ action: 'corrections.session_opened', after: { number: session.number, reason: REASON } });
    // One at a time.
    expect(await codeOf(openCorrectionSession(at(owner, 60_000), { password: PASSWORD, reason: 'Another' }))).toBe('CORRECTION_SESSION_OPEN');
    // An Admin cannot open one, and cannot be given the right to (COR-001; the permission is never configurable).
    const admin = await ctxFor(await anAccount('ADMIN'));
    expect(await codeOf(openCorrectionSession(admin, { password: PASSWORD, reason: REASON }))).toBe('FORBIDDEN');
  });

  it('COR-001: five wrong passwords in a minute stop even the right one; opening sessions does not count', async () => {
    const owner = await ctxFor(await anAccount('SUPER_ADMIN'));
    for (let i = 0; i < 3; i += 1) {
      const s = await openCorrectionSession(owner, { password: PASSWORD, reason: REASON });
      await closeCorrectionSession(owner, s.id, { version: s.version, closing: 'KEPT' });
    }
    for (let i = 0; i < 4; i += 1) expect(await codeOf(openCorrectionSession(owner, { password: 'wrong', reason: REASON }))).toBe('WRONG_PASSWORD');
    expect(await codeOf(openCorrectionSession(owner, { password: 'wrong', reason: REASON }))).toBe('WRONG_PASSWORD');
    expect(await codeOf(openCorrectionSession(owner, { password: PASSWORD, reason: REASON }))).toBe('RATE_LIMITED');
    expect(await codeOf(openCorrectionSession(at(owner, 61_000), { password: PASSWORD, reason: REASON }))).toBe('NO_ERROR');
  });

  it('COR-001: with no session open nothing can be corrected — before, after the hour, after closing, or in another\'s', async () => {
    const owner = await ctxFor(await anAccount('SUPER_ADMIN'));
    const other = await ctxFor(await anAccount('SUPER_ADMIN'));
    expect(await codeOf(required(owner))).toBe('NO_CORRECTION_SESSION');
    const session = await openCorrectionSession(owner, { password: PASSWORD, reason: REASON });
    expect(await required(at(owner, 59 * 60_000))).toEqual({ id: session.id, number: session.number });
    // Another Super Admin's session is theirs alone.
    expect(await codeOf(required(other))).toBe('NO_CORRECTION_SESSION');
    // It switches itself off after the hour.
    expect(await codeOf(required(at(owner, HOUR)))).toBe('NO_CORRECTION_SESSION');
    // Closed early, it is over too.
    const second = await ctxFor(await anAccount('SUPER_ADMIN'));
    const s2 = await openCorrectionSession(second, { password: PASSWORD, reason: REASON });
    await closeCorrectionSession(at(second, 10 * 60_000), s2.id, { version: s2.version, closing: 'KEPT' });
    expect(await codeOf(required(at(second, 11 * 60_000)))).toBe('NO_CORRECTION_SESSION');
  });

  it('COR-003: closing keeps the reason, adds to it, or edits it — an edited reason keeps the original', async () => {
    const owner = await ctxFor(await anAccount('SUPER_ADMIN'));
    const first = await openCorrectionSession(owner, { password: PASSWORD, reason: REASON });
    const added = await closeCorrectionSession(at(owner, 20 * 60_000), first.id, { version: first.version, closing: 'ADDED', text: 'and one date' });
    expect(added).toMatchObject({ state: 'CLOSED', endedBy: 'CLOSED', reason: REASON, closing: 'ADDED', closingText: 'and one date' });
    expect(added.endedAt?.getTime()).toBe(owner.now.getTime() + 20 * 60_000);
    // Closed is closed.
    expect(await codeOf(closeCorrectionSession(at(owner, 21 * 60_000), first.id, { version: added.version, closing: 'KEPT' }))).toBe('INVALID_TRANSITION');

    const later = at(owner, HOUR);
    const second = await openCorrectionSession(later, { password: PASSWORD, reason: REASON });
    // Only its own Super Admin closes it, and only with the version they saw.
    const other = await ctxFor(await anAccount('SUPER_ADMIN'));
    expect(await codeOf(closeCorrectionSession(other, second.id, { version: second.version, closing: 'KEPT' }))).toBe('FORBIDDEN');
    expect(await codeOf(closeCorrectionSession(later, second.id, { version: second.version + 1, closing: 'KEPT' }))).toBe('VERSION_CONFLICT');
    expect(await codeOf(closeCorrectionSession(later, second.id, { version: second.version, closing: 'EDITED', text: ' ' }))).toBe('REASON_REQUIRED');
    const edited = await closeCorrectionSession(at(later, 5 * 60_000), second.id, { version: second.version, closing: 'EDITED', text: 'Three vouchers' });
    expect(edited).toMatchObject({ reason: REASON, closing: 'EDITED', closingText: 'Three vouchers' });
    const [log] = await getDb().select().from(schema.auditLog)
      .where(and(eq(schema.auditLog.entityId, second.id), eq(schema.auditLog.action, 'corrections.session_closed')));
    expect(log).toMatchObject({ before: { reason: REASON }, after: { closing: 'EDITED', text: 'Three vouchers', endedBy: 'CLOSED' } });

    // The opening reason is kept as written: the app may change only the closing (SQLSTATE 42501), and remove nothing.
    for (const statement of [
      sql`update correction_sessions set reason = 'Something else' where id = ${second.id}`,
      sql`update correction_sessions set opened_at = now() where id = ${second.id}`,
      sql`delete from correction_sessions where id = ${second.id}`,
    ]) expect(await pgCode(getDb().execute(statement))).toBe('42501');
  });

  it('COR-003: a session its hour ended waits for its reason, settled at the Super Admin\'s next visit', async () => {
    const owner = await ctxFor(await anAccount('SUPER_ADMIN'));
    const session = await openCorrectionSession(owner, { password: PASSWORD, reason: REASON });
    const nextDay = at(owner, 20 * HOUR);
    expect((await correctionStatus(nextDay)).mine).toMatchObject({ id: session.id, state: 'ENDED', endedBy: 'HOUR', endedAt: session.endsAt });
    // Not a second session until this one is closed.
    expect(await codeOf(openCorrectionSession(nextDay, { password: PASSWORD, reason: 'Another' }))).toBe('CORRECTION_SESSION_OPEN');
    const closed = await closeCorrectionSession(nextDay, session.id, { version: session.version, closing: 'KEPT' });
    expect(closed).toMatchObject({ state: 'CLOSED', endedBy: 'HOUR', endedAt: session.endsAt, closing: 'KEPT', closingText: null });
    expect((await correctionStatus(nextDay)).mine).toBeNull();
    expect((await openCorrectionSession(nextDay, { password: PASSWORD, reason: 'Another' })).state).toBe('OPEN');
  });

  it('COR-004: Admins and Managers see who is correcting history while it is open; sellers see nothing', async () => {
    const owner = await ctxFor(await anAccount('SUPER_ADMIN'));
    const admin = await ctxFor(await anAccount('ADMIN'));
    const manager = await ctxFor(await anAccount('MANAGER'));
    const seller = await ctxFor(await anAccount('SELLER'));
    const session = await openCorrectionSession(owner, { password: PASSWORD, reason: REASON });
    const name = await nameOf(owner);
    expect((await correctionStatus(owner)).mine).toMatchObject({ id: session.id, state: 'OPEN' });
    for (const viewer of [admin, manager]) {
      const status = await correctionStatus(viewer);
      expect(status.mine).toBeNull();
      expect(status.others).toContainEqual({ number: session.number, by: name, openedAt: session.openedAt, endsAt: session.endsAt });
    }
    expect(await correctionStatus(seller)).toEqual({ mine: null, others: [] });
    // Once its hour is up it is no longer in progress for anyone else.
    expect((await correctionStatus(at(admin, HOUR))).others.map((o) => o.number)).not.toContain(session.number);
  });

  it('COR-003: the Corrections page lists every session, newest first, for those who read the audit log', async () => {
    const owner = await ctxFor(await anAccount('SUPER_ADMIN'));
    const s = await openCorrectionSession(owner, { password: PASSWORD, reason: REASON });
    await closeCorrectionSession(owner, s.id, { version: s.version, closing: 'EDITED', text: 'Three vouchers' });
    const admin = await ctxFor(await anAccount('ADMIN'));
    const page = await listCorrectionSessions(admin, { limit: 200 });
    const numbers = page.items.map((i) => i.number);
    expect(numbers).toEqual([...numbers].sort((a, b) => b - a));
    expect(page.items.find((i) => i.id === s.id)).toMatchObject({ reason: REASON, closing: 'EDITED', closingText: 'Three vouchers' });
    const first = await listCorrectionSessions(admin, { limit: 1 });
    if (first.nextCursor) {
      const next = await listCorrectionSessions(admin, { limit: 1, cursor: first.nextCursor });
      expect(next.items[0]?.number).toBeLessThan(first.items[0]?.number ?? 0);
    }
    const manager = await ctxFor(await anAccount('MANAGER'));
    expect(await codeOf(listCorrectionSessions(manager))).toBe('FORBIDDEN');
  });
});
