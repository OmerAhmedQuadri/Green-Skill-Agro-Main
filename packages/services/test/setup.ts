import { afterAll, beforeEach } from 'vitest';
import { closeDb, setBlobStore } from '../src/runtime';
import { blobs } from './blobs';
import { closeOwner, resetDatabase } from './db';

setBlobStore(blobs); // automated tests never touch R2 (TESTING §3)

beforeEach(async () => { await resetDatabase(); blobs.clear(); });
afterAll(async () => { await closeDb(); await closeOwner(); });
