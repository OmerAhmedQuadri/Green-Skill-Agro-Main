/**
 * Reading Green Agro's setup workbook (MIG-001 assessment and cleansing).
 *
 * The workbook is 2IM Labs' own template, returned partly filled. Every data
 * sheet puts its headers on row 4, and the template's demonstration rows are
 * styled rather than marked, so nothing in the cell values says "this is an
 * example" (CLIENT-DATA.md).
 *
 * This module therefore **classifies rather than decides**: a row is loadable,
 * or it is an issue for someone to confirm (MIG-003). Nothing doubtful is
 * carried across in a doubtful state (MIG-005).
 *
 * It reads values only. Names, phones and prices never reach a log — the
 * caller decides what a report may show, and the report goes in a file that
 * git ignores, never to stdout.
 */

/** Headers sit on row 4 of every data sheet; rows above are the sheet's title block. */
export const HEADER_ROW = 3;

export type Cell = string | number | boolean | Date | null;
export type Sheet = { readonly sheet: string; readonly data: readonly (readonly Cell[])[] };

/** Why a row was not loaded. Each one is a question for Green Agro (MIG-003). */
export type IssueKind =
  | 'LOOKS_LIKE_TEMPLATE_EXAMPLE'
  | 'MISSING_REQUIRED_FIELD'
  | 'UNKNOWN_REFERENCE'
  | 'CONFLICTING_VALUE'
  | 'NEEDS_CONFIRMATION';

export type Issue = {
  readonly sheet: string;
  /** The row as the spreadsheet numbers it, so it can be found and fixed. */
  readonly row: number;
  readonly kind: IssueKind;
  /** What to ask. Names a column, never quotes personal data. */
  readonly detail: string;
};

export type SheetRows = {
  readonly sheet: string;
  readonly headers: readonly string[];
  /** Data rows with their spreadsheet row number, blank rows dropped. */
  readonly rows: readonly { readonly row: number; readonly cells: readonly Cell[] }[];
};

// A row shorter than the header simply has nothing there, which reads as empty.
const text = (cell: Cell | undefined): string => (cell === null || cell === undefined ? '' : String(cell).trim());
const filled = (cells: readonly Cell[]): number => cells.filter((c) => text(c) !== '').length;

/** The header row and the data beneath it, with the sheet's own row numbers kept. */
export function sheetRows(sheet: Sheet): SheetRows {
  const grid = sheet.data.filter((r): r is readonly Cell[] => Array.isArray(r));
  const headers = (grid[HEADER_ROW] ?? []).map(text);
  const rows = grid
    .map((cells, index) => ({ row: index + 1, cells }))
    .filter(({ row, cells }) => row > HEADER_ROW + 1 && filled(cells) > 0);
  return { sheet: sheet.sheet, headers, rows };
}

/** A column's position by its header, so a moved column does not silently shift the data. */
export function columnOf(headers: readonly string[], name: string): number {
  const wanted = name.toLowerCase();
  const at = headers.findIndex((h) => h.toLowerCase().startsWith(wanted));
  if (at < 0) throw new Error(`the sheet has no "${name}" column`);
  return at;
}

export const valueAt = (cells: readonly Cell[], at: number): string => text(cells[at]);

/**
 * The template's demonstration rows, by the shape they have and the real rows
 * do not.
 *
 * Green Agro filled the Stores sheet with names and almost nothing else, so a
 * row carrying a credit cycle, a credit limit and a price list is the
 * template's, not theirs. Where a sheet's rows are all the same shape this
 * finds nothing, which is the honest answer: the caller then reports the
 * outliers rather than guessing (`shapeOutliers`).
 */
export function templateExamples(rows: SheetRows, operationalColumns: readonly string[]): Set<number> {
  const positions = operationalColumns
    .map((name) => rows.headers.findIndex((h) => h.toLowerCase().startsWith(name.toLowerCase())))
    .filter((at) => at >= 0);
  if (positions.length === 0) return new Set();

  const fillsOperational = ({ cells }: { cells: readonly Cell[] }) => positions.every((at) => text(cells[at]) !== '');
  const candidates = rows.rows.filter(fillsOperational);
  // Only a small minority can be the template's; if most rows look like this,
  // the sheet is properly filled in and none of them are examples.
  return candidates.length > 0 && candidates.length <= rows.rows.length / 4
    ? new Set(candidates.map((r) => r.row))
    : new Set();
}

/**
 * Rows whose shape differs from the sheet's usual one. Not proof of anything —
 * a real row with a note filled in looks the same as a template example with a
 * note — so these are reported for confirmation, never dropped on their own.
 */
export function shapeOutliers(rows: SheetRows): { readonly row: number; readonly filled: number; readonly usual: number }[] {
  if (rows.rows.length < 4) return [];
  const counts = new Map<number, number>();
  for (const { cells } of rows.rows) counts.set(filled(cells), (counts.get(filled(cells)) ?? 0) + 1);
  const [usual] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [0];
  return rows.rows
    .filter(({ cells }) => filled(cells) !== usual)
    .map(({ row, cells }) => ({ row, filled: filled(cells), usual }));
}

/** CLIENT-DATA: three SKU codes carry a stray space. Everything else is Green Agro's to spell. */
export const tidySkuCode = (code: string): string => code.replace(/\s+/g, '');
