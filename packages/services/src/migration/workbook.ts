/**
 * Reading Green Skill Agro's setup workbook (MIG-001 assessment and cleansing).
 *
 * The workbook is 2IM Labs' own template, returned partly filled. Every data
 * sheet puts its headers on row 4, and the template's demonstration rows are
 * shaded rather than marked, so nothing in the cell values says "this is an
 * example" (CLIENT-DATA.md) — `styles.ts` reads the shading itself.
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

/** Why a row was not loaded. Each one is a question for Green Skill Agro (MIG-003). */
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

/** CLIENT-DATA: three SKU codes carry a stray space. Everything else is Green Skill Agro's to spell. */
export const tidySkuCode = (code: string): string => code.replace(/\s+/g, '');
