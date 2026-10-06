import { addDays, backupKey, businessDate, type DomainError } from '@gsa/core';
import { describe, expect, it } from 'vitest';
import { ownerQuery } from '../../test/db';
import { anAccount, ctxFor } from '../../test/factories';
import { storageOverview } from '../media';
import { pauseBackups, recentBackupRuns, reportBackups, requestBackup, runNightlyBackup, serveBackupRequest, type BackupRunner } from './backups';

const MINUTE = 60_000;
const code = (p: Promise<unknown>) => p.then(() => 'NO_ERROR', (e: DomainError) => e.code);
const as = async (role: 'SUPER_ADMIN' | 'ADMIN', now?: Date) => ctxFor(await anAccount(role), now ? { now } : {});
/** Stand-ins for deploy/backup.sh: it worked, it stopped with a message, or it could not even start. */
const worked: BackupRunner = () => Promise.resolve({ ok: true });
const stopped: BackupRunner = () => Promise.resolve({ ok: false, error: 'listing the bucket failed with HTTP 403' });
const brokeDown: BackupRunner = () => Promise.reject(new Error('spawn bash ENOENT'));
/** The nightly run's moment on a Riyadh business day. */
const at05 = (day: string) => new Date(`${day}T05:00:00+03:00`);

describe('database backups, nightly and on request (ADR-0050)', () => {
  it('ADR-0050: the Super Admin asks for a backup; the worker takes it up once, and the page shows how it went', async () => {
    const sa = await as('SUPER_ADMIN');
    expect(await serveBackupRequest(worked)).toBeNull();
    await requestBackup(sa);
    expect(await code(requestBackup(sa))).toBe('BACKUP_IN_PROGRESS');
    expect(await code(requestBackup(await as('ADMIN')))).toBe('FORBIDDEN');

    const run = await serveBackupRequest(worked);
    expect(run).toMatchObject({ trigger: 'MANUAL', status: 'SUCCEEDED', note: null });
    expect(run?.finishedAt).toBeInstanceOf(Date);
    expect(await serveBackupRequest(worked)).toBeNull();

    // Not again within ten minutes of the last one taken; after that, yes.
    expect(await code(requestBackup(sa))).toBe('BACKUP_TOO_SOON');
    await requestBackup(await as('SUPER_ADMIN', new Date(Date.now() + 11 * MINUTE)));
    const view = await storageOverview(sa);
    expect(view.backupRuns.map((r) => [r.trigger, r.status])).toEqual([['MANUAL', 'REQUESTED'], ['MANUAL', 'SUCCEEDED']]);
    expect(view.backupRuns[1]?.requestedBy).toBeTruthy();
    const asked = await ownerQuery<{ n: string }>(`select count(*) as n from audit_log where action = 'backup.requested'`);
    expect(asked[0]?.n).toBe('2');
  });

  it('ADR-0050: a failed backup is recorded with what stopped it, and can be asked for again at once', async () => {
    const sa = await as('SUPER_ADMIN');
    await requestBackup(sa);
    expect(await serveBackupRequest(stopped)).toMatchObject({ status: 'FAILED', note: 'listing the bucket failed with HTTP 403' });
    await requestBackup(sa);
    expect(await serveBackupRequest(brokeDown)).toMatchObject({ status: 'FAILED', note: 'spawn bash ENOENT' });
  });

  it('ADR-0050: the nightly backup runs unless paused; a pause covers its last day, then lifts by itself', async () => {
    const sa = await as('SUPER_ADMIN');
    const today = businessDate(new Date());
    expect(await runNightlyBackup(worked)).toMatchObject({ trigger: 'NIGHTLY', status: 'SUCCEEDED' });

    await pauseBackups(sa, addDays(today, 3));
    expect((await storageOverview(sa)).backupsPausedUntil).toBe(addDays(today, 3));
    expect(await runNightlyBackup(worked, at05(addDays(today, 3)))).toMatchObject({ status: 'SKIPPED', note: 'PAUSED' });
    expect(await runNightlyBackup(worked, at05(addDays(today, 4)))).toMatchObject({ status: 'SUCCEEDED' });

    // Lifted early, it runs at once again.
    await pauseBackups(sa, null);
    expect((await storageOverview(sa)).backupsPausedUntil).toBeNull();
    expect(await runNightlyBackup(worked)).toMatchObject({ status: 'SUCCEEDED' });

    // A pause always ends — after today, within 30 days — and only the Super Admin sets one. Both changes were audited.
    expect(await code(pauseBackups(sa, addDays(today, 31)))).toBe('INVALID_SETTING');
    expect(await code(pauseBackups(sa, today))).toBe('INVALID_SETTING');
    expect(await code(pauseBackups(await as('ADMIN'), addDays(today, 1)))).toBe('FORBIDDEN');
    const changes = await ownerQuery<{ after: Record<string, unknown> }>(
      `select after from audit_log where action = 'system.settings_changed' order by occurred_at`,
    );
    expect(changes.map((c) => c.after['storage.backups_paused_until'])).toEqual([addDays(today, 3), null]);
  });

  it('ADR-0050: the nightly backup does not start while another runs; a run the worker died in is let go', async () => {
    const sa = await as('SUPER_ADMIN');
    await requestBackup(sa);
    // Taken up, then the worker went down mid-backup.
    await ownerQuery(`update backup_runs set status = 'RUNNING', started_at = now() where status = 'REQUESTED'`);
    expect(await runNightlyBackup(worked)).toMatchObject({ status: 'SKIPPED', note: 'BUSY' });

    // Past the worker's hour, the stuck run is let go and the next one starts.
    expect(await runNightlyBackup(worked, new Date(Date.now() + 71 * MINUTE))).toMatchObject({ status: 'SUCCEEDED' });
    expect((await recentBackupRuns()).find((r) => r.trigger === 'MANUAL')).toMatchObject({ status: 'FAILED', note: 'STOPPED' });
  });

  it('ADR-0050: the page warns when the newest backup is more than a day and a half old — but not while paused', async () => {
    const sa = await as('SUPER_ADMIN');
    const modified = new Date(Date.now() - 2 * 24 * 60 * MINUTE);
    await reportBackups({ bucket: 'gsa-backups', days: 30, copies: [{ key: backupKey(modified), modified, size: 100 }] });
    expect((await storageOverview(sa)).backups?.stale).toBe(true);
    await pauseBackups(sa, addDays(businessDate(new Date()), 1));
    expect((await storageOverview(sa)).backups?.stale).toBe(false);
  });
});
