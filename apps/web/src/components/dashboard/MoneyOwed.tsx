'use client';

import { AGEING_BANDS, dec } from '@gsa/core';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Badge, cn } from '@gsa/ui';
import { Section } from '@/components/common/Section';
import { Cell, Table } from '@/components/common/Table';
import { Tile } from '@/components/common/Tile';
import { BarList } from '@/components/reports/charts';
import { useFormat } from '@/lib/format';
import type { MoneyOwed as Owed } from './types';

/**
 * RPT-014 (ADR-0054): what stores owe now — how much of it is late, and how
 * late — the stores most overdue, how many are blocked, and what came in this
 * month. The detail is RPT-008's collections view in the analytics.
 */
export function MoneyOwed({ data }: { data: Owed }) {
  const t = useTranslations('dashboard.owed');
  const ta = useTranslations('analytics.collections');
  const format = useFormat();
  const overdue = dec(data.overdue).gt(0);
  const share = dec(data.aged.total).gt(0) ? dec(data.overdue).div(dec(data.aged.total)).times(100).toFixed(0) : null;
  return (
    <Section
      id="money-owed" title={t('title')} description={t('hint')}
      actions={<Link href="/console/reports/sales#collections" className="text-sm font-medium text-brand-800 hover:underline">{t('open')}</Link>}
    >
      <div className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-4">
        <Tile lead label={t('owed')} value={format.money(data.aged.total)} hint={t('owing', { count: data.owing })} testId="owed-total" />
        <Tile
          label={t('overdue')} value={format.money(data.overdue)} testId="owed-overdue"
          hint={share !== null ? <span className={cn(overdue && 'text-red-700')}>{t('overdueShare', { percent: format.percent(share) })}</span> : undefined}
        />
        <Tile label={t('collected')} value={format.money(data.collected.total)} testId="owed-collected"
          hint={t('collectedSplit', { cash: format.money(data.collected.cash), bank: format.money(data.collected.bank) })} />
        <Link href="/console/stores?blocked=true" className="block rounded-lg outline-offset-2 hover:opacity-90" data-testid="owed-blocked-link">
          <Tile label={t('blocked')} value={format.number(data.blocked)} hint={t('blockedHint')} testId="owed-blocked" />
        </Link>
      </div>

      <div className="grid gap-6 border-t border-stone-200 p-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="min-w-0 space-y-3">
          <h3 className="text-sm font-semibold text-stone-900">{t('ageing')}</h3>
          <BarList testId="owed-ageing" rows={AGEING_BANDS.map((b) => ({ key: b, label: ta(`bands.${b}`), value: data.aged[b], display: format.money(data.aged[b]) }))} />
        </div>
        <div className="min-w-0 space-y-3">
          <h3 className="text-sm font-semibold text-stone-900">{t('mostOverdue')}</h3>
          {data.mostOverdue.length === 0 ? <p className="text-sm text-stone-500" data-testid="nothing-overdue">{t('nothingOverdue')}</p> : (
            <Table head={[t('store'), t('overdue'), t('latest')]}>
              {data.mostOverdue.map((r) => (
                <tr key={r.store.id} data-testid={`overdue-${r.store.id}`}>
                  <Cell>
                    <Link href={`/console/stores/${r.store.id}`} className="font-medium text-brand-800 hover:underline">{r.store.name}</Link>
                    {r.seller ? <span className="block text-xs text-stone-500">{r.seller.name}</span> : null}
                  </Cell>
                  <Cell className="whitespace-nowrap">
                    <span className="font-semibold text-red-700">{format.money(r.overdue)}</span>
                    <span className="block text-xs text-stone-500">{t('ofTotal', { total: format.money(r.total) })}</span>
                  </Cell>
                  <Cell><Badge tone={r.worst === 'DAYS_1_30' ? 'warning' : 'danger'}>{ta(`bands.${r.worst}`)}</Badge></Cell>
                </tr>
              ))}
            </Table>
          )}
        </div>
      </div>
    </Section>
  );
}
