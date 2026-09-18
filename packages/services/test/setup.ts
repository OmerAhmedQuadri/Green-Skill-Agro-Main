import { afterAll, beforeEach } from 'vitest';
import { closeDb } from '../src/runtime';
import { closeOwner, resetDatabase } from './db';

beforeEach(async () => { await resetDatabase(); });
afterAll(async () => { await closeDb(); await closeOwner(); });
