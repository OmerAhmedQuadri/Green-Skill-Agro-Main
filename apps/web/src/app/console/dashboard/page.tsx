import { cash, dispatch, identity, vehicles } from '@gsa/services';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Card } from '@gsa/ui';
import { canSeeAudits, canSeeCash } from '@/lib/navigation';
import { requireSession } from '@/server/session';

export default async function DashboardPage() {
  const ctx = await requireSession();
  const me = await identity.getMe(ctx);
  const [t, tRoles, tCash] = await Promise.all([getTranslations('dashboard'), getTranslations('roles'), getTranslations('cash')]);
  // DSP-014: released orders nobody has confirmed within the configured days.
  const unconfirmed = ctx.permissions.has('sales.fulfil_dispatch') ? (await dispatch.listDispatchOrders(ctx, { unconfirmed: true, limit: 200 })).items.length : null;
  // LIM-004: ceiling breaches stay here until they clear.
  const flags = canSeeCash(ctx.permissions) ? await cash.listFlags(ctx) : [];
  // VEH-015: vehicles past the Admin's audit interval, or never counted.
  const auditsDue = canSeeAudits(ctx.permissions) ? await vehicles.overdueAudits(ctx) : [];
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <h1 className="text-2xl font-semibold">{t('welcome', { name: me.name })}</h1>
      <Card className="p-5 text-sm text-stone-600">
        <p>{t('signedInAs', { role: tRoles(me.role) })}</p>
        <p className="mt-1">{t('permissionCount', { count: me.permissions.length })}</p>
      </Card>
      {auditsDue.length > 0 ? (
        <Link href="/console/audits" className="block" data-testid="audits-due">
          <Card className="border-amber-200 bg-amber-50 p-5 text-sm text-amber-900">{t('auditsDue', { count: auditsDue.length })}</Card>
        </Link>
      ) : null}
      {flags.map((f) => (
        <Link key={f.id} href="/console/cash" className="block" data-testid={`flag-${f.kind}`}>
          <Card className="border-red-200 bg-red-50 p-5 text-sm text-red-900">
            {t('ceilingBreached', { name: f.seller.name, kind: tCash(`over.${f.kind}`), amount: f.amount, ceiling: f.ceiling })}
          </Card>
        </Link>
      ))}
      {unconfirmed !== null && unconfirmed > 0 ? (
        <Link href="/console/dispatch" className="block" data-testid="unconfirmed-dispatch">
          <Card className="border-amber-200 bg-amber-50 p-5 text-sm text-amber-900">{t('unconfirmedDispatch', { count: unconfirmed })}</Card>
        </Link>
      ) : null}
    </div>
  );
}
