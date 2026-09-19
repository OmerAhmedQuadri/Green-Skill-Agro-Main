import { dispatch, identity } from '@gsa/services';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Card } from '@gsa/ui';
import { requireSession } from '@/server/session';

export default async function DashboardPage() {
  const ctx = await requireSession();
  const me = await identity.getMe(ctx);
  const [t, tRoles] = await Promise.all([getTranslations('dashboard'), getTranslations('roles')]);
  // DSP-014: released orders nobody has confirmed within the configured days.
  const unconfirmed = ctx.permissions.has('sales.fulfil_dispatch') ? (await dispatch.listDispatchOrders(ctx, { unconfirmed: true, limit: 200 })).items.length : null;
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <h1 className="text-2xl font-semibold">{t('welcome', { name: me.name })}</h1>
      <Card className="p-5 text-sm text-stone-600">
        <p>{t('signedInAs', { role: tRoles(me.role) })}</p>
        <p className="mt-1">{t('permissionCount', { count: me.permissions.length })}</p>
      </Card>
      {unconfirmed !== null && unconfirmed > 0 ? (
        <Link href="/console/dispatch" className="block" data-testid="unconfirmed-dispatch">
          <Card className="border-amber-200 bg-amber-50 p-5 text-sm text-amber-900">{t('unconfirmedDispatch', { count: unconfirmed })}</Card>
        </Link>
      ) : null}
    </div>
  );
}
