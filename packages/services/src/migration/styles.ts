import { unzipSync } from 'fflate';

/**
 * Which rows of the setup workbook are the template's own demonstration rows
 * (MIG-003).
 *
 * The template is ours, and it tints its examples beige. `read-excel-file`
 * reads values and drops formatting, so the assessment used to infer examples
 * from a row's shape — a guess, and one that was wrong about a SKU Green Skill Agro
 * had genuinely typed. The tint is a fact about a file we produced, so it is
 * read here instead.
 *
 * A .xlsx is a zip of XML. Only three things are needed from it: which fill is
 * the beige one, which cell formats use that fill, and which rows carry such a
 * cell. Everything else — values, types, dates — stays with `read-excel-file`.
 *
 * Caveat worth keeping in mind: Excel keeps a cell's fill when its value is
 * typed over, so beige means "sits in a row the template shaded", not "nobody
 * touched it". It is evidence, not proof, which is why every row dropped this
 * way is still reported for confirmation rather than silently discarded.
 */

/** The template's example tint. Changing it in the template changes it here. */
export const EXAMPLE_FILL = 'FFF6E0';

/** Sheet name as the workbook spells it, to the rows the template shaded. */
export type ExampleRows = ReadonlyMap<string, ReadonlySet<number>>;

const text = new TextDecoder();

const entry = (zip: Record<string, Uint8Array>, path: string): string => {
  const bytes = zip[path];
  if (!bytes) throw new Error(`the workbook has no ${path} — is it a .xlsx?`);
  return text.decode(bytes);
};

/** `<fill>…</fill>` in document order; the index is the fillId cell formats refer to. */
function beigeFills(styles: string): Set<number> {
  const fills = styles.match(/<fill>(?:(?!<\/fill>)[\s\S])*<\/fill>|<fill\s*\/>/g) ?? [];
  return new Set(fills.flatMap((fill, id) => (fill.includes(EXAMPLE_FILL) ? [id] : [])));
}

/** `<cellXfs>` in document order; the index is what a cell's `s=` attribute names. */
function beigeFormats(styles: string, fills: ReadonlySet<number>): Set<number> {
  const block = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? '';
  const formats = block.match(/<xf\b[^>]*\/>|<xf\b[^>]*>[\s\S]*?<\/xf>/g) ?? [];
  return new Set(formats.flatMap((xf, at) => {
    const fill = /fillId="(\d+)"/.exec(xf)?.[1];
    return fill !== undefined && fills.has(Number(fill)) ? [at] : [];
  }));
}

/** Sheet name to its part in the zip, by way of the workbook's relationships. */
function sheetPaths(workbook: string, rels: string): Map<string, string> {
  const targets = new Map(
    [...rels.matchAll(/Id="(rId\d+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1] ?? '', m[2] ?? '']),
  );
  const paths = new Map<string, string>();
  for (const [tag] of [...workbook.matchAll(/<sheet\b[^>]*>/g)].map((m) => [m[0]])) {
    const name = /name="([^"]+)"/.exec(tag ?? '')?.[1];
    const target = targets.get(/r:id="(rId\d+)"/.exec(tag ?? '')?.[1] ?? '');
    if (name && target?.includes('worksheets')) paths.set(unescapeXml(name), `xl/${target.replace(/^\/?xl\//, '')}`);
  }
  return paths;
}

const unescapeXml = (value: string): string => value
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** A row counts when a cell that actually holds a value is formatted with the tint. */
function shadedRows(sheet: string, formats: ReadonlySet<number>): Set<number> {
  const rows = new Set<number>();
  for (const [, number, body] of sheet.matchAll(/<row\b[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    for (const [cell] of (body ?? '').matchAll(/<c\b[^>]*>[\s\S]*?<\/c>/g)) {
      const style = /\bs="(\d+)"/.exec(cell)?.[1];
      if (style !== undefined && formats.has(Number(style)) && /<v>|<is>/.test(cell)) {
        rows.add(Number(number));
        break;
      }
    }
  }
  return rows;
}

/**
 * The template's example rows, sheet by sheet. Sheets with none are absent
 * rather than empty, so a caller can tell "this sheet has no examples" from
 * "this file carries no formatting at all".
 */
export function exampleRows(file: Uint8Array): ExampleRows {
  const zip = unzipSync(file);
  const styles = entry(zip, 'xl/styles.xml');
  const formats = beigeFormats(styles, beigeFills(styles));
  const found = new Map<string, ReadonlySet<number>>();
  if (formats.size === 0) return found;

  for (const [name, path] of sheetPaths(entry(zip, 'xl/workbook.xml'), entry(zip, 'xl/_rels/workbook.xml.rels'))) {
    const rows = shadedRows(entry(zip, path), formats);
    if (rows.size > 0) found.set(name, rows);
  }
  return found;
}
