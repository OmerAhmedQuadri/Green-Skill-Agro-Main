import { manageableRoles } from '@gsa/core';
import { notFound } from 'next/navigation';
import { UsersPage } from '@/components/users/UsersPage';
import { canAdministerUsers } from '@/lib/navigation';
import { requireSession } from '@/server/session';

export default async function Page() {
  const ctx = await requireSession();
  if (!canAdministerUsers(ctx.permissions)) notFound(); // USR-008: absent, not forbidden
  return <UsersPage roles={[...manageableRoles(ctx.permissions)]} />;
}
