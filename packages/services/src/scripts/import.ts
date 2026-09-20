import { createInterface } from 'node:readline/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { effectivePermissions, type BranchId, type UserId } from '@gsa/core';
import { schema } from '@gsa/db';
import { eq } from 'drizzle-orm';
import readXlsxFile from 'read-excel-file/node';
import { loadOverrides } from '../identity';
import { assess, cleansingReport, exampleRows, loadWorkbook, survey, verificationReport, type Sheet } from '../migration';
import { closeDb, getDb } from '../runtime';

/**
 * Loading Green Agro's setup workbook (MIG-001..006).
 *
 *   pnpm db:import --workbook <file>                    assess only — writes the report, touches no database
 *   pnpm db:import --workbook <file> --load --as <email>  also loads it
 *
 * Assessing is the default because it is the safe half: it reads the file,
 * writes the cleansing report, and tells Green Agro what to answer. Loading is
 * opt-in, names the account that will own every audit entry, and makes the
 * operator type the database host back before it writes anything.
 *
 * Reports are written beside the workbook — which lives outside git with the
 * client's data — and never to stdout: they name stores, vendors and people.
 */

const args = new Map<string, string>();
for (const [i, arg] of process.argv.slice(2).entries()) {
  if (!arg.startsWith('--')) continue;
  const next = process.argv.slice(2)[i + 1];
  args.set(arg.slice(2), next && !next.startsWith('--') ? next : 'yes');
}

const workbook = args.get('workbook');
if (!workbook) throw new Error('usage: pnpm db:import --workbook <file.xlsx> [--load --as <email>]');
const load = args.get('load') === 'yes';
const beside = (suffix: string) => join(args.get('out') ?? dirname(workbook), suffix);

// ------------------------------------------------------------------ assess

const sheets = (await readXlsxFile(workbook)) as unknown as Sheet[];
const examples = exampleRows(readFileSync(workbook));
const assessed = assess(sheets, examples);
const at = new Date();

const reportPath = beside('cleansing-report.md');
writeFileSync(reportPath, cleansingReport({
  assessed, survey: survey(sheets, examples, assessed), workbook: basename(workbook), at,
}));

const counts = Object.entries(assessed).map(([name, part]) => `${name} ${part.loadable.length}/${part.loadable.length + part.issues.length}`);
console.log(`read ${basename(workbook)}: ${counts.join(', ')}`);
console.log(`cleansing report written to ${reportPath}`);

if (!load) {
  console.log('nothing was loaded. Add --load --as <email> to import it.');
  await closeDb();
  process.exit(0);
}

// ------------------------------------------------------------------ who, and where

const operatorEmail = args.get('as');
if (!operatorEmail || operatorEmail === 'yes') throw new Error('--load needs --as <email>: every record carries the account that created it');

const db = getDb();
const [operator] = await db.select({
  id: schema.users.id, role: schema.users.role, name: schema.users.name,
  branchId: schema.users.branchId, status: schema.users.status, locale: schema.users.locale,
}).from(schema.users).where(eq(schema.users.email, operatorEmail.toLowerCase()));

if (!operator) throw new Error(`no account with that email — create it first, or import as an existing Admin`);
if (operator.status !== 'ACTIVE') throw new Error('that account is not active');

// The audit trail is only worth having if it names someone real, so the
// operator's own permissions decide what the import may do (ADR-0005).
const permissions = effectivePermissions(operator.role, await loadOverrides(db, operator.id as UserId));

// Checked before the prompt, not after it: being asked to confirm and then
// told it was never going to work is a poor way to learn that.
const [existing] = await db.select({ id: schema.categories.id }).from(schema.categories).limit(1);
if (existing) {
  console.error('this database already holds a catalogue. Import into an empty one (pnpm db:reset), or use a different database.');
  await closeDb();
  process.exit(1);
}

/** The host and database, never the password. */
const target = (() => {
  const url = new URL(process.env.DATABASE_URL ?? '');
  return { host: url.hostname, database: url.pathname.replace(/^\//, '') };
})();

console.log('');
console.log(`  about to import into  ${target.database} on ${target.host}`);
console.log(`  as                    ${operator.name} (${operator.role})`);
console.log('');
const rl = createInterface({ input: process.stdin, output: process.stdout });
const typed = await rl.question(`Type the host name (${target.host}) to continue, anything else to stop: `);
rl.close();
if (typed.trim() !== target.host) {
  console.log('stopped; nothing was written.');
  await closeDb();
  process.exit(1);
}

// ------------------------------------------------------------------ load

const result = await loadWorkbook({
  user: { id: operator.id as UserId, role: operator.role },
  permissions, now: new Date(), requestId: `import-${at.toISOString()}`,
  locale: operator.locale, branchId: operator.branchId as BranchId, ip: null,
}, assessed);

const verificationPath = beside('verification-report.md');
writeFileSync(verificationPath, verificationReport({ result, workbook: basename(workbook), operator: operator.name, at }));
console.log(`\nloaded. Verification report written to ${verificationPath}`);

if (result.accounts.length > 0) {
  // Credentials never reach a terminal, a log or this console (CLAUDE.md).
  const credentialsPath = beside('first-passwords.txt');
  writeFileSync(credentialsPath, `${result.accounts.map((a) => `${a.identifier}\t${a.temporaryPassword}\t${a.name}`).join('\n')}\n`, { mode: 0o600 });
  console.log(`${result.accounts.length} first passwords written to ${credentialsPath} — hand them over, then delete the file`);
}
if (result.refused.length > 0) console.log(`${result.refused.length} rows were refused; they are listed in the verification report`);

await closeDb();
