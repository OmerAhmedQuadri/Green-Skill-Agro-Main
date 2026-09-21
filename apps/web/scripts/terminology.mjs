import { readFileSync } from 'node:fs';
import { argv, exit } from 'node:process';
import readXlsxFile from 'read-excel-file/node';

/**
 * I18N-004: the Arabic terminology pass.
 *
 * Green Skill Agro were sent sheet 11 with a suggested Arabic word for every
 * interface term, and returned it with the "your preferred wording" column
 * blank on all 253 rows — which the sheet defines as "the suggestion is fine",
 * and which they confirmed on 2026-09-21.
 *
 * So the sheet is the authority and this checks the app against it, rather than
 * asking anyone to read 253 rows again. It reports three things:
 *
 *   - **Disagreements**: the app says one thing where the sheet says another.
 *     Each is a decision someone has to make, and the sheet wins by default
 *     (GLOSSARY.md).
 *   - **Unused**: the sheet's term never appears in the app. Usually a screen
 *     that words it differently, sometimes a term we stopped using.
 *   - **Ours alone**: wording the app uses that the sheet never covered. These
 *     are 2IM Labs' choice and are what `(review)` is for at the post-delivery
 *     review.
 *
 * Matching is by the English term, which is the only key the two share. A term
 * is compared only where the app's English matches the sheet's exactly, so a
 * near-match is reported as uncovered rather than silently paired with the
 * wrong row.
 *
 *   node scripts/terminology.mjs <workbook.xlsx> [--all]
 *
 * The workbook is client data, so this prints a summary and writes nothing;
 * redirect it into the client-data folder if a copy is wanted.
 */

const HEADER_ROW = 3;
const file = argv[2];
if (!file) {
  console.error('usage: node scripts/terminology.mjs <workbook.xlsx> [--all]');
  exit(1);
}
const showAll = argv.includes('--all');

const en = JSON.parse(readFileSync(new URL('../src/messages/en.json', import.meta.url), 'utf8'));
const ar = JSON.parse(readFileSync(new URL('../src/messages/ar.json', import.meta.url), 'utf8'));

/** Every leaf string, by its dotted key. */
function flatten(node, prefix = '', out = new Map()) {
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.set(path, value);
    else if (value && typeof value === 'object') flatten(value, path, out);
  }
  return out;
}

const english = flatten(en);
const arabic = flatten(ar);

/** English wording to the keys that use it — one word can appear on many screens. */
const byEnglish = new Map();
for (const [key, value] of english) {
  const word = value.trim().toLowerCase();
  byEnglish.set(word, [...(byEnglish.get(word) ?? []), key]);
}

const sheets = await readXlsxFile(file);
const terms = sheets.find((s) => s.sheet.startsWith('11.'));
if (!terms) {
  console.error('this workbook has no "11. Arabic Terms" sheet');
  exit(1);
}

const headers = (terms.data[HEADER_ROW] ?? []).map((c) => String(c ?? '').trim().toLowerCase());
const at = (name) => headers.findIndex((h) => h.startsWith(name));
const columns = { area: at('area'), english: at('english term'), suggested: at('suggested arabic'), preferred: at('your preferred') };
if (Object.values(columns).some((i) => i < 0)) {
  console.error('sheet 11 does not have the columns this expects');
  exit(1);
}

const text = (row, index) => String(row?.[index] ?? '').trim();
const rows = terms.data.slice(HEADER_ROW + 1)
  .map((row) => ({
    area: text(row, columns.area),
    english: text(row, columns.english),
    // A preferred word wins over the suggestion; blank means the suggestion stands.
    wanted: text(row, columns.preferred) || text(row, columns.suggested),
    corrected: text(row, columns.preferred) !== '',
  }))
  .filter((r) => r.english && r.wanted);

const agree = [];
const differ = [];
const unused = [];
for (const row of rows) {
  const keys = byEnglish.get(row.english.toLowerCase());
  if (!keys) { unused.push(row); continue; }
  for (const key of keys) {
    const ours = (arabic.get(key) ?? '').trim();
    (ours === row.wanted ? agree : differ).push({ ...row, key, ours });
  }
}

const covered = new Set(rows.map((r) => r.english.toLowerCase()));
const oursAlone = [...byEnglish].filter(([word]) => !covered.has(word));

const corrections = rows.filter((r) => r.corrected).length;
console.log(`sheet 11: ${rows.length} terms, ${corrections} with a preferred wording of their own`);
console.log(`app: ${english.size} English strings, ${arabic.size} Arabic\n`);
console.log(`  agree            ${String(agree.length).padStart(4)}`);
console.log(`  disagree         ${String(differ.length).padStart(4)}   ← decisions`);
console.log(`  unused by the app${String(unused.length).padStart(4)}`);
console.log(`  ours alone       ${String(oursAlone.length).padStart(4)}   ← what (review) is for\n`);

if (differ.length > 0) {
  console.log('## Where the app and the sheet disagree\n');
  for (const d of differ.sort((a, b) => a.key.localeCompare(b.key))) {
    console.log(`- ${d.key}  "${d.english}"`);
    console.log(`    sheet: ${d.wanted}${d.corrected ? '   (their own wording)' : ''}`);
    console.log(`    app:   ${d.ours || '(missing)'}`);
  }
  console.log('');
}

if (showAll) {
  console.log('## In the sheet, not used by the app\n');
  for (const u of unused) console.log(`- ${u.area ? `${u.area}: ` : ''}${u.english} — ${u.wanted}`);
  console.log('\n## Used by the app, not in the sheet\n');
  for (const [word, keys] of oursAlone) console.log(`- ${word}  (${keys.length} key${keys.length === 1 ? '' : 's'})`);
}
