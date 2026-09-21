import type { Assessed, Survey } from './assess';
import type { Issue } from './workbook';

/**
 * The cleansing report (MIG-003): every row the import could not resolve, where
 * to find it, and what to ask.
 *
 * Written to a file, never to stdout — it names stores, vendors and SKUs, and
 * CLIENT-DATA is explicit that client data does not go into logs or chat. The
 * file lives outside git with the workbook it describes.
 *
 * It is written for Green Skill Agro to answer, not for us to read, so it is ordered
 * by what blocks the system rather than by sheet.
 */

const HEADINGS: Record<Issue['kind'], string> = {
  MISSING_REQUIRED_FIELD: 'Missing information the system needs',
  CONFLICTING_VALUE: 'Two values that disagree',
  LOOKS_LIKE_TEMPLATE_EXAMPLE: 'Rows that look like the template\'s own examples',
  UNKNOWN_REFERENCE: 'References to something that does not exist',
  NEEDS_CONFIRMATION: 'Changes made automatically, for confirmation',
};

/** Blocking first: a store nobody can trade with matters more than a tidied code. */
const ORDER: readonly Issue['kind'][] = [
  'MISSING_REQUIRED_FIELD', 'CONFLICTING_VALUE', 'UNKNOWN_REFERENCE', 'LOOKS_LIKE_TEMPLATE_EXAMPLE', 'NEEDS_CONFIRMATION',
];

const WHAT_TO_DO: Record<Issue['kind'], string> = {
  MISSING_REQUIRED_FIELD: 'Supply the value in the workbook, or tell us to enter these fresh in the system instead (MIG-005).',
  CONFLICTING_VALUE: 'Tell us which of the two is right. We have loaded neither.',
  UNKNOWN_REFERENCE: 'Either the referenced row is missing from the workbook, or the reference is a typo.',
  LOOKS_LIKE_TEMPLATE_EXAMPLE: 'Confirm whether each is a real record or one of the examples we left in the template. We have loaded none of them.',
  NEEDS_CONFIRMATION: 'No action needed unless one of these is wrong.',
};

export type ReportInput = {
  readonly assessed: Assessed;
  /** The sheets nobody has answered for, which a list of problems would not show. */
  readonly survey: Survey;
  readonly workbook: string;
  readonly at: Date;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * MIG-001, MIG-004: what loaded, what did not, and what Green Skill Agro has to
 * answer before the system can be used in earnest.
 */
export function cleansingReport({ assessed, survey, workbook, at }: ReportInput): string {
  const parts = Object.entries(assessed);
  const issues = parts.flatMap(([, part]) => part.issues);
  const lines: string[] = [];

  lines.push('# Data cleansing report');
  lines.push('');
  lines.push(`Workbook: ${workbook}`);
  lines.push(`Prepared: ${at.toISOString().slice(0, 10)}`);
  lines.push('');
  lines.push('This lists everything the import could not decide for itself. Each entry');
  lines.push('names the sheet and the row as the spreadsheet numbers them, so it can be');
  lines.push('found by opening the file at that row.');
  lines.push('');
  lines.push('Nothing uncertain has been loaded. Where a value could not be confirmed the');
  lines.push('record was left out rather than carried across in a doubtful state, so the');
  lines.push('system holds less than the workbook does, and what it holds is right.');
  lines.push('');

  lines.push('## What loaded');
  lines.push('');
  // Rows, not records: sheet 1 writes a category once per sub-category, so
  // three rows there are two categories. The verification report counts records.
  lines.push('| Sheet | Rows loaded | Rows left for review |');
  lines.push('| :--- | ---: | ---: |');
  // Named as the workbook names them, so a row can be checked against the file.
  for (const [, part] of parts) {
    lines.push(`| ${part.sheet} | ${part.loadable.length} | ${part.issues.length} |`);
  }
  lines.push('');

  if (survey.untouched.length > 0) {
    lines.push(`## Sheets that came back exactly as we sent them (${survey.untouched.length})`);
    lines.push('');
    lines.push('Every row on these is still one of our worked examples — we can tell,');
    lines.push('because the template tints its own. Nothing on them has been loaded.');
    lines.push('');
    lines.push('This matters more than an empty sheet would: where a sheet sets how the');
    lines.push('system behaves, leaving it means running on our suggestions rather than');
    lines.push('your decisions. Say so if the suggestions are right and we will adopt them');
    lines.push('as they stand.');
    lines.push('');
    for (const { sheet, rows } of survey.untouched) lines.push(`- **${sheet}** — all ${plural(rows, 'row', 'rows')}`);
    lines.push('');
  }

  if (survey.unread.length > 0) {
    lines.push('## Sheets this report does not cover');
    lines.push('');
    lines.push('Read as part of the setup, not the import, so nothing on them appears above.');
    lines.push('Where rows of ours are still on them, the count says how many.');
    lines.push('');
    for (const { sheet, rows, shaded } of survey.unread) {
      lines.push(shaded > 0
        ? `- **${sheet}** — ${shaded} of its ${plural(rows, 'row', 'rows')} still ours`
        : `- **${sheet}** — ${plural(rows, 'row', 'rows')}`);
    }
    lines.push('');
  }

  if (issues.length === 0) {
    lines.push('Nothing else needs confirming. Every row in the sheets above loaded.');
    return `${lines.join('\n')}\n`;
  }

  lines.push(`## What needs an answer (${plural(issues.length, 'item', 'items')})`);
  lines.push('');

  for (const kind of ORDER) {
    const group = issues.filter((i) => i.kind === kind);
    if (group.length === 0) continue;
    lines.push(`### ${HEADINGS[kind]}`);
    lines.push('');
    lines.push(WHAT_TO_DO[kind]);
    lines.push('');
    for (const { sheet, row, detail } of group) {
      // Row 0 means the issue is about the sheet as a whole, not one row.
      lines.push(row > 0 ? `- **${sheet}**, row ${row} — ${detail}` : `- **${sheet}** — ${detail}`);
    }
    lines.push('');
  }

  lines.push('## Before the system is used in earnest');
  lines.push('');
  lines.push('MIG-004 asks Green Skill Agro to review and verify the loaded data. The counts above');
  lines.push('are the place to start: they should match what you expect to see in the system.');
  return `${lines.join('\n')}\n`;
}
