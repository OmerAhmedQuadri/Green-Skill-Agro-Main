import { presetOverrides, PRESET_DEFAULTS, type Role } from '@gsa/core';
import { schema } from '@gsa/db';
import { eq } from 'drizzle-orm';
import { hashPassword } from '../identity';
import { syncReferenceData } from '../reference-data';
import { closeDb, defaultBranchId, getDb } from '../runtime';

// Development accounts only (DEVELOPMENT §7). Never production; never UI-v1's demo credentials (ADR-0014).
if (process.env.NODE_ENV === 'production') throw new Error('Refusing to seed a production database');
const password = process.env.DEV_SEED_PASSWORD ?? '';
if (password.length < 10) throw new Error('Set DEV_SEED_PASSWORD (10+ characters) in .env first');

type Seed = { role: Role; name: string; email: string; phone?: string; preset?: keyof typeof PRESET_DEFAULTS };
const ACCOUNTS: Seed[] = [
  { role: 'SUPER_ADMIN', name: 'Dev Super Admin', email: 'superadmin@dev.local' },
  { role: 'ADMIN', name: 'Dev Admin', email: 'admin@dev.local' },
  { role: 'MANAGER', name: 'Dev Operations Manager', email: 'manager@dev.local', preset: 'OPERATIONS_MANAGER' },
  { role: 'MANAGER', name: 'Dev Warehouse', email: 'warehouse@dev.local', preset: 'WAREHOUSE' },
  { role: 'SELLER', name: 'Dev Seller', email: 'seller@dev.local', phone: '+966500000004' },
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
  grantorId ??= id; // the Super Admin, seeded first
  if (account.preset && !existing) {
    for (const [permission, granted] of presetOverrides(PRESET_DEFAULTS[account.preset])) {
      await db.insert(schema.userPermissions).values({ userId: id, permission, granted, grantedBy: grantorId });
    }
  }
  console.log(`${existing ? 'exists ' : 'created'}  ${account.role.padEnd(11)} ${account.email}`);
}
console.log('password: DEV_SEED_PASSWORD from .env');
await closeDb();
