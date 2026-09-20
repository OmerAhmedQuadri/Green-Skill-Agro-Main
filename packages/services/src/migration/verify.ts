import type { LoadResult } from './load';

/**
 * What the import put into the system, for Green Agro to check against the
 * workbook (MIG-004).
 *
 * The cleansing report says what did not load and why. This says what did, and
 * asks for it to be verified — the two are meant to be read together, and
 * between them every row of the workbook is accounted for.
 *
 * Written to a file beside the workbook, never to stdout: the refusals name
 * products, vendors and registrations.
 */

export type VerificationInput = {
  readonly result: LoadResult;
  readonly workbook: string;
  readonly operator: string;
  readonly at: Date;
};

const LABELS: Record<keyof LoadResult['loaded'], string> = {
  categories: 'Categories', subCategories: 'Sub-categories', vendors: 'Vendors',
  products: 'Products', varieties: 'Varieties', skus: 'SKUs (priced on the base list)',
  users: 'User accounts', vehicles: 'Vehicles', assignments: 'Vehicles assigned to a seller',
};

export function verificationReport({ result, workbook, operator, at }: VerificationInput): string {
  const lines: string[] = [];
  lines.push('# What the import loaded');
  lines.push('');
  lines.push(`Workbook: ${workbook}`);
  lines.push(`Loaded: ${at.toISOString().slice(0, 16).replace('T', ' ')} UTC, by ${operator}`);
  lines.push('');
  lines.push('Read this with the cleansing report: that one lists what was left out,');
  lines.push('this one what went in. Every record below was created through the ordinary');
  lines.push('screens\' own rules, so each is validated and carries an audit entry naming');
  lines.push('the account above.');
  lines.push('');

  lines.push('## Counts to check against the workbook');
  lines.push('');
  lines.push('| | Loaded |');
  lines.push('| :--- | ---: |');
  for (const [key, label] of Object.entries(LABELS)) {
    lines.push(`| ${label} | ${result.loaded[key as keyof LoadResult['loaded']]} |`);
  }
  lines.push('');

  if (result.refused.length > 0) {
    lines.push(`## Rows the system refused (${result.refused.length})`);
    lines.push('');
    lines.push('These passed the first check but broke a rule the system enforces. Each one');
    lines.push('names the sheet and row, so it can be found and corrected in the workbook.');
    lines.push('');
    for (const { sheet, row, code, detail } of result.refused) {
      lines.push(`- **${sheet}**, row ${row} — \`${code}\` ${detail}`);
    }
    lines.push('');
  }

  lines.push('## Before anyone starts using it');
  lines.push('');
  lines.push('- Open the catalogue and check the counts above match what you sent us.');
  lines.push('- Check a handful of SKUs: the code, the pack size and the base price.');
  lines.push('- Stores are not here. Sellers add their own in the app, which captures the');
  lines.push('  location, the storefront and the credit terms a manager approves.');
  lines.push('- Opening stock is not here either. It arrives through a purchase order, which');
  lines.push('  is what creates batches with real lot numbers and expiry dates.');
  if (result.accounts.length > 0) {
    lines.push(`- ${result.accounts.length} accounts were created, each with a first password that must`);
    lines.push('  be changed at first sign-in. The passwords are in a separate file; hand them');
    lines.push('  over one to one, and delete the file afterwards.');
  }
  return `${lines.join('\n')}\n`;
}
