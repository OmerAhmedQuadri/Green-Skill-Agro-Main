import { identity } from '@gsa/services';
import { getTranslations } from 'next-intl/server';
import { Card } from '@gsa/ui';
import { requireSession } from '@/server/session';

export default async function DashboardPage() {
  const ctx = await requireSession();
  const me = await identity.getMe(ctx);
  const [t, tRoles] = await Promise.all([getTranslations('dashboard'), getTranslations('roles')]);
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <h1 className="text-2xl font-semibold">{t('welcome', { name: me.name })}</h1>
      <Card className="p-5 text-sm text-stone-600">
        <p>{t('signedInAs', { role: tRoles(me.role) })}</p>
        <p className="mt-1">{t('permissionCount', { count: me.permissions.length })}</p>
      </Card>
    </div>
  );
}
