import { describe, expect, it } from 'vitest';
import { backupKey, expiredBackups, type StoredBackup } from './retention';

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
    expect(refused).toMatch(/check BACKUP_RETENTION_DAYS and the server clock/);
  });

  it('a bucket holding only a stranger removes nothing and refuses nothing', () => {
    const stranger: StoredBackup = { key: 'notes.txt', modified: daysAgo(400) };
    expect(expiredBackups([stranger], { now: NOW, days: 30 })).toEqual({ remove: [], refused: null });
  });
});
