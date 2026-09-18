import { createMemoryMailer } from '../src/notifications';

/** Every email sent during integration tests lands here (TESTING §3). */
export const mailer = createMemoryMailer();
