'use client';

import { TEAM_STATUSES, type TeamStatus } from '@gsa/core';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Badge, cn } from '@gsa/ui';
import { Section } from '@/components/common/Section';
import { Cell, Table } from '@/components/common/Table';
import { useFormat } from '@/lib/format';
import type { TeamToday as Team } from './types';

/** Without the day to sort by, the first this many; the rest a tap away. */
const PREVIEW = 10;

const TONE = { WORKING: 'success', ON_BREAK: 'warning', AWAITING: 'warning', DONE: 'neutral', NOT_IN: 'neutral' } as const satisfies Record<TeamStatus, 'success' | 'warning' | 'neutral'>;

/**
 * RPT-013 (ADR-0054): every active seller's day so far — out working first —
 * with the columns the reader's permissions allow: the day itself, sales
 * today, cash in hand against the ceiling, and this month's revenue target.
 */
export function TeamToday({ data }: { data: Team }) {
  const t = useTranslations('dashboard.team');
  const format = useFormat();
  const { columns } = data;
  const [all, setAll] = useState(false);
  // Who is in today, and those not in a tap away — a team of any size stays a glance.
  const shown = all ? data.rows : columns.status ? data.rows.filter((r) => r.status !== 'NOT_IN') : data.rows.slice(0, PREVIEW);
  const more = data.rows.length - shown.length;
  const head = [
    t('seller'), ...(columns.status ? [t('today')] : []), ...(columns.sales ? [t('salesToday')] : []),
    ...(columns.cash ? [t('cash')] : []), ...(columns.target ? [t('target')] : []),
  ];
  return (
    <Section
      id="team-today" title={t('title')} description={t('hint')}
      actions={columns.status ? <Link href="/console/attendance" className="text-sm font-medium text-brand-800 hover:underline">{t('open')}</Link> : undefined}
    >
      {data.counts ? (
        <div className="flex flex-wrap gap-2 px-5 pt-4" data-testid="team-counts">
          {TEAM_STATUSES.map((s) => (
            <Badge key={s} tone={data.counts?.[s] ? TONE[s] : 'neutral'} className={cn(!data.counts?.[s] && 'opacity-60')} data-testid={`team-count-${s}`}>
              {t(`counts.${s}`, { count: data.counts?.[s] ?? 0 })}
            </Badge>
          ))}
        </div>
      ) : null}
      {data.rows.length === 0 ? <p className="p-5 text-sm text-stone-500">{t('noSellers')}</p> : (
        <div className="pt-3">
          {shown.length === 0 ? <p className="px-5 pb-3 text-sm text-stone-500" data-testid="nobody-in">{t('nobodyIn')}</p> : (
            <Table head={head}>
              {shown.map((r) => (
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
                  {columns.cash ? (
                    <Cell className="whitespace-nowrap">
                      {r.cash ? (
                        <>
                          <span className={cn(r.cash.over && 'font-semibold text-red-700')}>{format.money(r.cash.inHand)}</span>
                          {r.cash.ceiling ? <span className="block text-xs text-stone-500">{t('ofCeiling', { ceiling: format.money(r.cash.ceiling) })}</span> : null}
                          {r.cash.over ? <Badge tone="danger" className="mt-1">{t('overCeiling')}</Badge> : null}
                        </>
                      ) : null}
                    </Cell>
                  ) : null}
                  {columns.target ? (
                    <Cell className="min-w-36">
                      {r.target ? (
                        <div data-testid={`team-target-${r.seller.id}`}>
                          <div className="flex items-center gap-2">
                            <div className="h-2 flex-1 rounded-full bg-stone-100">
                              <div className={cn('h-2 rounded-full', r.target.behindPace ? 'bg-amber-500' : 'bg-brand-500')} style={{ width: `${Math.min(100, Number(r.target.achievement))}%` }} />
                            </div>
                            <span className="text-xs tabular-nums text-stone-700">{format.percent(r.target.achievement)}</span>
                          </div>
                          {r.target.behindPace ? <Badge tone="warning" className="mt-1">{t('behindPace')}</Badge> : null}
                        </div>
                      ) : <span className="text-xs text-stone-500">{t('noTarget')}</span>}
                    </Cell>
                  ) : null}
                </tr>
              ))}
            </Table>
          )}
          {more > 0 || all ? (
            <div className="border-t border-stone-100 px-5 py-3">
              <button type="button" className="text-sm font-medium text-brand-800 hover:underline" onClick={() => setAll((v) => !v)} data-testid="team-more">
                {all ? t('showFewer') : columns.status ? t('showNotIn', { count: more }) : t('showAll', { count: data.rows.length })}
              </button>
            </div>
          ) : null}
        </div>
      )}
    </Section>
  );
}
