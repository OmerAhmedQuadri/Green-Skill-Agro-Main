import { schema } from '@gsa/db';
import { and, asc, eq, lte } from 'drizzle-orm';
import type { Executor } from '../platform';
import { getDb } from '../runtime';
import type { Mailer } from './mailer';
import { renderEmail, type EmailTemplate, type Locale } from './templates';

const { emailOutbox } = schema;
/** Retry with growing delays, then give up (the row keeps the last error). */
const MAX_ATTEMPTS = 8;
const backoffMs = (attempt: number) => Math.min(60 * 60_000, 30_000 * 2 ** (attempt - 1));

export type OutgoingEmail = {
  readonly to: string; readonly template: EmailTemplate; readonly locale: Locale;
  readonly params: Readonly<Record<string, string>>; readonly branchId: string;
};

/** Queue an email in the caller's transaction (ADR-0023): it is sent only if that transaction commits. */
export async function enqueueEmail(db: Executor, email: OutgoingEmail, now: Date): Promise<void> {
  await db.insert(emailOutbox).values({
    toAddress: email.to, template: email.template, locale: email.locale, params: email.params,
    branchId: email.branchId, createdAt: now, nextAttemptAt: now,
  });
}

/**
 * The worker's delivery loop. Claims due rows with SKIP LOCKED, so two workers
 * never send the same email; failures are retried with backoff.
 */
export async function deliverPendingEmails(mailer: Mailer, now: Date, batch = 20): Promise<{ sent: number; failed: number }> {
  const db = getDb();
  let sent = 0;
  let failed = 0;
  await db.transaction(async (tx) => {
    const due = await tx.select().from(emailOutbox)
      .where(and(eq(emailOutbox.status, 'PENDING'), lte(emailOutbox.nextAttemptAt, now)))
      .orderBy(asc(emailOutbox.nextAttemptAt)).limit(batch).for('update', { skipLocked: true });

    for (const row of due) {
      const attempt = row.attempts + 1;
      try {
        const rendered = renderEmail(row.template as EmailTemplate, row.locale, row.params as Record<string, string>);
        await mailer.send({ to: row.toAddress, ...rendered });
        await tx.update(emailOutbox).set({ status: 'SENT', attempts: attempt, sentAt: now, lastError: null }).where(eq(emailOutbox.id, row.id));
        sent += 1;
      } catch (error) {
        const giveUp = attempt >= MAX_ATTEMPTS;
        await tx.update(emailOutbox).set({
          attempts: attempt,
          status: giveUp ? 'FAILED' : 'PENDING',
          nextAttemptAt: new Date(now.getTime() + backoffMs(attempt)),
          // Error text only — never the message body, which may hold a reset link.
          lastError: String(error instanceof Error ? error.message : error).slice(0, 500),
        }).where(eq(emailOutbox.id, row.id));
        failed += 1;
      }
    }
  });
  return { sent, failed };
}
