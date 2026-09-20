import { describe, expect, it } from 'vitest';
import { columnOf, HEADER_ROW, shapeOutliers, sheetRows, templateExamples, tidySkuCode, valueAt, type Sheet } from './workbook';

/**
 * Synthetic throughout: shaped like Green Agro's workbook, with none of its
 * contents. Client data never enters the repo, tests included (CLIENT-DATA.md).
 */
const titleBlock = [[null], ['Sheet title'], ['Fill the rows beneath'], []];

const aSheet = (headers: string[], rows: (string | number | null)[][]): Sheet => ({
  sheet: '6. Stores',
  // The template's title block occupies the first rows; headers land on row 4.
  data: [...titleBlock.slice(0, HEADER_ROW), headers, ...rows],
});

describe('reading the setup workbook (MIG-001, MIG-002)', () => {
  const headers = ['Store name', 'Owner name', 'Phone', 'Credit cycle', 'Credit limit (SAR)', 'Price list'];

  it('MIG-002: headers come from row 4, and data rows keep the numbers the spreadsheet shows', () => {
    const sheet = aSheet(headers, [['Alpha', null, null, null, null, null], ['Beta', 'Owner', null, null, null, null]]);
    const rows = sheetRows(sheet);
    expect(rows.headers[0]).toBe('Store name');
    // Row 4 is the header, so the first store is row 5 — what someone opening the file sees.
    expect(rows.rows.map((r) => r.row)).toEqual([5, 6]);
    expect(valueAt(rows.rows[0]?.cells ?? [], columnOf(rows.headers, 'Store name'))).toBe('Alpha');
  });

  it('a blank row between entries is skipped rather than read as an empty store', () => {
    const sheet = aSheet(headers, [['Alpha', null, null, null, null, null], [null, null, null, null, null, null], ['Beta', null, null, null, null, null]]);
    expect(sheetRows(sheet).rows.map((r) => r.row)).toEqual([5, 7]);
  });

  it('a moved or renamed column is an error, not a silent shift of the data', () => {
    const rows = sheetRows(aSheet(headers, [['Alpha', null, null, null, null, null]]));
    expect(() => columnOf(rows.headers, 'Credit cycle')).not.toThrow();
    expect(() => columnOf(rows.headers, 'VAT number')).toThrow(/no "VAT number" column/);
  });

  it('MIG-005: the template\'s demonstration row is the one carrying terms no real row has', () => {
    // Green Agro sent names and little else; the template's own row is complete.
    const real = Array.from({ length: 12 }, (_, i) => [`Store ${i}`, null, null, null, null, null]);
    const example = ['Demo Store', 'Demo Owner', '0500000000', 'WEEKLY', '5000', 'Base'];
    const rows = sheetRows(aSheet(headers, [example, ...real]));
    const examples = templateExamples(rows, ['Credit cycle', 'Credit limit', 'Price list']);
    expect([...examples]).toEqual([5]);
  });

  it('a properly filled sheet has no examples — most rows looking complete means the sheet is done', () => {
    const complete = Array.from({ length: 12 }, (_, i) => [`Store ${i}`, 'Owner', '0500000000', 'WEEKLY', '5000', 'Base']);
    const rows = sheetRows(aSheet(headers, complete));
    expect(templateExamples(rows, ['Credit cycle', 'Credit limit', 'Price list']).size).toBe(0);
  });

  it('MIG-003: a row of an unusual shape is reported for confirmation, never dropped by itself', () => {
    // A real row with a note filled in looks exactly like a template example
    // with a note, so this only ever raises a question.
    const usual = Array.from({ length: 8 }, (_, i) => [`Store ${i}`, 'Owner', null, null, null, null]);
    const odd = ['Store 9', 'Owner', '0500000000', null, null, null];
    const outliers = shapeOutliers(sheetRows(aSheet(headers, [...usual, odd])));
    expect(outliers).toEqual([{ row: 13, filled: 3, usual: 2 }]);
  });

  it('a sheet too small to have a usual shape reports nothing rather than guessing', () => {
    expect(shapeOutliers(sheetRows(aSheet(headers, [['Alpha', 'Owner', '1', 'WEEKLY', '5000', 'Base']])))).toEqual([]);
  });

  it('CLIENT-DATA: a stray space in a SKU code goes; the rest is Green Agro\'s to spell', () => {
    expect(tidySkuCode('RED -CB-50G')).toBe('RED-CB-50G');
    expect(tidySkuCode('EGG -BE-50G')).toBe('EGG-BE-50G');
    // Inconsistent variety letters and a long prefix are theirs, and stay.
    expect(tidySkuCode('CHILLI-PB-50G')).toBe('CHILLI-PB-50G');
  });
});
