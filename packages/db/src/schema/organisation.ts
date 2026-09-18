import { boolean, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { newId } from '../ids';

/**
 * Phase 1 runs one branch and one warehouse, but both exist as first-class
 * rows from the first migration so multi-branch is an addition, not a rebuild
 * (ADR-0004, NFR-007). Application logic must not filter by branch (USR-012).
 */
export const branches = pgTable('branches', {
  id: uuid('id').primaryKey().$defaultFn(newId),
  code: text('code').notNull().unique(),
  nameEn: text('name_en').notNull(),
  nameAr: text('name_ar').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const warehouses = pgTable(
  'warehouses',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    code: text('code').notNull().unique(),
    nameEn: text('name_en').notNull(),
    nameAr: text('name_ar').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('warehouses_branch_id_idx').on(t.branchId)],
);
