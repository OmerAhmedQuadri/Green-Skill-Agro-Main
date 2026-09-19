import { loadConfig } from '@gsa/config';
import { BUSINESS_TIME_ZONE } from '@gsa/core';
import { attendance, getMailer, media, notifications } from '@gsa/services';
import { PgBoss } from 'pg-boss';

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
  await boss.stop({ graceful: true, timeout: 10_000 });
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
