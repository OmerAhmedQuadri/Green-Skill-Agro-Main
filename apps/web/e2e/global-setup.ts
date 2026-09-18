import { request, type FullConfig } from '@playwright/test';
import { PASSWORD, SESSIONS, sessionFile } from './helpers';

/**
 * Sign each shared account in once per run. Sign-in is rate limited per
 * account (SECURITY §1), so specs reuse these sessions instead of signing in
 * again; only specs about sign-in itself go through the form.
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL ?? 'http://localhost:3000';
  if (PASSWORD.length < 10) throw new Error('DEV_SEED_PASSWORD must be set');
  for (const account of SESSIONS) {
    const context = await request.newContext({ baseURL, extraHTTPHeaders: { origin: baseURL } });
    const response = await context.post('/api/v1/auth/sign-in', { data: { identifier: account, password: PASSWORD } });
    if (!response.ok()) throw new Error(`sign-in for ${account} failed: ${response.status()}`);
    await context.storageState({ path: sessionFile(account) });
    await context.dispose();
  }
}
