import { describe, expect, it } from 'vitest';
import type { Assessed } from './assess';
import { cleansingReport } from './report';

const empty = { loadable: [], issues: [] };
const assessed = (over: Partial<Assessed> = {}): Assessed => ({
  categories: empty, vendors: empty, skus: empty, stores: empty, ...over,
} as Assessed);

const at = new Date('2026-09-20T10:00:00Z');
const workbook = 'GreenAgro-Phase1-Setup-Data.xlsx';

describe('the cleansing report (MIG-003, MIG-004)', () => {
  it('says plainly that nothing uncertain was loaded', () => {
    const report = cleansingReport({ assessed: assessed(), workbook, at });
    expect(report).toContain('Nothing uncertain has been loaded');
    expect(report).toContain('Nothing needs confirming');
  });

  it('counts what loaded against what was left, sheet by sheet', () => {
    const report = cleansingReport({
      assessed: assessed({
        skus: { loadable: [{}, {}, {}], issues: [] },
        stores: { loadable: [], issues: [{ sheet: '6. Stores', row: 0, kind: 'MISSING_REQUIRED_FIELD', detail: '76 stores have no terms' }] },
      } as unknown as Partial<Assessed>),
      workbook, at,
    });
    expect(report).toContain('| skus | 3 | 0 |');
    expect(report).toContain('| stores | 0 | 1 |');
  });

  it('puts what blocks the system before what is merely tidy', () => {
    const report = cleansingReport({
      assessed: assessed({
        skus: {
          loadable: [],
          issues: [
            { sheet: '4. SKUs', row: 9, kind: 'NEEDS_CONFIRMATION', detail: 'a stray space was removed' },
            { sheet: '4. SKUs', row: 5, kind: 'MISSING_REQUIRED_FIELD', detail: 'needs a price' },
          ],
        },
      } as unknown as Partial<Assessed>),
      workbook, at,
    });
    // A SKU nobody can sell comes before a code we tidied.
    expect(report.indexOf('Missing information')).toBeLessThan(report.indexOf('Changes made automatically'));
  });

  it('MIG-003: every entry says where to look and what to do about it', () => {
    const report = cleansingReport({
      assessed: assessed({
        skus: { loadable: [], issues: [{ sheet: '4. SKUs & Prices', row: 12, kind: 'CONFLICTING_VALUE', detail: 'the code and the pack size disagree' }] },
      } as unknown as Partial<Assessed>),
      workbook, at,
    });
    expect(report).toContain('**4. SKUs & Prices**, row 12 — the code and the pack size disagree');
    expect(report).toContain('Tell us which of the two is right. We have loaded neither.');
  });

  it('an issue about a whole sheet is not written as though it were one row', () => {
    const report = cleansingReport({
      assessed: assessed({
        stores: { loadable: [], issues: [{ sheet: '6. Stores', row: 0, kind: 'MISSING_REQUIRED_FIELD', detail: '76 stores have a name but no credit cycle' }] },
      } as unknown as Partial<Assessed>),
      workbook, at,
    });
    expect(report).toContain('**6. Stores** — 76 stores have a name but no credit cycle');
    expect(report).not.toContain('row 0');
  });

  it('names the workbook and the day, so a stale report is obvious', () => {
    const report = cleansingReport({ assessed: assessed(), workbook, at });
    expect(report).toContain(`Workbook: ${workbook}`);
    expect(report).toContain('Prepared: 2026-09-20');
  });
});
