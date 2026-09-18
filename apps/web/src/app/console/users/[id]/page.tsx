import { notFound } from 'next/navigation';
import { AccountView } from '@/components/users/AccountView';
import { canAdministerUsers } from '@/lib/navigation';
import { requireSession } from '@/server/session';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireSession();
  if (!canAdministerUsers(ctx.permissions)) notFound();
  const { id } = await params;
  return (
    <AccountView id={id} actorId={ctx.user.id} actorPermissions={[...ctx.permissions]}
      canManagePermissions={ctx.permissions.has('users.manage_permissions')} />
  );
}
