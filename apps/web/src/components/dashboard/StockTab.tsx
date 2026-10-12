'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { Alert, Badge, Card, cn } from '@gsa/ui';
import { Tile } from '@/components/common/Tile';
import { daysUntil, useFormat } from '@/lib/format';
import { useErrorText } from '@/lib/hooks';
import { Freshness, tabQuery, useTabQuery, type DashboardFilter } from './shared';
import type { StockTabData } from './types';

/** One kind of alert: its title and count, a link to the page that deals with it, and the first few. */
function Panel({ title, summary, href, open, testId, empty, children }: {
  title: string; summary: ReactNode; href: string; open: string; testId: string; empty: string | null; children: ReactNode;
}) {
  return (
    <Card className="flex min-w-0 flex-col p-4" data-testid={testId}>
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-sm font-semibold text-stone-900">{title}</h3>
        <Link href={href} className="shrink-0 text-sm font-medium text-brand-800 hover:underline">{open}</Link>
      </div>
      {/* With nothing in it, saying so once is enough. */}
      {empty ? <p className="mt-1 text-sm text-stone-500" data-testid={`${testId}-empty`}>{empty}</p> : (
        <>
          <div className="mt-1 text-sm text-stone-600" data-testid={`${testId}-summary`}>{summary}</div>
          <ul className="mt-3 divide-y divide-stone-100 text-sm">{children}</ul>
        </>
      )}
    </Card>
  );
}

/**
 * RPT-015 (ADR-0054): stock that needs someone — batches flagged for expiry,
 * what the forecast says to order, purchase orders on their way (narrowed to
 * a product or category, if chosen) — and where stock is: on each vehicle, and
 * in dispatch orders on the road.
 */
