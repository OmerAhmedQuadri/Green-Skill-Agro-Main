import {
  effectivePermissions, presetOverrides, PRESET_DEFAULTS, type PermissionOverrides, type Role, type UserId,
} from '@gsa/core';
import { schema } from '@gsa/db';
import type { Ctx } from '../src/context';
import { hashPassword } from '../src/identity';
import { defaultBranchId, getDb } from '../src/runtime';

export const PASSWORD = 'correct horse battery staple';
let n = 0;

export type TestAccount = { id: UserId; role: Role; email: string; phone: string | null; password: string };

/** An account inserted directly, bypassing the use cases under test. */
export async function anAccount(
  role: Role,
  opts: { phone?: string; status?: 'ACTIVE' | 'DEACTIVATED'; mustChangePassword?: boolean; preset?: keyof typeof PRESET_DEFAULTS } = {},
): Promise<TestAccount> {
  n += 1;
  const email = `${role.toLowerCase()}${n}@test.local`;
  const [row] = await getDb().insert(schema.users).values({
    branchId: await defaultBranchId(), role, name: `${role} ${n}`, email, phone: opts.phone ?? null,
    passwordHash: await hashPassword(PASSWORD), status: opts.status ?? 'ACTIVE',
    mustChangePassword: opts.mustChangePassword ?? false,
  }).returning({ id: schema.users.id });
  if (!row) throw new Error('factory insert failed');
  if (opts.preset) {
    for (const [permission, granted] of presetOverrides(PRESET_DEFAULTS[opts.preset])) {
      await getDb().insert(schema.userPermissions).values({ userId: row.id, permission, granted, grantedBy: row.id });
    }
  }
  return { id: row.id as UserId, role, email, phone: opts.phone ?? null, password: PASSWORD };
}

export async function ctxFor(
  account: Pick<TestAccount, 'id' | 'role'>,
  opts: { overrides?: PermissionOverrides; now?: Date } = {},
): Promise<Ctx> {
  return {
    user: { id: account.id, role: account.role },
    permissions: effectivePermissions(account.role, opts.overrides ?? new Map()),
    now: opts.now ?? new Date(),
    requestId: 'test-request',
    locale: 'en',
    branchId: (await defaultBranchId()),
    ip: '127.0.0.1',
  };
}

export const meta = (now = new Date()) => ({ ip: '127.0.0.1', userAgent: 'vitest', requestId: 'test-request', now });
