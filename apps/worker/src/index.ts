import { loadConfig } from '@gsa/config';
import { BUSINESS_TIME_ZONE } from '@gsa/core';
import { attendance, cash, getMailer, media, notifications, reports, sales, targets } from '@gsa/services';
import { PgBoss } from 'pg-boss';
import { chromiumRenderer } from './pdf';

/**
 * Background jobs (ADR-0012, ARCHITECTURE §6.5). Same database, runtime role,
 * queue tables in the `pgboss` schema. Every job is idempotent.
 */
const config = loadConfig();
// The `pgboss` schema is created by the database setup and owned by the runtime
// role, which may not create schemas itself (ADR-0008) — hence createSchema: false.
const boss = new PgBoss({ connectionString: config.DATABASE_URL, schema: 'pgboss', createSchema: false });
boss.on('error', (error) => console.error('[worker] pg-boss error', error));

await boss.start();

// M0 heartbeat — proves scheduling in Riyadh time and job execution end to end.
await boss.createQueue('system.heartbeat');
await boss.schedule('system.heartbeat', '* * * * *', null, { tz: BUSINESS_TIME_ZONE });
await boss.work('system.heartbeat', ([job]) => {
  console.log(`[worker] heartbeat ${job?.id ?? ''} at ${new Date().toISOString()}`);
  return Promise.resolve();
});

// ARCHITECTURE §6.5: purge photos past retention (OQ-009) and abandoned uploads. Idempotent.
await boss.createQueue('media.retention');
await boss.schedule('media.retention', '0 4 * * *', null, { tz: BUSINESS_TIME_ZONE });
await boss.work('media.retention', async () => {
  const result = await media.purgeMedia(new Date());
  console.log(`[worker] media.retention purged ${result.expired} expired, ${result.abandoned} abandoned`);
});

// STATE-MACHINES §10: close finished days at 03:00 Riyadh; an open multi-day trip stays open. Idempotent.
await boss.createQueue('attendance.close-day');
await boss.schedule('attendance.close-day', '0 3 * * *', null, { tz: BUSINESS_TIME_ZONE });
await boss.work('attendance.close-day', async () => {
  const result = await attendance.closeFinishedDays(new Date());
  console.log(`[worker] attendance.close-day closed ${result.closed}, withdrew ${result.withdrawn}`);
});

// PRC-015 (ARCHITECTURE §6.5): undecided discount requests past their time, and approved sales left from an earlier day. Idempotent.
await boss.createQueue('discount-approval.expire');
await boss.schedule('discount-approval.expire', '* * * * *', null, { tz: BUSINESS_TIME_ZONE });
await boss.work('discount-approval.expire', async () => {
  const result = await sales.expireDiscountRequests(new Date());
  if (result.expired > 0) console.log(`[worker] discount-approval.expire expired ${result.expired}`);
});

// LIM-002..004 (ADR-0040): sellers over a cash or stock ceiling — flagged for the
// dashboard, warned in the app and by email, and reminded on the Admin's interval.
await boss.createQueue('ceilings.check');
await boss.schedule('ceilings.check', '*/5 * * * *', null, { tz: BUSINESS_TIME_ZONE });
await boss.work('ceilings.check', async () => {
  const result = await cash.sweepCeilings(new Date());
  if (result.raised + result.reminded + result.cleared > 0) {
    console.log(`[worker] ceilings.check raised ${result.raised}, reminded ${result.reminded}, cleared ${result.cleared}`);
  }
});

// TGT-005, COM-008 (ADR-0042): a few days after a month ends its figures freeze
// into a snapshot, once per seller, and sellers who missed a target are told.
// Runs at 01:00 Riyadh, when nothing else is competing for the database.
await boss.createQueue('targets.close');
await boss.schedule('targets.close', '0 1 * * *', null, { tz: BUSINESS_TIME_ZONE });
await boss.work('targets.close', async () => {
  const result = await targets.sweepPeriods(new Date());
  if (result.frozen > 0) console.log(`[worker] targets.close froze ${result.frozen}, ${result.missed} missed`);
});

// TGT-006: mid-month, sellers far enough behind the pace their target needs are
// told, and so are their managers. Once a day is often enough to be useful
// without becoming noise.
await boss.createQueue('targets.pace');
await boss.schedule('targets.pace', '0 6 * * *', null, { tz: BUSINESS_TIME_ZONE });
await boss.work('targets.pace', async () => {
  const result = await targets.sweepPace(new Date());
  if (result.warned > 0) console.log(`[worker] targets.pace warned ${result.warned}`);
});

// RPT-001, RPT-002 (ADR-0043): rebuild the sales rollup that the trends and the
// demand rate read. Derived data — a rebuild replaces the days it covers, so
// running it twice changes nothing. Hourly, because a trend that is an hour old
// is still a trend and the rebuild is cheap.
await boss.createQueue('reports.rollup');
await boss.schedule('reports.rollup', '20 * * * *', null, { tz: BUSINESS_TIME_ZONE });
await boss.work('reports.rollup', async () => {
  const result = await reports.sweepRollup(new Date());
  if (result.rows > 0) console.log(`[worker] reports.rollup rebuilt ${result.rows} rows over ${result.days} days`);
});

// RPT-004..006: record what the projection advised and on what figures. The
// screen recomputes on read against live stock (ADR-0043); this is the history.
await boss.createQueue('reports.forecast');
await boss.schedule('reports.forecast', '30 2 * * *', null, { tz: BUSINESS_TIME_ZONE });
await boss.work('reports.forecast', async () => {
  const result = await reports.sweepForecast(new Date());
  if (result.built > 0) console.log(`[worker] reports.forecast ${result.built} forecast, ${result.toOrder} to order`);
});

// ADR-0019, ADR-0037: print delivery documents from their outbox. Chromium starts with the first
// document and stays open while more keep coming — launching is the expensive part — then closes
// after a minute with nothing to print.
const renderer = chromiumRenderer();
const IDLE_CLOSE_MS = 60_000;
let rendering = false;
let lastPrinted = 0;
const renderDocuments = async () => {
  if (rendering) return;
  rendering = true;
  try {
    const result = await sales.renderPendingDocuments(renderer, new Date());
    if (result.rendered + result.failed > 0) {
      lastPrinted = Date.now();
      console.log(`[worker] delivery documents: ${result.rendered} ready, ${result.failed} failed`);
    }
  } catch (error) {
    console.error('[worker] delivery document pass failed', error);
  } finally {
    if (Date.now() - lastPrinted > IDLE_CLOSE_MS) await renderer.close().catch(() => undefined);
    rendering = false;
  }
};
const documentLoop = setInterval(() => void renderDocuments(), 3_000);
void renderDocuments();

// ADR-0023: deliver the email outbox every few seconds; never two passes at once.
let delivering = false;
const deliverEmails = async () => {
  if (delivering) return;
  delivering = true;
  try {
    const result = await notifications.deliverPendingEmails(getMailer(), new Date());
    if (result.sent + result.failed > 0) console.log(`[worker] email outbox: ${result.sent} sent, ${result.failed} failed`);
  } catch (error) {
    console.error('[worker] email outbox pass failed', error);
  } finally {
    delivering = false;
  }
};
const emailLoop = setInterval(() => void deliverEmails(), 5_000);
void deliverEmails();

console.log('[worker] started');

const shutdown = async () => {
  clearInterval(emailLoop);
  clearInterval(documentLoop);
  await renderer.close();
  await boss.stop({ graceful: true, timeout: 10_000 });
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
