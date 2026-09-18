import { hash, verify } from '@node-rs/argon2';

// argon2id (the library default) at OWASP's recommended cost (SECURITY §1).
const COST = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (password: string): Promise<string> => hash(password, COST);
export const verifyPassword = (passwordHash: string, password: string): Promise<boolean> => verify(passwordHash, password);

let dummy: Promise<string> | undefined;

/** Verified against when the account does not exist, so timing reveals nothing. */
export function timingEqualiserHash(): Promise<string> {
  dummy ??= hash('not-a-real-password-only-equalises-timing', COST);
  return dummy;
}
