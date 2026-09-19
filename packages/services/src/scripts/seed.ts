import { effectivePermissions, presetOverrides, PRESET_DEFAULTS, type Role, type UserId } from '@gsa/core';
import { schema } from '@gsa/db';
import { eq } from 'drizzle-orm';
import { hashPassword } from '../identity';
import { loadSampleCatalogue, syncReferenceData } from '../reference-data';
import { closeDb, defaultBranchId, getDb } from '../runtime';

// Development accounts only (DEVELOPMENT §7). Never production; never UI-v1's demo credentials (ADR-0014).
if (process.env.NODE_ENV === 'production') throw new Error('Refusing to seed a production database');
const password = process.env.DEV_SEED_PASSWORD ?? '';
if (password.length < 10) throw new Error('Set DEV_SEED_PASSWORD (10+ characters) in .env first');
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
if (!grantorId) throw new Error('no Super Admin seeded');
const sample = await loadSampleCatalogue({
  user: { id: grantorId as UserId, role: 'SUPER_ADMIN' }, permissions: effectivePermissions('SUPER_ADMIN', new Map()),
  now: new Date(), requestId: 'dev-seed', locale: 'en', branchId, ip: null,
}, { withProducts: true });
console.log(sample.loaded ? 'created  sample catalogue' : 'exists   sample catalogue');
await closeDb();
