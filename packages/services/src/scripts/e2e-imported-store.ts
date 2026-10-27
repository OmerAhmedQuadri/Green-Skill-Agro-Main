import { effectivePermissions, type BranchId, type UserId } from '@gsa/core';
import { schema } from '@gsa/db';
import { eq } from 'drizzle-orm';
import type { Ctx } from '../context';
import { loadOverrides } from '../identity';
import { openImportBatch, recordImportedPayment, recordImportedSale, recordImportedStore } from '../migration';
import { inTx } from '../platform';
import { closeDb, getDb } from '../runtime';

// For the end-to-end tests (M13, IMP-008, IMP-009): a store imported from synthetic books — two invoices, a payment and
// a warning — for a seller to re-verify, as the history import (step h) will make them. Development and CI only (ADR-0058).
// Usage: pnpm --filter @gsa/services run --silent e2e-imported-store <seller email> <store name>
if (process.env.NODE_ENV === 'production' || process.env.APP_INSTANCE === 'production') throw new Error('Refusing to fake imported books on a production database');

const [sellerEmail, name] = process.argv.slice(2);
if (!sellerEmail || !name) throw new Error('usage: e2e-imported-store <seller email> <store name>');

const db = getDb();
const account = async (email: string) => {
  const [row] = await db.select({ id: schema.users.id, role: schema.users.role, branchId: schema.users.branchId }).from(schema.users)
    .where(eq(schema.users.email, email.toLowerCase()));
  if (!row) throw new Error(`no account ${email} — run pnpm db:seed`);
  return row;
};
const operator = await account('superadmin@dev.local');
const seller = await account(sellerEmail);
const ctx: Ctx = {
  user: { id: operator.id as UserId, role: operator.role },
  permissions: effectivePermissions(operator.role, await loadOverrides(db, operator.id as UserId)),
  now: new Date(), requestId: 'e2e-imported-store', locale: 'en', branchId: operator.branchId as BranchId, ip: null,
};
const stamp = Date.now().toString(36);
const store = await inTx(ctx, async (tx) => {
  const batch = await openImportBatch(tx, ctx, { files: [{ name: `e2e books ${stamp}.xlsx`, sha256: 'e'.repeat(64), bytes: 1 }] });
  const imported = await recordImportedStore(tx, ctx, batch.id, { name, sellerId: seller.id });
  const written = { storeId: imported.id, sellerId: seller.id, book: 'E2E Invoices.xlsx', storeNameWritten: name };
  await recordImportedSale(tx, ctx, batch.id, { ...written, soldOn: '2026-09-10', bookRow: 2, serial: 501,
    lines: [{ item: 'Okra', packs: '10', unitPrice: '50.00', amount: '500.00' }] });
  await recordImportedSale(tx, ctx, batch.id, { ...written, soldOn: '2026-10-05', bookRow: 3, serial: 502,
    lines: [{ item: 'Okra', packs: '4', unitPrice: '50.00', amount: '200.00' }] });
  await recordImportedPayment(tx, ctx, batch.id, { ...written, book: 'E2E Vouchers.xlsx', bookRow: 2, paidOn: '2026-09-20', amount: '300.00',
    kind: 'VOUCHER', method: 'CASH', voucherNumber: `E2E-${stamp}` });
  // IMP-009: one thing the import could not settle, for the Super Admin.
  await tx.insert(schema.importWarnings).values({
    batchId: batch.id, kind: 'RETURN_NOT_IMPORTED', storeId: imported.id, params: { amount: '120.00', date: '2026-09-15' },
    branchId: ctx.branchId, createdBy: ctx.user.id,
  });
  return imported;
});
console.log(JSON.stringify({ storeId: store.id, code: store.code, balance: '400.00' }));
await closeDb();
