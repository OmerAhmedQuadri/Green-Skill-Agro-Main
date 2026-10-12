import { dashboardTabs } from '@gsa/core';
import { cash, dispatch, identity, notifications, vehicles } from '@gsa/services';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Card } from '@gsa/ui';
import { AutoRefresh } from '@/components/dashboard/AutoRefresh';
import { Dashboard } from '@/components/dashboard/Dashboard';
import { REFRESH_MS } from '@/components/dashboard/refresh';
import { WaitingForDecision } from '@/components/dashboard/WaitingForDecision';
import { canSeeAudits, canSeeCash } from '@/lib/navigation';
import { requireSession } from '@/server/session';

export default async function DashboardPage() {
  const ctx = await requireSession();
  const [me, t, tRoles, tCash] = await Promise.all([identity.getMe(ctx), getTranslations('dashboard'), getTranslations('roles'), getTranslations('cash')]);
  const [unconfirmed, flags, auditsDue, waiting] = await Promise.all([
    // DSP-014: released orders nobody has confirmed within the configured days.
    ctx.permissions.has('sales.fulfil_dispatch') ? dispatch.listDispatchOrders(ctx, { unconfirmed: true, limit: 200 }).then((r) => r.items.length) : null,
    // LIM-004: ceiling breaches stay here until they clear.
    canSeeCash(ctx.permissions) ? cash.listFlags(ctx) : [],
    // VEH-015: vehicles past the Admin's audit interval, or never counted.
    canSeeAudits(ctx.permissions) ? vehicles.overdueAudits(ctx) : [],
    // ADR-0051: what waits for a decision this reader can make — nothing for someone who decides nothing.
    notifications.waitingForDecision(ctx),
  ]);
  // RPT-012..016 (ADR-0054): the tabs this reader's permissions allow; each reads its own figures.
  const tabs = dashboardTabs(ctx.permissions);
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <h1 className="text-2xl font-semibold">{t('welcome', { name: me.name })}</h1>
      {waiting.length > 0 ? <WaitingForDecision queues={waiting} /> : null}
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
      {tabs.length > 0 ? <Dashboard tabs={tabs} /> : null}
      {/* Someone whose permissions give the dashboard nothing to show still sees who they are signed in as. */}
      {tabs.length === 0 && waiting.length === 0 ? (
        <Card className="p-5 text-sm text-stone-600" data-testid="signed-in-as">
          <p>{t('signedInAs', { role: tRoles(me.role) })}</p>
          <p className="mt-1">{t('permissionCount', { count: me.permissions.length })}</p>
        </Card>
      ) : null}
      <AutoRefresh everyMs={REFRESH_MS} />
    </div>
  );
}
