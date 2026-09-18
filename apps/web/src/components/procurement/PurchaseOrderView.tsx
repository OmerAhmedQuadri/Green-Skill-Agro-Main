'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Field, Input } from '@gsa/ui';
import { PageHeader } from '@/components/common/PageHeader';
import { Facts, Section } from '@/components/common/Section';
import { Cell, Table } from '@/components/common/Table';
import { api } from '@/lib/api';
import { daysUntil, useFormat } from '@/lib/format';
import { formText } from '@/lib/forms';
import { useCommand, useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import { ImportPanel } from './ImportPanel';
import { PurchaseOrderForm, type PoInput } from './PurchaseOrderForm';
import { ReceivePanel } from './ReceivePanel';
import { PoStatusBadge } from './StatusBadge';
import { ACTIONS, RECEIVABLE, type PoAction, type PoDetail, type ProcurementCan } from './types';

const EVENTS = ['create', 'submit', 'reject', 'approve', 'place', 'confirm', 'despatch', 'receive', 'close_complete', 'close_short', 'cancel'] as const;
const eventKey = (action: string) => EVENTS.find((e) => e === action);

export function PurchaseOrderView({ id, can }: { id: string; can: ProcurementCan }) {
  const t = useTranslations();
  const format = useFormat();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [asking, setAsking] = useState<PoAction | null>(null);
  const [receiving, setReceiving] = useState<'manual' | 'import' | null>(null);
  const po = useQuery({ queryKey: keys.purchaseOrder(id), queryFn: () => api<PoDetail>(`/purchase-orders/${id}`) });

  const replace = (next: PoDetail) => {
    queryClient.setQueryData(keys.purchaseOrder(id), next);
    void queryClient.invalidateQueries({ queryKey: keys.purchaseOrders() });
    void queryClient.invalidateQueries({ queryKey: keys.incoming });
    void queryClient.invalidateQueries({ queryKey: keys.stock() });
  };
  const update = useCommand((body: PoInput & { version: number }, key) =>
    api<PoDetail>(`/purchase-orders/${id}`, { method: 'PATCH', body, idempotencyKey: key }), { onSuccess: (p) => { replace(p); setEditing(false); } });
  const transition = useCommand(({ action, ...body }: { action: PoAction; version: number; reason: string | null }, key) =>
    api<PoDetail>(`/purchase-orders/${id}/transitions/${action.replace(/_/g, '-')}`, { method: 'POST', body, idempotencyKey: key }),
  { onSuccess: (p) => { replace(p); setAsking(null); } });

  if (po.error) return <Alert>{errorText(po.error)}</Alert>;
  if (!po.data) return <p className="text-sm text-stone-500">{t('common.loading')}</p>;
  const o = po.data;
  const offered = ACTIONS[o.status].filter((a) => (a.needs === 'manage' ? can.manage : can.approve));
  const receivable = RECEIVABLE.includes(o.status);
  const countdown = o.expectedArrival && o.status !== 'CLOSED' ? daysUntil(o.expectedArrival) : null;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        back={{ href: '/console/purchase-orders', label: t('procurement.title') }}
        title={<span className="flex flex-wrap items-center gap-3"><bdi dir="ltr" className="font-mono">{o.number}</bdi><PoStatusBadge po={o} />
          {o.origin === 'FORECAST' ? <Badge>{t('procurement.fromForecast')}</Badge> : null}</span>}
        subtitle={`${o.vendor.code} · ${o.vendor.name}`}
        actions={offered.length > 0 ? (
          <>
            {offered.map((a) => (
              <Button key={a.action} variant={a.tone === 'danger' ? 'danger' : a.action === 'submit' || a.action === 'approve' || a.action === 'place' ? 'primary' : 'secondary'}
                disabled={transition.isPending}
                onClick={() => (a.reason ? setAsking(a.action) : transition.run({ action: a.action, version: o.version, reason: null }))}>
                {t(`procurement.actions.${a.action}`)}
              </Button>
            ))}
          </>
        ) : undefined}
      />

      {transition.error && !asking ? <Alert>{errorText(transition.error)}</Alert> : null}
      {asking ? (
        <Section title={t(`procurement.actions.${asking}`)}>
          <form className="flex flex-wrap items-end gap-3 p-5" noValidate onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            transition.run({ action: asking, version: o.version, reason: formText(new FormData(e.currentTarget), 'reason') });
          }}>
            {transition.error ? <Alert className="w-full">{errorText(transition.error)}</Alert> : null}
            <div className="min-w-72 flex-1"><Field id="po-reason" label={t('procurement.reason')}><Input id="po-reason" name="reason" required maxLength={500} /></Field></div>
            <Button type="submit" variant={asking === 'cancel' ? 'danger' : 'primary'} disabled={transition.isPending}>{t(`procurement.actions.${asking}`)}</Button>
            <Button variant="ghost" onClick={() => setAsking(null)}>{t('common.back')}</Button>
          </form>
        </Section>
      ) : null}

      <Section title={t('procurement.details')}
        actions={o.status === 'DRAFT' && can.manage && !editing ? <Button variant="ghost" size="sm" onClick={() => setEditing(true)}><Pencil className="size-4" aria-hidden />{t('common.edit')}</Button> : undefined}>
        {editing ? (
          <div className="p-5">
            <PurchaseOrderForm key={o.version} order={o} submitLabel={t('common.save')} pending={update.isPending} error={update.error}
              onSubmit={(input) => update.run({ ...input, version: o.version })} onCancel={() => setEditing(false)} />
          </div>
        ) : (
          <Facts items={[
            { label: t('procurement.vendor'), value: <span><bdi dir="ltr" className="font-mono">{o.vendor.code}</bdi>{' · '}{o.vendor.name}</span> },
            {
              label: t('procurement.expectedArrival'),
              value: o.expectedArrival ? (
                <span>{format.date(o.expectedArrival)}{countdown !== null ? <span className="ms-2 text-stone-500">{countdown >= 0 ? t('procurement.arrivesIn', { count: countdown }) : t('procurement.overdueBy', { count: -countdown })}</span> : null}</span>
              ) : '—',
            },
            { label: t('procurement.value'), value: format.money(o.orderValue) },
            { label: t('procurement.notes'), value: o.notes ?? '—' },
            ...(o.status === 'CLOSED' && o.closeNote ? [{ label: t('procurement.closeNote'), value: o.closeNote }] : []),
          ]} />
        )}
      </Section>

      <Section title={t('procurement.lines')}
        actions={receivable && !receiving ? (
          <span className="flex gap-2">
            {can.receive ? <Button size="sm" onClick={() => setReceiving('manual')}>{t('receiving.receive')}</Button> : null}
            {can.import ? <Button size="sm" variant="secondary" onClick={() => setReceiving('import')}>{t('receiving.import')}</Button> : null}
          </span>
        ) : undefined}>
        <Table head={[t('catalogue.skuCode'), t('catalogue.product'), t('catalogue.packSize'), t('procurement.orderedPacks'), t('procurement.receivedPacks'), t('procurement.variance'), t('procurement.outstanding'), t('procurement.expectedUnitCost')]}>
          {o.lines.map((l) => (
            <tr key={l.id}>
              <Cell><bdi dir="ltr" className="font-mono">{l.code}</bdi></Cell>
              <Cell>{format.name(l.product)}{l.variety ? <div className="text-xs text-stone-500">{format.name(l.variety)}</div> : null}</Cell>
              <Cell>{format.size(l.size, l.countUnit)}</Cell>
              <Cell>{format.number(l.orderedPacks)}</Cell>
              <Cell>{format.number(l.receivedPacks)}</Cell>
              <Cell className={l.variance < 0 && o.status === 'CLOSED' ? 'text-amber-700' : l.variance > 0 ? 'text-amber-700' : ''}>
                {l.receivedPacks === 0 ? '—' : (l.variance > 0 ? '+' : '') + format.number(l.variance)}
              </Cell>
              <Cell>{format.number(l.outstandingPacks)}</Cell>
              <Cell>{format.money(l.expectedUnitCost)}</Cell>
            </tr>
          ))}
        </Table>
      </Section>

      {receiving === 'manual' ? <ReceivePanel order={o} onDone={(next) => { if (next) replace(next); setReceiving(null); }} /> : null}
      {receiving === 'import' ? <ImportPanel order={o} onDone={(next) => { if (next) replace(next); setReceiving(null); }} /> : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title={t('procurement.receipts')}>
          {o.receipts.length === 0 ? <p className="p-5 text-sm text-stone-500">{t('procurement.noReceipts')}</p> : (
            <ul className="divide-y divide-stone-100">
              {o.receipts.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
                  <span>{`${format.dateTime(r.receivedAt)} · ${r.by}`}</span>
                  <span className="flex items-center gap-2">
                    {r.source === 'IMPORT' ? <Badge>{r.fileName ?? t('receiving.imported')}</Badge> : null}
                    {t('receiving.packsReceived', { count: r.packs })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title={t('procurement.history')}>
          <ol className="divide-y divide-stone-100">
            {o.events.map((e, i) => (
              <li key={i} className="px-5 py-3 text-sm">
                <div className="flex flex-wrap justify-between gap-2">
                  <span className="font-medium">{(() => { const k = eventKey(e.action); return k ? t(`procurement.events.${k}`) : e.action; })()}</span>
                  <span className="text-stone-500">{format.dateTime(e.at)}</span>
                </div>
                <div className="text-stone-600">{e.actor}{e.reason ? ` — ${e.reason}` : ''}</div>
              </li>
            ))}
          </ol>
        </Section>
      </div>
    </div>
  );
}
