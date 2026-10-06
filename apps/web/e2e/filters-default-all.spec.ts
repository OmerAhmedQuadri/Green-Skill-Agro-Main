import { expect, test } from '@playwright/test';
import ar from '../src/messages/ar.json' with { type: 'json' };
import en from '../src/messages/en.json' with { type: 'json' };
import { sessionPage } from './helpers';

/** Each list's status filter, and the value its "All" option carries. */
const LISTS = [
  ['/console/catalogue', ''],
  ['/console/dispatch', 'ALL'],
  ['/console/purchase-orders', 'ALL'],
  ['/console/sales', ''],
  ['/console/write-offs', ''],
  ['/console/closing-stock', ''],
] as const;

/**
 * A list opens on everything; narrowing it is the reader's choice — the
 * project lead's rule (2026-10-06). "All" comes first in every filter. A link
 * may still ask for a narrower view, as the closing-stock variance
 * notification does.
 */
for (const [locale, m] of [['en', en], ['ar', ar]] as const) {
  test(`Filters (${locale}): every list opens on All`, async ({ browser, baseURL }) => {
    const admin = await sessionPage(browser, 'admin@dev.local', locale, baseURL ?? '');
    for (const [path, all] of LISTS) {
      await admin.goto(path);
      const filter = admin.getByRole('combobox', { name: m.common.status, exact: true });
      await expect(filter, path).toHaveValue(all);
      await expect(filter.locator('option').first(), path).toHaveAttribute('value', all);
    }
    await admin.goto('/console/closing-stock?status=VARIANCE_FLAGGED');
    await expect(admin.getByRole('combobox', { name: m.common.status, exact: true })).toHaveValue('VARIANCE_FLAGGED');
  });
}
