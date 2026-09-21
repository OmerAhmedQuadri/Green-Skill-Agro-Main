import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { EXAMPLE_FILL, exampleRows } from './styles';

/**
 * Built here rather than checked in: a real zip of real XML, so the parsing is
 * exercised, with none of Green Skill Agro's contents (CLIENT-DATA.md).
 *
 * The shape mirrors what Excel writes — fills are numbered by position, cell
 * formats point at a fill, and a cell points at a format.
 */
const OTHER_FILL = 'FFFFFF';

const styles = (fills: readonly string[], formatFills: readonly number[]) => `<?xml version="1.0"?>
<styleSheet><fills count="${fills.length}">${
  fills.map((rgb) => `<fill><patternFill patternType="solid"><fgColor rgb="FF${rgb}"/></patternFill></fill>`).join('')
}</fills><cellXfs count="${formatFills.length}">${
  formatFills.map((fillId) => `<xf numFmtId="0" fillId="${fillId}" applyFill="1"/>`).join('')
}</cellXfs></styleSheet>`;

/** `cells` maps a column letter to [styleIndex, value]; a value of null writes an empty cell. */
const sheetXml = (rows: Record<number, Record<string, [number, string | null]>>) => `<?xml version="1.0"?>
<worksheet><sheetData>${
  Object.entries(rows).map(([row, cells]) => `<row r="${row}">${
    Object.entries(cells).map(([col, [style, value]]) =>
      `<c r="${col}${row}" s="${style}" t="inlineStr">${value === null ? '' : `<is><t>${value}</t></is>`}</c>`).join('')
  }</row>`).join('')
}</sheetData></worksheet>`;

type Sheets = Record<string, Record<number, Record<string, [number, string | null]>>>;

const workbook = (sheets: Sheets, styleXml: string): Uint8Array => {
  const names = Object.keys(sheets);
  return zipSync({
    'xl/styles.xml': strToU8(styleXml),
    'xl/workbook.xml': strToU8(`<workbook><sheets>${
      names.map((name, i) => `<sheet state="visible" name="${name.replace(/&/g, '&amp;')}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
    }</sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<Relationships>${
      names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="…/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
    }</Relationships>`),
    ...Object.fromEntries(names.map((name, i) => [`xl/worksheets/sheet${i + 1}.xml`, strToU8(sheetXml(sheets[name] ?? {}))])),
  });
};

// Format 0 is plain, format 1 is the template's tint.
const TINTED = styles([OTHER_FILL, EXAMPLE_FILL], [0, 1]);

describe('the rows the template shaded as its own (MIG-003)', () => {
  it('MIG-003: a shaded row is reported by the number the spreadsheet shows', () => {
    const file = workbook({ '6. Stores': {
      4: { A: [0, 'Store name'] },
      5: { A: [1, 'Demo Store'], B: [1, 'Demo Owner'] },
      6: { A: [0, 'A real store'] },
    } }, TINTED);
    expect([...(exampleRows(file).get('6. Stores') ?? [])]).toEqual([5]);
  });

  it('a sheet with nothing shaded is absent, so "no examples" reads differently from "no formatting"', () => {
    const plain = workbook({ '1. Categories': { 5: { A: [0, 'Seeds'] } } }, TINTED);
    expect(exampleRows(plain).has('1. Categories')).toBe(false);

    // A workbook saved by a tool that drops fills: nothing is claimed at all.
    const unstyled = workbook({ '1. Categories': { 5: { A: [0, 'Seeds'] } } }, styles([OTHER_FILL], [0]));
    expect(exampleRows(unstyled).size).toBe(0);
  });

  it('an empty cell left tinted does not make the row an example', () => {
    // The template shades a whole block; trailing cells of a real row can inherit it.
    const file = workbook({ '4. SKUs & Prices': {
      5: { A: [0, 'OKRA-PK-1KG'], H: [1, null] },
      6: { A: [1, 'SHADE-50-3X50'] },
    } }, TINTED);
    expect([...(exampleRows(file).get('4. SKUs & Prices') ?? [])]).toEqual([6]);
  });

  it('a sheet name carrying an ampersand is matched as the workbook spells it', () => {
    const file = workbook({ '4. SKUs & Prices': { 5: { A: [1, 'SHADE-50-3X50'] } } }, TINTED);
    expect([...exampleRows(file).keys()]).toEqual(['4. SKUs & Prices']);
  });

  it('a file that is not a workbook fails loudly rather than reporting no examples', () => {
    expect(() => exampleRows(zipSync({ 'hello.txt': strToU8('not a workbook') })))
      .toThrow(/no xl\/styles\.xml/);
  });
});
