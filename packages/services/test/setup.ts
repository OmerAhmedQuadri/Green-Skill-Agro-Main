import { afterAll, beforeEach } from 'vitest';
import { closeDb, setBlobStore, setMailer } from '../src/runtime';
import { blobs } from './blobs';
import { closeOwner, resetDatabase } from './db';
import { mailer } from './mailer';

// Automated tests never touch R2 or a real SMTP server (TESTING §3).
setBlobStore(blobs);
setMailer(mailer);

beforeEach(async () => { await resetDatabase(); blobs.clear(); mailer.clear(); });
afterAll(async () => { await closeDb(); await closeOwner(); });