export function StockTab({ filter }: { filter: DashboardFilter }) {
  const t = useTranslations('dashboard.stock');
  const tl = useTranslations('analytics');
  const format = useFormat();
  const errorText = useErrorText();
  const view = useTabQuery<StockTabData>('stock', tabQuery('stock', filter));
  const d = view.data;
  if (view.error) return <Alert>{errorText(view.error)}</Alert>;
  if (!d) return <p className="text-sm text-stone-500">{tl('loading')}</p>;
  const { expiring, reorder, incoming, vehicles, dispatch } = d;
  const narrowed = Boolean(filter.categoryId || filter.productId);

  return (
    <div className={cn('space-y-6 transition-opacity', view.isPlaceholderData && 'opacity-60')} data-testid="tab-stock">
      <Freshness query={view} />
      {vehicles || dispatch ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {vehicles ? (
            <>
              <Tile lead label={t('onVehicles')} value={format.money(vehicles.value)} hint={t('onVehiclesHint', { vehicles: vehicles.loaded, packs: vehicles.packs })} testId="stock-on-vehicles" />
            </>
          ) : null}
          {dispatch ? (
            <>
              <Tile label={t('onTheRoad')} value={format.number(dispatch.onTheRoad)} hint={t('onTheRoadHint', { amount: format.money(dispatch.value) })} testId="stock-on-the-road" />
              <Tile label={t('unconfirmed')} value={format.number(dispatch.unconfirmed)} hint={t('unconfirmedHint')} testId="stock-unconfirmed" />
              <Tile label={t('requested')} value={format.number(dispatch.requested)} hint={t('requestedHint')} testId="stock-requested" />
            </>
          ) : null}
        </div>
      ) : null}
      {narrowed && (vehicles || dispatch) ? <p className="text-xs text-stone-500" data-testid="stock-whole">{t('wholeLoads')}</p> : null}

      <div className="grid items-start gap-4 lg:grid-cols-3">
        {expiring ? (
          <Panel
            testId="stock-expiring" title={t('expiring')} href="/console/expiry" open={t('openExpiry')}
            summary={t('expiringCount', { batches: expiring.batches, packs: expiring.packs })} empty={expiring.batches === 0 ? t('noneExpiring') : null}
          >
            {expiring.soonest.map((b) => (
              <li key={b.batchId} className="flex items-start justify-between gap-3 py-2">
                <div className="min-w-0">
                  <div className="truncate font-medium text-stone-900">{format.name(b.product)}</div>
                  <div className="text-xs text-stone-500"><bdi dir="ltr">{b.code}</bdi>{b.lotNumber ? <span className="ms-2">{t('lot', { lot: b.lotNumber })}</span> : null}</div>
                  <div className="flex flex-wrap gap-1 pt-1">
                    {b.prioritised ? <Badge tone="danger">{t('prioritised')}</Badge> : null}
                    {b.time ? null : <Badge tone="warning">{t('slowSelling')}</Badge>}
                  </div>
                </div>
                <div className="shrink-0 text-end">
                  <div className={cn('text-xs', b.daysLeft <= 30 ? 'font-semibold text-red-700' : 'text-stone-600')}>
                    {b.daysLeft < 0 ? t('expired') : t('expiresIn', { days: b.daysLeft })}
                  </div>
                  <div className="text-xs text-stone-500">{format.date(b.expiresOn)}</div>
                  <div className="text-xs text-stone-700">{t('packs', { count: b.heldPacks })}</div>
                </div>
              </li>
            ))}
          </Panel>
        ) : null}

        {reorder ? (
          <Panel
            testId="stock-reorder" title={t('reorder')} href="/console/reports/reorder" open={t('openReorder')}
            summary={t('reorderCount', { count: reorder.items })} empty={reorder.items === 0 ? t('noneToReorder') : null}
          >
            {reorder.top.map((r) => (
              <li key={r.skuId} className="flex items-start justify-between gap-3 py-2">
                <div className="min-w-0">
                  <div className="truncate font-medium text-stone-900">{format.name(r.product)}{r.variety ? ` ${format.name(r.variety)}` : ''}</div>
                  <div className="text-xs text-stone-500"><bdi dir="ltr">{r.code}</bdi></div>
                </div>
                <div className="shrink-0 text-end text-sm font-semibold text-stone-900">{t('packs', { count: r.suggested })}</div>
              </li>
            ))}
            {reorder.top.some((r) => r.guide) ? <li className="py-2 text-xs text-stone-500">{t('guide')}</li> : null}
          </Panel>
        ) : null}

        {incoming ? (
          <Panel
            testId="stock-incoming" title={t('incoming')} href="/console/incoming" open={t('openIncoming')}
            summary={(
              <>
                {t('incomingCount', { count: incoming.orders })}
                {incoming.late > 0 ? <Badge tone="danger" className="ms-2" data-testid="stock-incoming-late">{t('late', { count: incoming.late })}</Badge> : null}
              </>
            )}
            empty={incoming.orders === 0 ? t('noneIncoming') : null}
          >
            {incoming.next.map((o) => {
              const late = o.expectedArrival !== null && daysUntil(o.expectedArrival) < 0;
              return (
                <li key={o.poId} className="flex items-start justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <Link href={`/console/purchase-orders/${o.poId}`} className="font-medium text-brand-800 hover:underline"><bdi dir="ltr">{o.number}</bdi></Link>
                    <div className="text-xs text-stone-500"><bdi dir="ltr">{o.vendorCode}</bdi></div>
                  </div>
                  <div className="shrink-0 text-end">
                    <div className={cn('text-xs', late ? 'font-semibold text-red-700' : 'text-stone-600')}>
                      {o.expectedArrival ? t('expected', { date: format.date(o.expectedArrival) }) : t('noDate')}
                    </div>
                    <div className="text-xs text-stone-700">{t('packs', { count: o.packs })}</div>
                  </div>
                </li>
              );
            })}
          </Panel>
        ) : null}

        {vehicles ? (
          <Panel
            testId="stock-vehicles" title={t('vehicles')} href="/console/vehicles" open={t('openVehicles')}
            summary={t('vehiclesCount', { count: vehicles.loaded })} empty={vehicles.loaded === 0 ? t('noneOnVehicles') : null}
          >
            {vehicles.list.map((v) => (
              <li key={v.id} className="flex items-start justify-between gap-3 py-2" data-testid={`vehicle-${v.id}`}>
                <div className="min-w-0">
                  <Link href={`/console/vehicles/${v.id}`} className="font-medium text-brand-800 hover:underline"><bdi dir="ltr">{v.registration}</bdi></Link>
                  <div className="text-xs text-stone-500">{v.seller ? v.seller.name : t('unassigned')}</div>
                  {v.outstandingLoads > 0 ? <Badge tone="warning" className="mt-1">{t('loadsWaiting', { count: v.outstandingLoads })}</Badge> : null}
                </div>
                <div className="shrink-0 text-end">
                  <div className="text-sm font-semibold text-stone-900">{format.money(v.value)}</div>
                  <div className="text-xs text-stone-600">{t('packs', { count: v.packs })}</div>
                </div>
              </li>
            ))}
          </Panel>
        ) : null}

        {dispatch ? (
          <Panel
            testId="stock-dispatch" title={t('dispatch')} href="/console/dispatch" open={t('openDispatch')}
            summary={t('dispatchCount', { count: dispatch.onTheRoad })} empty={dispatch.onTheRoad === 0 ? t('noneOnTheRoad') : null}
          >
            {dispatch.oldest.map((o) => (
              <li key={o.id} className="flex items-start justify-between gap-3 py-2" data-testid={`dispatch-${o.id}`}>
                <div className="min-w-0">
                  <Link href={`/console/dispatch/${o.id}`} className="font-medium text-brand-800 hover:underline"><bdi dir="ltr">{o.number}</bdi></Link>
                  <div className="truncate text-xs text-stone-500">{o.store.name}</div>
                  {o.unconfirmed ? <Badge tone="danger" className="mt-1">{t('tooLong')}</Badge> : null}
                </div>
                <div className="shrink-0 text-end">
                  <div className="text-sm font-semibold text-stone-900">{format.money(o.total)}</div>
                  {o.releasedAt ? <div className="text-xs text-stone-600">{t('released', { at: format.dateTime(o.releasedAt) })}</div> : null}
                </div>
              </li>
            ))}
          </Panel>
        ) : null}
      </div>
    </div>
  );
}
