import { uuid } from 'drizzle-orm/pg-core';
import { createdAt, timestamptz, version } from './columns';
import { users } from './identity';

/**
 * The columns every mutable entity carries (DATA-MODEL §2): who created and
 * last changed it, and a version for optimistic concurrency.
 */
export const mutable = () => ({
  createdAt: createdAt(),
  createdBy: uuid('created_by').references(() => users.id),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  updatedBy: uuid('updated_by').references(() => users.id),
  version: version(),
});
