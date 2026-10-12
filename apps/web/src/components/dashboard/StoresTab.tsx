'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Alert, Badge, cn } from '@gsa/ui';
import { Section } from '@/components/common/Section';
import { Cell, Table } from '@/components/common/Table';
import { Tile } from '@/components/common/Tile';
import { STATUS_TONE } from '@/components/stores/types';
import { useFormat } from '@/lib/format';
import { useErrorText } from '@/lib/hooks';
import { Freshness, tabQuery, useTabQuery, type DashboardFilter } from './shared';
import type { StoresTabData } from './types';

/** A tile that opens the store list where it says. */
function LinkTile({ href, testId, ...tile }: { href: string; label: string; value: string; hint: string; testId: string }) {
  return (
    <Link href={href} className="block rounded-lg outline-offset-2 hover:opacity-90" data-testid={`${testId}-link`}>
      <Tile {...tile} testId={testId} />
    </Link>
  );
}

/**
 * RPT-016 (ADR-0054): the stores — how many trade, wait for approval, have
 * stopped or are blocked; those that have bought nothing for the chosen days,
 * longest quiet first; and those onboarded in the period. One seller's, if
 * chosen.
 */
export function StoresTab({ filter }: { filter: DashboardFilter }) {
  const t = useTranslations('dashboard.stores');
  const ts = useTranslations('stores');
  const tl = useTranslations('analytics');
  const format = useFormat();
  const errorText = useErrorText();
  const view = useTabQuery<StoresTabData>('stores', tabQuery('stores', filter));
  const d = view.data;
  if (view.error) return <Alert>{errorText(view.error)}</Alert>;
  if (!d) return <p className="text-sm text-stone-500">{tl('loading')}</p>;

  return (
    <div className={cn('space-y-6 transition-opacity', view.isPlaceholderData && 'opacity-60')} data-testid="tab-stores">
      <Freshness query={view} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <LinkTile href="/console/stores?status=ACTIVE" label={t('active')} value={format.number(d.counts.active)} hint={t('activeHint')} testId="stores-active" />
        <LinkTile href="/console/stores?status=PENDING_APPROVAL" label={t('pending')} value={format.number(d.counts.pending)} hint={t('pendingHint')} testId="stores-pending" />
        <LinkTile href="/console/stores?status=INACTIVE" label={t('inactive')} value={format.number(d.counts.inactive)} hint={t('inactiveHint')} testId="stores-inactive" />
        <LinkTile href="/console/stores?blocked=true" label={t('blocked')} value={format.number(d.counts.blocked)} hint={t('blockedHint')} testId="stores-blocked" />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title={t('quietTitle', { days: d.quiet.days })} description={t('quietHint', { count: d.quiet.count })}>
          <div data-testid="stores-quiet">
            {d.quiet.stores.length === 0 ? <p className="p-5 text-sm text-stone-500">{t('noneQuiet')}</p> : (
              <Table head={[t('store'), t('lastSale'), t('quietFor')]}>
                {d.quiet.stores.map((q) => (
                  <tr key={q.store.id} data-testid={`quiet-${q.store.id}`}>
                    <Cell>
                      <Link href={`/console/stores/${q.store.id}`} className="font-medium text-brand-800 hover:underline">{q.store.name}</Link>
                      <span className="block text-xs text-stone-500"><bdi dir="ltr">{q.store.code}</bdi>{q.seller ? <span className="ms-2">{q.seller.name}</span> : null}</span>
                    </Cell>
                    <Cell className="whitespace-nowrap">{q.lastSale ? format.date(q.lastSale) : <span className="text-stone-500">{t('neverBought')}</span>}</Cell>
                    <Cell className="whitespace-nowrap">{q.days !== null ? <Badge tone={q.days >= 60 ? 'danger' : 'warning'}>{t('days', { count: q.days })}</Badge> : null}</Cell>
                  </tr>
                ))}
              </Table>
            )}
          </div>
        </Section>

        <Section title={t('newTitle')} description={t('newHint', { count: d.fresh.count, from: format.date(d.fresh.from), to: format.date(d.fresh.to) })}>
          <div data-testid="stores-new">
            {d.fresh.stores.length === 0 ? <p className="p-5 text-sm text-stone-500">{t('noneNew')}</p> : (
              <Table head={[t('store'), t('onboarded'), t('status')]}>
                {d.fresh.stores.map((s) => (
                  <tr key={s.store.id} data-testid={`new-${s.store.id}`}>
                    <Cell>
                      <Link href={`/console/stores/${s.store.id}`} className="font-medium text-brand-800 hover:underline">{s.store.name}</Link>
                      <span className="block text-xs text-stone-500"><bdi dir="ltr">{s.store.code}</bdi>{s.seller ? <span className="ms-2">{s.seller.name}</span> : null}</span>
                    </Cell>
                    <Cell className="whitespace-nowrap">{format.dateTime(s.createdAt)}</Cell>
                    <Cell className="whitespace-nowrap"><Badge tone={STATUS_TONE[s.status]}>{ts(`statuses.${s.status}`)}</Badge></Cell>
                  </tr>
                ))}
              </Table>
            )}
          </div>
        </Section>
      </div>
    </div>
  );
}
