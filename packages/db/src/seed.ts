import { createDb } from './client';
import { branches, warehouses } from './schema';

// Sample data for development only (DEVELOPMENT §6). Never production.
if (process.env.NODE_ENV === 'production') {
  throw new Error('Refusing to seed a production database');
}
const url = process.env.DATABASE_OWNER_URL;
if (!url) throw new Error('DATABASE_OWNER_URL is required to seed');

const db = createDb(url);
await db.transaction(async (tx) => {
  const [branch] = await tx
    .insert(branches)
    .values({ code: 'HQ', nameEn: 'Riyadh Head Office', nameAr: 'المكتب الرئيسي - الرياض' })
    .onConflictDoUpdate({ target: branches.code, set: { code: 'HQ' } })
    .returning();
  if (!branch) throw new Error('branch seed failed');
  await tx
    .insert(warehouses)
    .values({
      branchId: branch.id,
      code: 'WH-01',
      nameEn: 'Riyadh Central Warehouse',
      nameAr: 'المستودع المركزي - الرياض',
    })
    .onConflictDoNothing({ target: warehouses.code });
});
await db.$client.end();
console.log('seed complete');
