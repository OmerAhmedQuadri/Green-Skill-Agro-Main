import { createInterface } from 'node:readline/promises';

/**
 * The database a command is about to write to — host, port and name, never
 * the password — and, on the VPS, which copy of the app it belongs to
 * (ADR-0058). Staging and production both sit on 127.0.0.1, so there the
 * operator confirms by typing the copy's name; on a laptop, the host.
 */
export function databaseTarget(url = process.env.DATABASE_URL ?? '') {
  const parsed = new URL(url);
  const copy = process.env.APP_INSTANCE?.trim() || null;
  return {
    database: parsed.pathname.replace(/^\//, ''),
    where: `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}${copy ? ` — ${copy.toUpperCase()}` : ''}`,
    answer: copy ?? parsed.hostname,
    prompt: copy ? `the copy's name (${copy})` : `the host name (${parsed.hostname})`,
  };
}

/** Asks the operator to type the target back; true only if they did. */
export async function confirmTarget(target: ReturnType<typeof databaseTarget>): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const typed = await rl.question(`Type ${target.prompt} to continue, anything else to stop: `);
  rl.close();
  return typed.trim() === target.answer;
}
