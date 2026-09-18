import { v7 } from 'uuid';

/** Time-ordered UUIDv7 primary keys (DATA-MODEL §2). */
export const newId = (): string => v7();
