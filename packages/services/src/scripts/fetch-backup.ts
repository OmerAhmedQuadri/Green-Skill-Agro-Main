import { existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { chooseBackup, isPgDump } from '@gsa/core';
import { backupBucket, mib, scriptArgs } from './backup-bucket';

/**
 * Fetch one backup from the backups bucket onto this server, to restore from
 * (ADR-0050, handover RUNBOOK §5.4).
 *
 *   pnpm db:fetch-backup [--key gsa-20261006T020000Z.dump] [--out /absolute/path.dump]
 *
 * `deploy/fetch-backup.sh` calls this on the server. The newest backup unless
 * one is named; written to the home directory under its own name unless told
 * otherwise. The download is checked against the bucket's listing, and must be
 * a pg_dump archive, before a byte is written — and it never overwrites a
 * file, because the file it would replace may be the only other copy.
 */

const args = scriptArgs();
const named = args.get('key');
const outArg = args.get('out');
if (named === 'yes' || outArg === 'yes') throw new Error('usage: pnpm db:fetch-backup [--key <backup name>] [--out <absolute path>]');
if (outArg && !isAbsolute(outArg)) throw new Error(`--out needs an absolute path, such as /root/restore.dump — not ${outArg}`);

const { bucket, client, objectUrl, listAll } = backupBucket();
const chosen = chooseBackup(await listAll(), named);
if (!chosen) {
  throw new Error(named
    ? `${bucket} has no backup named ${named} — run without --key for the newest`
    : `${bucket} holds no backups yet — nothing was written`);
}

const out = outArg ?? join(homedir(), chosen.key);
if (existsSync(out)) throw new Error(`${out} already exists — move it aside, or pass --out with another path. Nothing was written.`);

console.log(`  ${bucket}/${chosen.key}, taken ${chosen.modified.toISOString()}${chosen.size === undefined ? '' : ` (${mib(chosen.size)})`}`);
const response = await client.fetch(objectUrl(chosen.key));
if (response.status !== 200) throw new Error(`the download failed with HTTP ${response.status} — nothing was written`);
const body = new Uint8Array(await response.arrayBuffer());
if (chosen.size !== undefined && body.byteLength !== chosen.size) {
  throw new Error(`downloaded ${body.byteLength} bytes of ${chosen.size} — try again; nothing was written`);
}
if (!isPgDump(body.subarray(0, 5))) throw new Error(`${chosen.key} is not a pg_dump archive — nothing was written`);

// Every customer, price and balance in the business, in one file: readable by
// its owner alone, and written only where nothing was before.
writeFileSync(out, body, { mode: 0o600, flag: 'wx' });
console.log(`  → ${out} (${mib(body.byteLength)}), readable by you alone`);
console.log('  Restore it into a scratch database first (RUNBOOK §5.4), and delete it when you are done.');
