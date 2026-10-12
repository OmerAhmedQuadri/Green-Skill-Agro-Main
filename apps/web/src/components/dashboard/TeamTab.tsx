'use client';

import { TEAM_STATUSES, type TeamStatus } from '@gsa/core';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, Badge, cn } from '@gsa/ui';
import { Section } from '@/components/common/Section';
import { Cell, Table } from '@/components/common/Table';
import { Tile } from '@/components/common/Tile';
import { useFormat } from '@/lib/format';
import { useErrorText } from '@/lib/hooks';
import { Freshness, tabQuery, useTabQuery, type DashboardFilter } from './shared';
import type { TeamTabData } from './types';

const TONE = { WORKING: 'success', ON_BREAK: 'warning', AWAITING: 'warning', DONE: 'neutral', NOT_IN: 'neutral' } as const satisfies Record<TeamStatus, 'success' | 'warning' | 'neutral'>;

/** What a figure is against its ceiling, red past it (LIM-004). */
function Carried({ amount, ceiling, over }: { amount: string; ceiling: string | null; over: boolean }) {
  const t = useTranslations('dashboard.team');
  const format = useFormat();
  return (
    <>
      <span className={cn(over && 'font-semibold text-red-700')}>{format.money(amount)}</span>
      {ceiling ? <span className="block text-xs text-stone-500">{t('ofCeiling', { ceiling: format.money(ceiling) })}</span> : null}
      {over ? <Badge tone="danger" className="mt-1">{t('overCeiling')}</Badge> : null}
    </>
  );
}

/**
 * RPT-013 (ADR-0054): every active seller on a day — out working first —
 * with the columns the reader's permissions allow: the day, the sales, what
 * they carry (today only: it is a figure of now), and the month's target and
 * commission so far. A status picks who is listed; those not in are a tap away.
 */
