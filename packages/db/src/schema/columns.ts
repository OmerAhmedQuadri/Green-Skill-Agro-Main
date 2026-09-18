import { integer, timestamp, uuid } from 'drizzle-orm/pg-core';
import { newId } from '../ids';

/** Shared column builders (DATA-MODEL §2). */
export const id = () => uuid('id').primaryKey().$defaultFn(newId);
export const timestamptz = (name: string) => timestamp(name, { withTimezone: true });
export const createdAt = () => timestamptz('created_at').notNull().defaultNow();
/** Mutable entities carry a version for optimistic concurrency (STATE-MACHINES conventions). */
export const version = () => integer('version').notNull().default(1);
