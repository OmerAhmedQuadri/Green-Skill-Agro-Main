import {
  correctionReason, correctionSessionEndedAt, correctionSessionEnds, correctionSessionState, DomainError, settleCorrectionReason,
  type CorrectionClosing, type CorrectionSessionState,
} from '@gsa/core';
import { schema } from '@gsa/db';
import { and, desc, eq, gt, isNull, lt } from 'drizzle-orm';
import { authorize, authorizeAny, type Ctx } from '../context';
import { isMyPassword } from '../identity';
import { assertUnderRateLimit, audit, hitRateLimit, inTx, mapUniqueViolations, pageLimit, type Tx } from '../platform';
import { getDb } from '../runtime';

const { correctionSessions, users } = schema;

/**
 * Correction sessions (M13, ADR-0059). A Super Admin corrects history only inside their own session: opened with
 * their password and a reason, ended after an hour or when closed. Every correction made in it is linked to it
 * (steps d and e), so each change sits beside the reason the session was opened for.
 */

export type CorrectionSessionView = {
  readonly id: string; readonly number: number; readonly version: number;
  readonly by: { readonly id: string; readonly name: string };
  readonly openedAt: Date; readonly endsAt: Date; readonly reason: string;
  readonly state: CorrectionSessionState;
  /** How it stopped: closed by its Super Admin, or at the end of its hour. Null while open. */
  readonly endedBy: 'CLOSED' | 'HOUR' | null;
  readonly endedAt: Date | null; readonly closedAt: Date | null;
  readonly closing: CorrectionClosing | null; readonly closingText: string | null;
};

/** COR-004: corrections in progress, as everyone in the console sees them. */
export type CorrectionStatus = {
  /** The caller's own session not yet closed — open, or ended by its hour and waiting for its reason. */
  readonly mine: CorrectionSessionView | null;
  /** Other Super Admins' open sessions, and by whom. */
  readonly others: readonly { readonly number: number; readonly by: string; readonly openedAt: Date; readonly endsAt: Date }[];
};

type Row = typeof correctionSessions.$inferSelect;

function view(row: Row, name: string, now: Date): CorrectionSessionView {
  const state = correctionSessionState(row, now);
  const endedBy = state === 'OPEN' ? null : row.closedAt && row.closedAt < row.endsAt ? 'CLOSED' : 'HOUR';
  return {
    id: row.id, number: row.number, version: row.version, by: { id: row.openedBy, name },
    openedAt: row.openedAt, endsAt: row.endsAt, reason: row.reason, state, endedBy,
    endedAt: row.endedAt ?? (state === 'ENDED' ? row.endsAt : null), closedAt: row.closedAt,
    closing: row.closing, closingText: row.closingText,
  };
}

/** COR-004: sellers see nothing; everyone else sees who is correcting history. */
export async function correctionStatus(ctx: Ctx): Promise<CorrectionStatus> {
  if (ctx.user.role === 'SELLER') return { mine: null, others: [] };
  const rows = await getDb().select({ s: correctionSessions, name: users.name }).from(correctionSessions)
    .innerJoin(users, eq(users.id, correctionSessions.openedBy))
    .where(isNull(correctionSessions.closedAt)).orderBy(correctionSessions.openedAt);
  const own = rows.find((r) => r.s.openedBy === ctx.user.id);
  return {
    mine: own && ctx.permissions.has('system.correct_history') ? view(own.s, own.name, ctx.now) : null,
    others: rows.filter((r) => r.s.openedBy !== ctx.user.id && ctx.now < r.s.endsAt)
      .map((r) => ({ number: r.s.number, by: r.name, openedAt: r.s.openedAt, endsAt: r.s.endsAt })),
  };
}

/**
 * COR-001: a Super Admin opens their session with their password and a reason. A wrong password is refused and
 * logged; so is a second session while one waits to be closed.
 */
export async function openCorrectionSession(ctx: Ctx, input: { password: string; reason: string }): Promise<CorrectionSessionView> {
  authorize(ctx, 'system.correct_history');
  // Five wrong passwords a minute, checked before the password is: only a wrong one counts.
  const limit = `correction-session:${ctx.user.id}`;
  await assertUnderRateLimit(getDb(), limit, 5, 60_000, ctx.now);
  if (!(await isMyPassword(ctx, input.password))) {
    // Kept although the opening is refused: the attempt itself is worth knowing about.
    await audit(getDb(), ctx, { action: 'corrections.session_refused', entityType: 'user', entityId: ctx.user.id, after: { why: 'WRONG_PASSWORD' } });
    await hitRateLimit(getDb(), limit, 5, 60_000, ctx.now);
    throw new DomainError('WRONG_PASSWORD');
  }
  const reason = correctionReason(input.reason);
  return inTx(ctx, async (tx) => {
    const [waiting] = await tx.select({ number: correctionSessions.number }).from(correctionSessions)
      .where(and(eq(correctionSessions.openedBy, ctx.user.id), isNull(correctionSessions.closedAt)));
    if (waiting) throw new DomainError('CORRECTION_SESSION_OPEN', { number: waiting.number });
    const [row] = await mapUniqueViolations(
      tx.insert(correctionSessions).values({
        openedBy: ctx.user.id, openedAt: ctx.now, endsAt: correctionSessionEnds(ctx.now), reason,
        branchId: ctx.branchId, createdBy: ctx.user.id, updatedBy: ctx.user.id,
      }).returning(),
      { correction_sessions_one_unsettled: new DomainError('CORRECTION_SESSION_OPEN') },
    );
    if (!row) throw new Error('correction session insert returned nothing');
    const [me] = await tx.select({ name: users.name }).from(users).where(eq(users.id, ctx.user.id));
    await audit(tx, ctx, {
      action: 'corrections.session_opened', entityType: 'correction_session', entityId: row.id,
      after: { number: row.number, reason, endsAt: row.endsAt },
    });
    return view(row, me?.name ?? '', ctx.now);
  });
}