export function TeamTab({ filter }: { filter: DashboardFilter }) {
  const t = useTranslations('dashboard.team');
  const tl = useTranslations('analytics');
  const format = useFormat();
  const errorText = useErrorText();
  const view = useTabQuery<TeamTabData>('team', tabQuery('team', filter));
  const [only, setOnly] = useState<TeamStatus | null>(null);
  const [all, setAll] = useState(false);
  const d = view.data;
  if (view.error) return <Alert>{errorText(view.error)}</Alert>;
  if (!d) return <p className="text-sm text-stone-500">{tl('loading')}</p>;

  const { columns } = d;
  const listed = only ? d.rows.filter((r) => r.status === only) : all || !columns.status ? d.rows : d.rows.filter((r) => r.status !== 'NOT_IN');
  const hidden = d.rows.length - listed.length;
  const head = [
    t('seller'), ...(columns.status ? [t('status')] : []), ...(columns.sales ? [t('sales')] : []),
    ...(columns.carrying ? [t('cash'), t('stock')] : []), ...(columns.target ? [t('target')] : []),
  ];
  return (
    <div className={cn('space-y-6 transition-opacity', view.isPlaceholderData && 'opacity-60')} data-testid="tab-team">
      <Freshness query={view} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {d.totals.sales !== null ? <Tile lead label={d.today ? t('salesTodayTotal') : t('salesOnDay', { day: format.date(d.date) })} value={format.money(d.totals.sales)} testId="team-sales" /> : null}
        {d.totals.cash !== null ? <Tile label={t('cashTotal')} value={format.money(d.totals.cash)} hint={t('now')} testId="team-cash" /> : null}
        {d.totals.stock !== null ? <Tile label={t('stockTotal')} value={format.money(d.totals.stock)} hint={t('now')} testId="team-stock" /> : null}
        {d.totals.commission ? (
          <Tile label={t('commission')} value={format.money(d.totals.commission.amount)} testId="team-commission"
            hint={d.totals.commission.final ? t('commissionFinal') : t('commissionSoFar')} />
        ) : null}
      </div>

      <Section title={d.today ? t('title') : t('titleOn', { day: format.date(d.date) })} description={t('hint')}
        actions={columns.status ? <Link href="/console/attendance" className="text-sm font-medium text-brand-800 hover:underline">{t('open')}</Link> : undefined}>
        {d.counts ? (
          <div className="flex flex-wrap gap-2 px-5 pt-4" data-testid="team-counts">
            {TEAM_STATUSES.map((s) => (
              <button key={s} type="button" onClick={() => setOnly((v) => (v === s ? null : s))} aria-pressed={only === s} data-testid={`team-count-${s}`}
                className={cn('rounded-full outline-offset-2', only === s && 'ring-2 ring-brand-500')}>
                <Badge tone={d.counts?.[s] ? TONE[s] : 'neutral'} className={cn(!d.counts?.[s] && 'opacity-60')}>{t(`counts.${s}`, { count: d.counts?.[s] ?? 0 })}</Badge>
              </button>
            ))}
          </div>
        ) : null}
        {d.rows.length === 0 ? <p className="p-5 text-sm text-stone-500">{t('noSellers')}</p> : (
          <div className="pt-3">
            {listed.length === 0 ? <p className="px-5 pb-3 text-sm text-stone-500" data-testid="nobody-in">{only ? t('nobodyThus') : t('nobodyIn')}</p> : (
              <Table head={head}>
                {listed.map((r) => (
                  <tr key={r.seller.id} data-testid={`team-${r.seller.id}`} className={cn(r.status === 'NOT_IN' && 'text-stone-500')}>
                    <Cell className="font-medium text-stone-900">
                      {r.seller.name}
                      {r.vehicle ? <bdi dir="ltr" className="block text-xs font-normal text-stone-500">{r.vehicle}</bdi> : null}
                    </Cell>
                    {columns.status ? (
                      <Cell>
                        {r.status ? <Badge tone={TONE[r.status]} data-testid={`team-status-${r.seller.id}`}>{t(`statuses.${r.status}`)}</Badge> : null}
                        {r.since ? <span className="block pt-1 text-xs text-stone-500">{t('since', { time: format.time(r.since) })}</span> : null}
                      </Cell>
                    ) : null}
                    {columns.sales ? (
                      <Cell className="whitespace-nowrap">
                        {r.sales ? <>{format.money(r.sales.net)}<span className="block text-xs text-stone-500">{t('salesCount', { count: r.sales.count })}</span></> : null}
                      </Cell>
                    ) : null}
                    {columns.carrying ? (
                      <>
                        <Cell className="whitespace-nowrap">{r.cash ? <Carried amount={r.cash.inHand} ceiling={r.cash.ceiling} over={r.cash.over} /> : null}</Cell>
                        <Cell className="whitespace-nowrap">{r.stock ? <Carried amount={r.stock.value} ceiling={r.stock.ceiling} over={r.stock.over} /> : null}</Cell>
                      </>
                    ) : null}
                    {columns.target ? (
                      <Cell className="min-w-40">
                        {r.target ? (
                          <div data-testid={`team-target-${r.seller.id}`}>
                            <div className="flex items-center gap-2">
                              <div className="h-2 flex-1 rounded-full bg-stone-100">
                                <div className={cn('h-2 rounded-full', r.target.behindPace ? 'bg-amber-500' : 'bg-brand-500')} style={{ width: `${Math.min(100, Number(r.target.achievement))}%` }} />
                              </div>
                              <span className="text-xs tabular-nums text-stone-700">{format.percent(r.target.achievement)}</span>
                            </div>
                            {r.target.commission ? <span className="block pt-1 text-xs text-stone-500">{t('commissionRow', { amount: format.money(r.target.commission) })}</span> : null}
                            {r.target.behindPace ? <Badge tone="warning" className="mt-1">{t('behindPace')}</Badge> : null}
                          </div>
                        ) : <span className="text-xs text-stone-500">{t('noTarget')}</span>}
                      </Cell>
                    ) : null}
                  </tr>
                ))}
              </Table>
            )}
            {!only && (hidden > 0 || all) ? (
              <div className="border-t border-stone-100 px-5 py-3">
                <button type="button" className="text-sm font-medium text-brand-800 hover:underline" onClick={() => setAll((v) => !v)} data-testid="team-more">
                  {all ? t('showFewer') : t('showNotIn', { count: hidden })}
                </button>
              </div>
            ) : null}
          </div>
        )}
      </Section>
    </div>
  );
}
