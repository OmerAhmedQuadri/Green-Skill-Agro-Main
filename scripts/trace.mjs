#!/usr/bin/env node
/**
 * Requirement traceability (TESTING §5): which requirements each milestone
 * claims, and which of those no test title mentions.
 *
 *   node scripts/trace.mjs            report every milestone
 *   node scripts/trace.mjs M0         report one milestone; exit 1 if any requirement is untested
 *
 * Reads docs/REQUIREMENTS.md and docs/MILESTONES.md, which are never committed,
 * so this runs locally only and skips cleanly elsewhere.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../', import.meta.url).pathname;
const REQUIREMENTS = join(root, 'docs/REQUIREMENTS.md');
const MILESTONES = join(root, 'docs/MILESTONES.md');
if (!existsSync(REQUIREMENTS) || !existsSync(MILESTONES)) {
  console.log('trace: docs/ not present (fresh clone or CI) — traceability runs locally only; skipped');
  process.exit(0);
}

// Every defined requirement, in document order.
const defined = [...readFileSync(REQUIREMENTS, 'utf8').matchAll(/^\| ([A-Z0-9]{2,4}-\d{3}) \|/gm)].map((m) => m[1]);
const known = new Set(defined);

// Requirement references per milestone: "CAT-001..003", "VEH-001..004, 009, 010", "SAL-011".
const expand = (text) => {
  const ids = new Set();
  for (const m of text.matchAll(/([A-Z0-9]{2,4})-(\d{3})(?:\.\.(\d{3}))?((?:,\s*\d{3}(?:\.\.\d{3})?)*)/g)) {
    const [, prefix, from, to, more] = m;
    const add = (a, b = a) => { for (let n = Number(a); n <= Number(b); n += 1) ids.add(`${prefix}-${String(n).padStart(3, '0')}`); };
    add(from, to);
    for (const extra of more.matchAll(/(\d{3})(?:\.\.(\d{3}))?/g)) add(extra[1], extra[2]);
  }
  return [...ids].filter((id) => known.has(id));
};
// Each "## " section stands alone. Milestones gate; "Cross-cutting" is reported
// but never gates; "By design" is verified by review and excluded.
const milestones = new Map();
const byDesign = new Set();
for (const section of readFileSync(MILESTONES, 'utf8').split(/^## /m).slice(1)) {
  const name = section.slice(0, section.indexOf('\n')).trim();
  if (/^M\d+ /.test(name)) milestones.set(name.split(' ')[0], { name, ids: expand(section) });
  else if (/^Cross-cutting/i.test(name)) milestones.set('cross-cutting', { name: 'Cross-cutting (reported, never gating)', ids: expand(section) });
  else if (/^By design/i.test(name)) for (const id of expand(section)) byDesign.add(id);
}

// Requirement IDs mentioned in test titles: it('SAL-005: …') / test('CNV-009, TGT-004: …').
const testFiles = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(test|spec)\.tsx?$/.test(entry)) testFiles.push(path);
  }
};
for (const dir of ['apps', 'packages']) walk(join(root, dir));
const tested = new Set();
// A requirement named only by pure unit tests in packages/core may have its
// rule but no feature — AUD-003 had a permission test and no audit screen.
const beyondCore = new Set();
for (const file of testFiles) {
  const unitOnly = file.includes('/packages/core/');
  for (const m of readFileSync(file, 'utf8').matchAll(/\b(?:it|test)(?:\.\w+)?\(\s*(['"`])(.*?)\1/g)) {
    for (const id of m[2].matchAll(/[A-Z0-9]{2,4}-\d{3}/g)) {
      if (!known.has(id[0])) continue;
      tested.add(id[0]);
      if (!unitOnly) beyondCore.add(id[0]);
    }
  }
}

const only = process.argv[2];
let untestedInScope = 0;
for (const [key, { name, ids }] of milestones) {
  if (only && key !== only) continue;
  const missing = ids.filter((id) => !tested.has(id));
  if (only) untestedInScope = missing.length;
  const mark = ids.length === 0 ? '·' : missing.length === 0 ? '✓' : '…';
  console.log(`${mark} ${name.padEnd(56)} ${String(ids.length - missing.length).padStart(3)}/${String(ids.length).padEnd(3)} tested`);
  if (missing.length && (only || missing.length <= 12)) console.log(`    untested: ${missing.join(', ')}`);
  const thin = ids.filter((id) => tested.has(id) && !beyondCore.has(id));
  if (thin.length && (only || missing.length === 0)) console.log(`    core unit tests only — check the feature exists: ${thin.join(', ')}`);
}
if (!only) {
  const claimed = new Set([...milestones.values()].flatMap((m) => m.ids).concat([...byDesign]));
  if (byDesign.size) console.log(`\nVerified by design, not by tests: ${[...byDesign].join(', ')}`);
  const orphans = defined.filter((id) => !claimed.has(id));
  console.log(`\n${tested.size} of ${defined.length} requirements have a test. ${testFiles.length} test files scanned.`);
  if (orphans.length) console.log(`Requirements no milestone claims (${orphans.length}): ${orphans.join(', ')}`);
}
process.exit(only && untestedInScope > 0 ? 1 : 0);
