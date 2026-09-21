import { z } from 'zod';

/** A key that applies to one machine is blank on the others; blank is not a value. */
const blankIsAbsent = (value: unknown) => (typeof value === 'string' && value.trim() === '' ? undefined : value);

/**
 * The one reading of environment variables (ARCHITECTURE §6.11). Processes
 * refuse to start on invalid configuration rather than failing later.
 */
const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.url(),
  DATABASE_OWNER_URL: z.url().optional(),
  APP_URL: z.url(),
  SESSION_SECRET: z.string().min(32),
  S3_ENDPOINT: z.url(),
  S3_REGION: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(8),
  /** Optional, e.g. `ci/`: keeps one bucket's users apart (CI shares the development bucket). */
  S3_KEY_PREFIX: z.string().regex(/^([a-z0-9-]+\/)?$/).default(''),
  /**
   * Backups (ADR-0020): their own bucket and their own bucket-scoped token.
   * The media token above is handed to browsers inside signed upload URLs, so
   * it must never be able to reach the backups. Set only on the machine that
   * takes them — blank everywhere else, because `.env` and `.env.example` are
   * kept line for line identical (CLAUDE.md).
   */
  BACKUP_S3_BUCKET: z.preprocess(blankIsAbsent, z.string().min(1).optional()),
  BACKUP_S3_ACCESS_KEY: z.preprocess(blankIsAbsent, z.string().min(1).optional()),
  BACKUP_S3_SECRET_KEY: z.preprocess(blankIsAbsent, z.string().min(8).optional()),
  BACKUP_RETENTION_DAYS: z.preprocess(blankIsAbsent, z.coerce.number().int().min(1).max(3650).default(30)),
  SMTP_URL: z.url(),
  MAIL_FROM: z.string().min(3),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Config = z.infer<typeof Env>;

let cached: Config | undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (cached) return cached;
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  }
  cached = parsed.data;
  return cached;
}
