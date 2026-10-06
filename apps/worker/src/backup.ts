import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { system } from '@gsa/services';

const SCRIPT = fileURLToPath(new URL('../../../deploy/backup.sh', import.meta.url));

/**
 * ADR-0050: one database backup, as `deploy/backup.sh` takes it — the database
 * owner's dump inside the database container, then R2 — in a process of its
 * own, so nothing of it runs in, or is held by, the worker itself. Its output
 * goes to the worker's log; if it stops, the line saying why becomes the
 * reason the storage page shows.
 */
export const runBackupScript: system.BackupRunner = () => new Promise((resolve) => {
  const child = spawn('bash', [SCRIPT], { stdio: ['ignore', 'pipe', 'pipe'] });
  const lines: string[] = [];
  const read = (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n').map((l) => l.trim()).filter(Boolean)) {
      console.log(`[worker] backup: ${line}`);
      lines.push(line);
      if (lines.length > 50) lines.shift();
    }
  };
  child.stdout.on('data', read);
  child.stderr.on('data', read);
  child.on('error', (error) => resolve({ ok: false, error: error.message }));
  child.on('close', (code) => {
    if (code === 0) { resolve({ ok: true }); return; }
    const reason = lines.findLast((l) => l.startsWith('Stopped:'))?.slice('Stopped:'.length).trim();
    resolve({ ok: false, error: reason ?? lines.at(-1) ?? `the backup script exited with code ${String(code)}` });
  });
});
