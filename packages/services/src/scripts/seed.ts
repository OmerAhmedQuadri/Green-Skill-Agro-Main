import { effectivePermissions, presetOverrides, PRESET_DEFAULTS, type Role, type UserId } from '@gsa/core';
import { schema } from '@gsa/db';
import { eq } from 'drizzle-orm';
import { hashPassword } from '../identity';
import { loadSampleCatalogue, syncReferenceData } from '../reference-data';
import { setCeiling, setCommissionRate } from '../system';
import { setTarget } from '../targets';
import { closeDb, defaultBranchId, getDb } from '../runtime';

// Development accounts only (DEVELOPMENT §7). Never production; never UI-v1's demo credentials (ADR-0014).
if (process.env.NODE_ENV === 'production') throw new Error('Refusing to seed a production database');
const password = process.env.DEV_SEED_PASSWORD ?? '';
if (password.length < 10) throw new Error("Set DEV_SEED_PASSWORD (10+ characters) in .env first — in single quotes if it contains # (an unquoted # starts a comment)");
// SEED_RESET_PASSWORDS=1: existing development accounts take the current DEV_SEED_PASSWORD
// and are signed out everywhere — for rotating it (on staging too) after it was exposed.
const resetPasswords = process.env.SEED_RESET_PASSWORDS === '1';

type Seed = { role: Role; name: string; email: string; phone?: string; preset?: keyof typeof PRESET_DEFAULTS };
const ACCOUNTS: Seed[] = [
  { role: 'SUPER_ADMIN', name: 'Dev Super Admin', email: 'superadmin@dev.local' },
  { role: 'ADMIN', name: 'Dev Admin', email: 'admin@dev.local' },
  { role: 'MANAGER', name: 'Dev Operations Manager', email: 'manager@dev.local', preset: 'OPERATIONS_MANAGER' },
  { role: 'MANAGER', name: 'Dev Warehouse', email: 'warehouse@dev.local', preset: 'WAREHOUSE' },
  { role: 'SELLER', name: 'Dev Seller', email: 'seller@dev.local', phone: '+966500000004' },
  { role: 'SELLER', name: 'Dev Seller Two', email: 'seller2@dev.local', phone: '+966500000005' }, // VEH-009: a handover needs two
];

await syncReferenceData();
const db = getDb();
const branchId = await defaultBranchId();
const passwordHash = await hashPassword(password);
let grantorId: string | undefined;

for (const account of ACCOUNTS) {
  const [existing] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, account.email));
  const id = existing?.id ?? (await db.insert(schema.users).values({
    branchId, role: account.role, name: account.name, email: account.email, phone: account.phone ?? null,
    passwordHash, mustChangePassword: false,
  }).returning({ id: schema.users.id }))[0]?.id;
  if (!id) throw new Error(`could not seed ${account.email}`);
  if (existing && resetPasswords) {
    await db.update(schema.users).set({ passwordHash, mustChangePassword: false }).where(eq(schema.users.id, id));
    await db.delete(schema.sessions).where(eq(schema.sessions.userId, id)); // signed out everywhere
  }
  grantorId ??= id; // the Super Admin, seeded first
  if (account.preset && !existing) {
    for (const [permission, granted] of presetOverrides(PRESET_DEFAULTS[account.preset])) {
      await db.insert(schema.userPermissions).values({ userId: id, permission, granted, grantedBy: grantorId });
    }
  }
  console.log(`${existing ? (resetPasswords ? 'reset  ' : 'exists ') : 'created'}  ${account.role.padEnd(11)} ${account.email}`);
}
console.log('password: DEV_SEED_PASSWORD from .env');

// MIG-006: the synthetic sample catalogue, loaded as the Super Admin so it is validated and audited like any change.
// SEED_SAMPLE_CATALOGUE=0 leaves it out: a machine being prepared for the
// migration import needs the accounts but an empty catalogue (pnpm db:import).
if (!grantorId) throw new Error('no Super Admin seeded');
if (process.env.SEED_SAMPLE_CATALOGUE === '0') {
  console.log('skipped   sample catalogue (SEED_SAMPLE_CATALOGUE=0)');
  await closeDb();
  process.exit(0);
}
const superAdmin = {
  user: { id: grantorId as UserId, role: 'SUPER_ADMIN' as const }, permissions: effectivePermissions('SUPER_ADMIN', new Map()),
  now: new Date(), requestId: 'dev-seed', locale: 'en' as const, branchId, ip: null,
};

const sample = await loadSampleCatalogue(superAdmin, { withProducts: true });
console.log(sample.loaded ? 'created  sample catalogue' : 'exists   sample catalogue');

/**
 * TGT-001, COM-001, LIM-001: this month's goals, the commission rates and the
 * ceilings, so the targets and cash screens have something to show.
 *
 * Green Agro returned sheet 9 untouched and told us (2026-09-21) to choose for
 * now and settle it in production. These are the figures the template itself
 * suggested — ours, provisional, and development-only: this script refuses to
 * run against production at all, so nothing here becomes a real rate.
 */
const PROVISIONAL = { revenue: '60000.00', collected: '55000.00', newStores: 4, onTarget: '3', belowTarget: '1.5', cash: '15000.00', stock: '40000.00' };
const period = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7);

for (const account of ACCOUNTS.filter((a) => a.role === 'SELLER')) {
  const [seller] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, account.email));
  if (!seller) continue;
  await setTarget(superAdmin, {
    sellerId: seller.id, period,
    goals: { REVENUE: PROVISIONAL.revenue, COLLECTED: PROVISIONAL.collected, NEW_STORES: String(PROVISIONAL.newStores) },
    note: 'Provisional — Green Agro to set its own (sheet 9)',
  });
  await setCommissionRate(superAdmin, seller.id, { onTarget: PROVISIONAL.onTarget, belowTarget: PROVISIONAL.belowTarget });
}
// LIM-001: one ceiling for everyone, rather than a row per seller to maintain.
await setCeiling(superAdmin, { kind: 'CASH_IN_HAND', sellerId: null, amount: PROVISIONAL.cash });
await setCeiling(superAdmin, { kind: 'VEHICLE_STOCK_VALUE', sellerId: null, amount: PROVISIONAL.stock });
console.log(`created  provisional targets, commission rates and ceilings for ${period}`);

await closeDb();
