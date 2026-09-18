import { PERMISSION_CODES, type PermissionCode, type PermissionOverrides, type UserId } from '@gsa/core';
import { schema } from '@gsa/db';
import { eq } from 'drizzle-orm';
import type { Executor } from '../platform';

const known = new Set<string>(PERMISSION_CODES);
const isPermissionCode = (code: string): code is PermissionCode => known.has(code);

export async function loadOverrides(db: Executor, userId: UserId): Promise<PermissionOverrides> {
  const rows = await db
    .select({ permission: schema.userPermissions.permission, granted: schema.userPermissions.granted })
    .from(schema.userPermissions)
    .where(eq(schema.userPermissions.userId, userId));
  return new Map(rows.flatMap((r) => (isPermissionCode(r.permission) ? [[r.permission, r.granted] as const] : [])));
}
