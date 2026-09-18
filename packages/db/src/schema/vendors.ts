import { sql } from 'drizzle-orm';
import { boolean, check, pgTable, text } from 'drizzle-orm/pg-core';
import { id } from './columns';
import { mutable } from './mutable';

/** VEN-001: the vendor register. Created and edited by Admin and Super Admin (OQ-013). */
export const vendors = pgTable(
  'vendors',
  {
    id: id(),
    code: text('code').notNull().unique(), // VEN-004: products reference it
    name: text('name').notNull(),
    address: text('address'),
    contactPerson: text('contact_person'),
    phone: text('phone'),
    email: text('email'),
    country: text('country').notNull(), // ISO 3166-1 alpha-2
    isActive: boolean('is_active').notNull().default(true),
    ...mutable(),
  },
  (t) => [check('vendors_country_iso', sql`${t.country} ~ '^[A-Z]{2}$'`)],
);
