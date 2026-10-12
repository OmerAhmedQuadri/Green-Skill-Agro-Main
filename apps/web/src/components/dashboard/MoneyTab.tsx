'use client';

import { AGEING_BANDS, dec } from '@gsa/core';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Alert, Badge, cn } from '@gsa/ui';
import { Section } from '@/components/common/Section';
import { Cell, Table } from '@/components/common/Table';
import { Tile } from '@/components/common/Tile';
import { BarList } from '@/components/reports/charts';
import { useFormat } from '@/lib/format';
import { useErrorText } from '@/lib/hooks';
import { Freshness, tabQuery, useTabQuery, type DashboardFilter } from './shared';
import type { MoneyTabData } from './types';

/**
 * RPT-014 (ADR-0054): the money — what stores owe and how late, the stores
 * most overdue, what was collected in the period and by whom, and the money
 * in motion: with sellers, in settlements waiting, in transfers nobody has
 * checked. One seller's or one store's, if chosen.
 */
export function MoneyTab({ filter }: { filter: DashboardFilter }) {
  const t = useTranslations('dashboard.owed');
  const ta = useTranslations('analytics');
  const format = useFormat();
  const errorText = useErrorText();
  const view = useTabQuery<MoneyTabData>('money', tabQuery('money', filter));
  const d = view.data;
  if (view.error) return <Alert>{errorText(view.error)}</Alert>;
  if (!d) return <p className="text-sm text-stone-500">{ta('loading')}</p>;
  const { owed, collected, motion } = d;
  const share = owed && dec(owed.aged.total).gt(0) ? dec(owed.overdue).div(dec(owed.aged.total)).times(100).toFixed(0) : null;

  return (
    <div className={cn('space-y-6 transition-opacity', view.isPlaceholderData && 'opacity-60')} data-testid="tab-money">
      <Freshness query={view} />
      {owed && collected ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Tile lead label={t('owed')} value={format.money(owed.aged.total)} hint={t('owing', { count: owed.owing })} testId="owed-total" />
          <Tile label={t('overdue')} value={format.money(owed.overdue)} testId="owed-overdue"
            hint={share !== null ? <span className={cn(dec(owed.overdue).gt(0) && 'text-red-700')}>{t('overdueShare', { percent: format.percent(share) })}</span> : undefined} />
          <Tile label={t('collectedIn', { from: format.date(collected.from), to: format.date(collected.to) })} value={format.money(collected.total)} testId="owed-collected"
            hint={t('collectedSplit', { cash: format.money(collected.cash), bank: format.money(collected.bank) })} />
          <Link href="/console/stores?blocked=true" className="block rounded-lg outline-offset-2 hover:opacity-90" data-testid="owed-blocked-link">
            <Tile label={t('blocked')} value={format.number(owed.blocked)} hint={t('blockedHint')} testId="owed-blocked" />
          </Link>
        </div>
      ) : null}

      {motion ? (
        <Section title={t('motionTitle')} description={t('motionHint')}>
          <div className="grid gap-3 p-5 sm:grid-cols-3" data-testid="money-motion">
            <Link href="/console/cash" className="block rounded-lg outline-offset-2 hover:opacity-90">
              <Tile label={t('withSellers')} value={format.money(motion.withSellers.amount)} testId="motion-sellers"
                hint={motion.withSellers.over > 0
                  ? <span className="text-red-700">{t('withSellersOver', { sellers: motion.withSellers.sellers, over: motion.withSellers.over })}</span>
                  : t('withSellersHint', { sellers: motion.withSellers.sellers })} />
            </Link>
            <Link href="/console/cash" className="block rounded-lg outline-offset-2 hover:opacity-90">
              <Tile label={t('settlements')} value={format.money(motion.settlements.amount)} hint={t('waitingCount', { count: motion.settlements.count })} testId="motion-settlements" />
            </Link>
            {motion.transfers ? (
              <Link href="/console/cash#transfers" className="block rounded-lg outline-offset-2 hover:opacity-90">
                <Tile label={t('transfers')} value={format.money(motion.transfers.amount)} hint={t('waitingCount', { count: motion.transfers.count })} testId="motion-transfers" />
              </Link>
            ) : null}
          </div>
        </Section>
      ) : null}

      {owed ? (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <Section title={t('ageing')}
            actions={<Link href={`/console/reports/sales?${tabQuery('money', filter)}#collections`} className="text-sm font-medium text-brand-800 hover:underline">{t('open')}</Link>}>
            <div className="p-5">
              <BarList testId="owed-ageing" rows={AGEING_BANDS.map((b) => ({ key: b, label: ta(`collections.bands.${b}`), value: owed.aged[b], display: format.money(owed.aged[b]) }))} />
            </div>
          </Section>
          <Section title={t('mostOverdue')}>
            <div data-testid="owed-most">
              {owed.mostOverdue.length === 0 ? <p className="p-5 text-sm text-stone-500" data-testid="nothing-overdue">{t('nothingOverdue')}</p> : (
                <Table head={[t('store'), t('overdue'), t('latest')]}>
                  {owed.mostOverdue.map((r) => (
                    <tr key={r.store.id} data-testid={`overdue-${r.store.id}`}>
                      <Cell>
                        <Link href={`/console/stores/${r.store.id}`} className="font-medium text-brand-800 hover:underline">{r.store.name}</Link>
                        {r.seller ? <span className="block text-xs text-stone-500">{r.seller.name}</span> : null}
                      </Cell>
                      <Cell className="whitespace-nowrap">
                        <span className="font-semibold text-red-700">{format.money(r.overdue)}</span>
                        <span className="block text-xs text-stone-500">{t('ofTotal', { total: format.money(r.total) })}</span>
                      </Cell>
                      <Cell><Badge tone={r.worst === 'DAYS_1_30' ? 'warning' : 'danger'}>{ta(`collections.bands.${r.worst}`)}</Badge></Cell>
                    </tr>
                  ))}
                </Table>
              )}
            </div>
          </Section>
        </div>
      ) : null}

      {collected ? (
        <Section title={t('bySeller')}>
          <div className="p-5">
            {collected.bySeller.length === 0 ? <p className="text-sm text-stone-500">{ta('collections.nothingCollected')}</p> : (
              <BarList testId="collected-by-seller" rows={collected.bySeller.map((r) => ({ key: r.seller.id, label: r.seller.name, value: r.total, display: format.money(r.total) }))} />
            )}
          </div>
        </Section>
      ) : null}
    </div>
  );
}
