import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { imports } from '@gsa/contracts';
import { effectivePermissions, type BranchId, type UserId } from '@gsa/core';
import { schema } from '@gsa/db';
import { eq } from 'drizzle-orm';
import type { Ctx } from '../context';
import { loadOverrides } from '../identity';
import { loadHistoryImport, planHistoryImport, undoImportBatch, type HistoryFile, type HistoryPlan } from '../migration';
import { closeDb, getDb } from '../runtime';
import { confirmTarget, databaseTarget } from './target';

/**
 * Loading Green Agro's sellers' books (M13 step h; IMP-001, IMP-002, IMP-004, IMP-009; ADR-0059).
 *
 *   pnpm db:import-history --file <import.json> --seller "Name=email" …                     dry run — writes the report
 *   pnpm db:import-history --file <import.json> --seller "Name=email" … --load --as <email>  also loads it, as one batch
 *   pnpm db:import-history --undo <batch number> --reason "…" --as <email>                  undoes a whole batch
 *
 * The file is what our tools write from the books (docs/reference/client-data/tools). The dry run is the default:
 * it checks the file against this database and writes its report beside the file — which lives outside git with the
 * client's data — never to the terminal, because it names stores. Loading names the account that owns every record,
 * and makes the operator type the database back first.
 */

const argv = process.argv.slice(2);
const flag = (name: string) => { const i = argv.indexOf(`--${name}`); return i < 0 ? undefined : (argv[i + 1]?.startsWith('--') ? 'yes' : (argv[i + 1] ?? 'yes')); };
const sellers = new Map<string, string>();
for (const [i, arg] of argv.entries()) {
  if (arg !== '--seller') continue;
  const [name, email] = (argv[i + 1] ?? '').split('=');
  if (!name?.trim() || !email?.trim()) throw new Error('--seller takes "Name=email", the name as the books write it');
  sellers.set(name.trim(), email.trim());
}

const db = getDb();

async function operatorCtx(): Promise<{ ctx: Ctx; name: string }> {
  const email = flag('as');
  if (!email || email === 'yes') throw new Error('--as <email> is required: every record carries the account that created it');
  const [operator] = await db.select({
    id: schema.users.id, role: schema.users.role, name: schema.users.name, branchId: schema.users.branchId, status: schema.users.status,
    locale: schema.users.locale,
  }).from(schema.users).where(eq(schema.users.email, email.toLowerCase()));
  if (operator?.status !== 'ACTIVE') throw new Error('no active account with that email');
  return {
    name: operator.name,
    ctx: {
      user: { id: operator.id as UserId, role: operator.role },
      permissions: effectivePermissions(operator.role, await loadOverrides(db, operator.id as UserId)),
      now: new Date(), requestId: `import-history-${Date.now()}`, locale: operator.locale, branchId: operator.branchId as BranchId, ip: null,
    },
  };
}

async function confirmed(): Promise<boolean> {
  const target = databaseTarget();
  console.log('');
  console.log(`  about to write to  ${target.database} on ${target.where}`);
  console.log('');
  return confirmTarget(target);
}

// ------------------------------------------------------------------ undo

const undo = flag('undo');
if (undo) {
  const number = Number(undo);
  const reason = flag('reason');
  if (!Number.isInteger(number) || !reason || reason === 'yes') throw new Error('usage: --undo <batch number> --reason "…" --as <email>');
  const { ctx } = await operatorCtx();
  if (!(await confirmed())) { console.log('stopped; nothing was written.'); await closeDb(); process.exit(1); }
  await undoImportBatch(ctx, number, reason);
  console.log(`batch ${number} undone; its stores are withdrawn and its records out of use.`);
  await closeDb();
  process.exit(0);
}

// ------------------------------------------------------------------ dry run

const path = flag('file');
if (!path || path === 'yes') throw new Error('usage: pnpm db:import-history --file <import.json> --seller "Name=email" … [--load --as <email>]');
const bytes = readFileSync(path);
const file: HistoryFile = imports.HistoryImportFile.parse(JSON.parse(bytes.toString('utf8')));
const plan = await planHistoryImport(db, file, sellers);
const reportPath = join(dirname(path), `${basename(path, '.json')}-dry-run.md`);
writeFileSync(reportPath, report(file, plan, basename(path)));
console.log(`read ${basename(path)}: ${plan.counts.stores} stores, ${plan.counts.sales} sales (${plan.counts.lines} lines), ${plan.counts.payments} payments, ${file.warnings.length} warnings`);
console.log(`${plan.problems.length} problem(s). Report written to ${reportPath}`);

if (flag('load') !== 'yes') {
  console.log('nothing was loaded. Add --load --as <email> to import it.');
  await closeDb();
  process.exit(plan.problems.length > 0 ? 1 : 0);
}
if (plan.problems.length > 0) { console.log('not loaded: settle the problems first.'); await closeDb(); process.exit(1); }

// ------------------------------------------------------------------ load

const { ctx, name } = await operatorCtx();
console.log(`  as                 ${name}`);
if (!(await confirmed())) { console.log('stopped; nothing was written.'); await closeDb(); process.exit(1); }
const files = [
  ...file.files,
  { name: basename(path), sha256: createHash('sha256').update(bytes).digest('hex'), bytes: statSync(path).size },
];
const loaded = await loadHistoryImport(ctx, file, plan, files);
console.log(`loaded as batch ${loaded.batch.number}: ${loaded.stores} stores await re-verification; ${loaded.sales} sales, ${loaded.payments} payments, ${loaded.warnings} warnings.`);
await closeDb();

function report(f: HistoryFile, p: HistoryPlan, name: string): string {
  const unmatched = [...new Set(f.sales.flatMap((s) => s.lines.filter((l) => !l.product || !p.products.get(
    `${l.product.name.trim().toLowerCase()}|${l.product.variety?.trim().toLowerCase() ?? ''}|${l.product.packGrams ?? ''}`,
  )).map((l) => `${l.item}${l.pack ? ` (${l.pack})` : ''}`)))].sort();
  return [
    `# History import — dry run of ${name}`, '',
    `Checked ${new Date().toISOString()} against ${databaseTarget().database} on ${databaseTarget().where}.`, '',
    '## What would be loaded', '',
    `- ${p.counts.stores} stores, awaiting re-verification`,
    `- ${p.counts.sales} sales with ${p.counts.lines} lines; ${p.counts.linesInCatalogue} lines name a catalogue product`,
    `- ${p.counts.payments} payments, ${p.counts.paymentsWithNoStore} of them with no store`,
    `- billed ${p.billed}, paid ${p.paid}`, '',
    '## Problems — nothing loads until these are settled', '',
    ...(p.problems.length ? p.problems.map((x) => `- ${x}`) : ['None.']), '',
    '## Warnings for the Super Admin', '',
    ...(Object.keys(p.counts.warnings).length ? Object.entries(p.counts.warnings).map(([k, n]) => `- ${k}: ${n}`) : ['None.']), '',
    '## Lines with no catalogue product', '',
    ...(unmatched.length ? unmatched.map((x) => `- ${x}`) : ['None.']), '',
  ].join('\n');
}