/**
 * COR-003: closing settles the reason — kept, added to, or edited with the original kept beside it. A session its
 * hour ended is closed the same way, at its Super Admin's next visit. Only its own Super Admin closes it.
 */
export async function closeCorrectionSession(
  ctx: Ctx, id: string, input: { version: number; closing: CorrectionClosing; text?: string | null | undefined },
): Promise<CorrectionSessionView> {
  authorize(ctx, 'system.correct_history');
  return inTx(ctx, async (tx) => {
    const [found] = await tx.select({ s: correctionSessions, name: users.name }).from(correctionSessions)
      .innerJoin(users, eq(users.id, correctionSessions.openedBy))
      .where(eq(correctionSessions.id, id)).for('update', { of: correctionSessions });
    if (!found) throw new DomainError('NOT_FOUND', { entity: 'correction_session', id });
    const row = found.s;
    if (row.openedBy !== ctx.user.id) throw new DomainError('FORBIDDEN', { permission: 'system.correct_history' });
    if (row.closedAt) throw new DomainError('INVALID_TRANSITION', { from: 'CLOSED', to: 'CLOSED' });
    if (row.version !== input.version) throw new DomainError('VERSION_CONFLICT', { expected: row.version, given: input.version });
    const settled = settleCorrectionReason(row.reason, input.closing, input.text);
    const endedAt = correctionSessionEndedAt(row, ctx.now);
    const [closed] = await tx.update(correctionSessions).set({
      closedAt: ctx.now, endedAt, closing: settled.closing, closingText: settled.text,
      updatedAt: ctx.now, updatedBy: ctx.user.id, version: row.version + 1,
    }).where(eq(correctionSessions.id, id)).returning();
    if (!closed) throw new Error('correction session update returned nothing');
    await audit(tx, ctx, {
      action: 'corrections.session_closed', entityType: 'correction_session', entityId: id,
      before: { reason: row.reason },
      after: { closing: settled.closing, text: settled.text, endedAt, endedBy: endedAt < row.endsAt ? 'CLOSED' : 'HOUR' },
    });
    return view(closed, found.name, ctx.now);
  });
}

/**
 * COR-001: what every correction starts with (steps d and e) — the caller's open session, held for the rest of the
 * transaction so it cannot be closed under the correction. With none open, nothing can be corrected.
 */
export async function requireCorrectionSession(tx: Tx, ctx: Ctx): Promise<{ id: string; number: number }> {
  authorize(ctx, 'system.correct_history');
  const [session] = await tx.select({ id: correctionSessions.id, number: correctionSessions.number }).from(correctionSessions)
    .where(and(eq(correctionSessions.openedBy, ctx.user.id), isNull(correctionSessions.closedAt), gt(correctionSessions.endsAt, ctx.now)))
    .for('share');
  if (!session) throw new DomainError('NO_CORRECTION_SESSION');
  return session;
}

/** The Corrections page: every session, newest first. For whoever corrects history or reads the audit log. */
export async function listCorrectionSessions(
  ctx: Ctx, filter: { cursor?: string | undefined; limit?: number | undefined } = {},
): Promise<{ items: CorrectionSessionView[]; nextCursor: string | null }> {
  authorizeAny(ctx, ['system.correct_history', 'system.view_audit_log']);
  const limit = pageLimit(filter.limit);
  const before = filter.cursor ? cursorNumber(filter.cursor) : null;
  const rows = await getDb().select({ s: correctionSessions, name: users.name }).from(correctionSessions)
    .innerJoin(users, eq(users.id, correctionSessions.openedBy))
    .where(before === null ? undefined : lt(correctionSessions.number, before))
    .orderBy(desc(correctionSessions.number)).limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map((r) => view(r.s, r.name, ctx.now)),
    nextCursor: rows.length > limit && last ? String(last.s.number) : null,
  };
}

/** Sessions are numbered, so the number is the cursor. */
function cursorNumber(cursor: string): number {
  const n = Number(cursor);
  if (!/^\d{1,9}$/.test(cursor) || !Number.isSafeInteger(n)) throw new DomainError('INVALID_CURSOR');
  return n;
}
