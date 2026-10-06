import { describe, expect, it } from 'vitest';
import { type DomainError } from '../errors';
import { addDays, isCalendarDate } from '../time';
import {
  assertPauseUntil, BACKUP_NAME, BACKUP_PREFIX, backupIsStale, backupKey, backupsPausedOn, backupsRemovedBy, backupsSwitchedOn, chooseBackup,
  expiredBackups, isPgDump, parseBackupListing, type StoredBackup,
} from './backups';
import { parseSetting } from './settings';

const NOW = new Date('2026-09-21T03:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);
const at = (n: number): StoredBackup => ({ key: backupKey(daysAgo(n)), modified: daysAgo(n) });

describe('backup retention', () => {
  it('names a backup after the moment it was taken', () => {
    expect(backupKey(new Date('2026-09-21T03:15:00.123Z'))).toBe('gsa-20260921T031500Z.dump');
  });

  it('removes what is past retention and keeps what is not', () => {
    const { remove, refused } = expiredBackups([at(40), at(31), at(29), at(1)], { now: NOW, days: 30 });
    expect(remove.map((b) => b.key)).toEqual([at(40).key, at(31).key]);
    expect(refused).toBeNull();
  });

  it('never removes the backup just written, however the clock reads', () => {
    const fresh = at(0);
    const { remove } = expiredBackups([at(40), fresh], { now: NOW, days: 30, justWritten: fresh.key });
    expect(remove.map((b) => b.key)).toEqual([at(40).key]);
  });

  it('leaves alone anything that is not one of ours', () => {
    const stranger: StoredBackup = { key: 'someone-elses-file.tar.gz', modified: daysAgo(400) };
    const { remove } = expiredBackups([stranger, at(40), at(1)], { now: NOW, days: 30 });
    expect(remove.map((b) => b.key)).toEqual([at(40).key]);
  });

  it('refuses to empty the bucket rather than tidying away the last copy', () => {
    const { remove, refused } = expiredBackups([at(400), at(390)], { now: NOW, days: 30 });
    expect(remove).toEqual([]);
    expect(refused).toMatch(/check the backups' period on the Storage page and the server clock/);
  });

  it('a bucket holding only a stranger removes nothing and refuses nothing', () => {
    const stranger: StoredBackup = { key: 'notes.txt', modified: daysAgo(400) };
    expect(expiredBackups([stranger], { now: NOW, days: 30 })).toEqual({ remove: [], remaining: [], refused: null });
  });
});

describe('the listing prefix', () => {
  it('matches every key the namer produces, so a prefixed listing misses none', () => {
    for (const at of [new Date('2026-01-01T00:00:00Z'), new Date('2026-12-31T23:59:59Z'), new Date()]) {
      expect(backupKey(at).startsWith(BACKUP_PREFIX)).toBe(true);
      expect(BACKUP_NAME.test(backupKey(at))).toBe(true);
    }
  });
});

describe('what is left after a run', () => {
  it('counts the backup just written once, not twice', () => {
    // The listing is taken after the upload, so the new key is already in it.
    const fresh = at(0);
    const { remaining } = expiredBackups([at(40), at(2), fresh], { now: NOW, days: 30, justWritten: fresh.key });
    expect(remaining.map((b) => b.key)).toEqual([at(2).key, fresh.key]);
  });

  it('leaves the count untouched when retention refuses', () => {
    const { remove, remaining } = expiredBackups([at(400), at(390)], { now: NOW, days: 30 });
    expect(remove).toEqual([]);
    expect(remaining).toHaveLength(2);
  });

  it('does not count a stranger as a backup', () => {
    const stranger: StoredBackup = { key: 'notes.txt', modified: daysAgo(1) };
    expect(expiredBackups([stranger, at(1)], { now: NOW, days: 30 }).remaining).toHaveLength(1);
  });
});

describe("the storage page's preview (ADR-0049)", () => {
  const sized = (n: number, size: number): StoredBackup => ({ ...at(n), size });

  it('says what a shorter period removes — by the same rule, so never the last copy', () => {
    const stored = [sized(40, 100), sized(20, 200), sized(10, 300), sized(1, 400)];
    expect(backupsRemovedBy(stored, { now: NOW, days: 30 })).toEqual({ files: 1, bytes: 100 });
    expect(backupsRemovedBy(stored, { now: NOW, days: 7 })).toEqual({ files: 3, bytes: 600 });
    expect(backupsRemovedBy([sized(40, 100), sized(39, 100)], { now: NOW, days: 7 })).toEqual({ files: 0, bytes: 0 });
  });
});

describe('a server that takes no backups (RUNBOOK §5.1)', () => {
  it('takes them only with all three settings — a bucket alone is not a backup', () => {
    expect(backupsSwitchedOn({ bucket: 'gsa-backups', accessKey: 'id', secretKey: 'secret' })).toBe(true);
    expect(backupsSwitchedOn({ bucket: 'gsa-backups' })).toBe(false);
    expect(backupsSwitchedOn({ bucket: 'gsa-backups', accessKey: 'id', secretKey: '' })).toBe(false);
    expect(backupsSwitchedOn({})).toBe(false);
  });
});

describe('reading the bucket back (ADR-0050)', () => {
  const contents = (key: string, modified: string, size: number) =>
    `<Contents><Key>${key}</Key><LastModified>${modified}</LastModified><ETag>"x"</ETag><Size>${size}</Size></Contents>`;

  it('takes our backups from a listing page, with their dates and sizes, and the token for the next page', () => {
    const xml = `<ListBucketResult><IsTruncated>true</IsTruncated>${contents('gsa-20261006T020000Z.dump', '2026-10-06T02:00:05.000Z', 5_000_000)}`
      + `${contents('notes.txt', '2026-10-06T02:00:05.000Z', 10)}<NextContinuationToken>1ueGcxLPRx1Tr/XYExHnhbYLgveDs2J</NextContinuationToken></ListBucketResult>`;
    expect(parseBackupListing(xml)).toEqual({
      backups: [{ key: 'gsa-20261006T020000Z.dump', modified: new Date('2026-10-06T02:00:05.000Z'), size: 5_000_000 }],
      next: '1ueGcxLPRx1Tr/XYExHnhbYLgveDs2J',
    });
    expect(parseBackupListing(`<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>`)).toEqual({ backups: [], next: null });
  });

  it('restores from the newest unless one is named — and a name that is not there is not quietly replaced', () => {
    const list = [at(3), at(1), at(2)];
    expect(chooseBackup(list)?.key).toBe(at(1).key);
    expect(chooseBackup(list, at(3).key)?.key).toBe(at(3).key);
    expect(chooseBackup(list, 'gsa-19990101T000000Z.dump')).toBeUndefined();
    expect(chooseBackup([])).toBeUndefined();
  });

  it('knows a pg_dump archive by its first bytes', () => {
    expect(isPgDump(new TextEncoder().encode('PGDMP\u0001\u000e'))).toBe(true);
    expect(isPgDump(new TextEncoder().encode('%PDF-1.7'))).toBe(false);
    expect(isPgDump(new TextEncoder().encode('PGD'))).toBe(false);
  });
});

describe('pausing the nightly backup (ADR-0050)', () => {
  const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as DomainError).code; } return 'NO_ERROR'; };

  it('a pause covers every night through its last day, and then lifts by itself', () => {
    expect(backupsPausedOn(null, '2026-10-06')).toBe(false);
    expect(backupsPausedOn('2026-10-10', '2026-10-10')).toBe(true);
    expect(backupsPausedOn('2026-10-10', '2026-10-11')).toBe(false);
  });

  it('a pause always ends: after today, and no more than 30 days on', () => {
    expect(code(() => assertPauseUntil('2026-10-07', '2026-10-06'))).toBe('NO_ERROR');
    expect(code(() => assertPauseUntil('2026-11-05', '2026-10-06'))).toBe('NO_ERROR');
    for (const bad of ['2026-11-06', '2026-10-06', '2026-10-01', '2026-02-30', 'soon']) {
      expect(code(() => assertPauseUntil(bad, '2026-10-06'))).toBe('INVALID_SETTING');
    }
    expect(parseSetting('storage.backups_paused_until', null)).toBeNull();
    expect(parseSetting('storage.backups_paused_until', '2026-10-10')).toBe('2026-10-10');
    for (const bad of ['2026-02-30', 5, '']) expect(code(() => parseSetting('storage.backups_paused_until', bad))).toBe('INVALID_SETTING');
  });

  it('the newest backup more than a day and a half old means the nightly one has stopped', () => {
    const now = new Date('2026-10-08T12:00:00Z');
    expect(backupIsStale(null, now)).toBe(false);
    expect(backupIsStale(new Date(now.getTime() - 35 * 3_600_000), now)).toBe(false);
    expect(backupIsStale(new Date(now.getTime() - 37 * 3_600_000), now)).toBe(true);
  });

  it('calendar dates: real ones only, and whole days added across months and years', () => {
    expect(['2026-10-06', '2028-02-29'].map(isCalendarDate)).toEqual([true, true]);
    expect(['2026-02-29', '2026-13-01', '2026-1-6', ''].map(isCalendarDate)).toEqual([false, false, false, false]);
    expect([addDays('2026-10-06', 30), addDays('2026-12-31', 1), addDays('2026-03-01', -1)]).toEqual(['2026-11-05', '2027-01-01', '2026-02-28']);
  });
});

