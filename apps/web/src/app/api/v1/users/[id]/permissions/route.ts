import { DomainError, isPermissionCode } from '@gsa/core';
import { identity as contract } from '@gsa/contracts';
import { identity } from '@gsa/services';
import { mutation } from '@/server/route';

export const PATCH = mutation<typeof contract.ChangePermissionsRequest, { id: string }>(contract.ChangePermissionsRequest, async ({ ctx, params, input }) => {
  const changes = input.changes.map(({ permission, granted }) => {
    if (!isPermissionCode(permission)) throw new DomainError('NOT_FOUND', { entity: 'permission', code: permission });
    return { permission, granted };
  });
  return { status: 200, body: await identity.changeAccountPermissions(ctx, params.id, changes) };
});
