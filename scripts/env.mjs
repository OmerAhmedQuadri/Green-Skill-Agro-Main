#!/usr/bin/env node
/**
 * Keeps `.env` structurally identical to `.env.example`: the same lines in the
 * same order — keys, comments, blank lines, spacing — differing only in the
 * values after `=` (DEVELOPMENT §4).
 *
 *   node scripts/env.mjs check   fail if .env has drifted (skips when .env is absent, e.g. CI)
 *   node scripts/env.mjs sync    rebuild .env from .env.example, keeping every value
 *
 * Never prints a value — only line numbers and key names.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const EXAMPLE = new URL('.env.example', root);
const ENV = new URL('.env', root);
const KV = /^([A-Z][A-Z0-9_]*)=(.*)$/;
const read = (url) => readFileSync(url, 'utf8').split('\n');
const keyOf = (line) => KV.exec(line)?.[1];

const mode = process.argv[2] ?? 'check';
const template = read(EXAMPLE);

if (mode === 'sync') {
  const current = existsSync(ENV) ? read(ENV) : [];
  const values = new Map(current.flatMap((line) => { const m = KV.exec(line); return m ? [[m[1], m[2]]] : []; }));
  const templateKeys = new Set(template.map(keyOf).filter(Boolean));
  const orphans = [...values.keys()].filter((k) => !templateKeys.has(k));
  if (orphans.length > 0) {
    console.error(`env: .env has keys that .env.example lacks: ${orphans.join(', ')}. Add them to .env.example first.`);
    process.exit(1);
  }
  const fromTemplate = [];
  const rebuilt = template.map((line) => {
    const key = keyOf(line);
    if (!key) return line;
    if (values.has(key)) return `${key}=${values.get(key)}`;
    fromTemplate.push(key);
    return line;
  });
  writeFileSync(ENV, rebuilt.join('\n'));
  console.log(`env: .env rebuilt from .env.example — ${values.size} values kept` +
    (fromTemplate.length ? `; template placeholders used for ${fromTemplate.join(', ')}` : ''));
  process.exit(0);
}

if (mode !== 'check') {
  console.error('usage: node scripts/env.mjs check|sync');
  process.exit(2);
}
if (!existsSync(ENV)) {
  console.log('env: no .env present — skipped');
  process.exit(0);
}

const env = read(ENV);
const problems = [];
for (let i = 0; i < Math.max(env.length, template.length); i += 1) {
  const expected = template[i];
  const actual = env[i];
  const [ek, ak] = [expected === undefined ? undefined : keyOf(expected), actual === undefined ? undefined : keyOf(actual)];
  if (expected === undefined) problems.push(`line ${i + 1}: extra line in .env`);
  else if (actual === undefined) problems.push(`line ${i + 1}: missing from .env`);
  else if (ek || ak) { if (ek !== ak) problems.push(`line ${i + 1}: .env has ${ak ?? 'a non-key line'} where .env.example has ${ek ?? 'a non-key line'}`); }
  else if (expected !== actual) problems.push(`line ${i + 1}: comment or spacing differs`);
}
if (problems.length > 0) {
  console.error(`env: .env is out of sync with .env.example\n  ${problems.join('\n  ')}\nRun \`pnpm env:sync\` — it keeps every value.`);
  process.exit(1);
}
console.log('env: .env matches .env.example ✓');
