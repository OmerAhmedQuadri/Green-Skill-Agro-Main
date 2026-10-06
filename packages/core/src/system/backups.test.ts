import { describe, expect, it } from 'vitest';
import { BACKUP_NAME, BACKUP_PREFIX, backupKey, backupsRemovedBy, expiredBackups, type StoredBackup } from './backups';

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
