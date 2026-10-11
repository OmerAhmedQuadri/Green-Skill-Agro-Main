'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, Badge, Button, Field, Input } from '@gsa/ui';
import { PageHeader } from '@/components/common/PageHeader';
import { Facts, Section } from '@/components/common/Section';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { decimalText } from '@/lib/forms';
import { useCommand, useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import { SaleReturns } from '@/components/returns/SaleReturns';
import { DeliveryDocumentPanel } from './DeliveryDocumentPanel';
import { partyOf } from './party';
import { SaleLinesTable, trimPercent } from './SaleLinesTable';
import { SALE_TONE, type Sale } from './types';

/**
 * A sale in the console (PRC-012, PRC-013, PRC-017, DOC-005): its lines and
 * batches, the discount request and its decision, the payment, the override
 * that released it, and the delivery document. An approver decides here:
 * approve as asked, lower any line, or reject — first decision wins.
 *
 * ADR-0052: an open sale shows its buyer and where it was made; its request
 * says why it waited, and is approved as it stands or rejected — by whoever
 * approves open sales.
 */
export function SaleDetail({ id, canDecide: canDecideDiscount, canDecideOpenSale = false, canReturn = false, canKeep = false }: {
  id: string; canDecide: boolean; canDecideOpenSale?: boolean; canReturn?: boolean; canKeep?: boolean;
}) {
  const t = useTranslations('sales');
  const ts = useTranslations('stores');
  const tr = useTranslations('returns');
  const format = useFormat();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const [given, setGiven] = useState<Record<string, string>>({});
  const [comment, setComment] = useState('');
  const sale = useQuery({
    queryKey: keys.sale(id), queryFn: () => api<Sale>(`/sales/${id}`),
    refetchInterval: (q) => (q.state.data?.status === 'PENDING_DISCOUNT_APPROVAL' ? 10_000 : false),
  });
  const decide = useCommand((body: unknown, key) => api<Sale>(`/discount-approvals/${id}/decide`, { method: 'POST', body, idempotencyKey: key }), {
    onSuccess: (s) => { queryClient.setQueryData(keys.sale(id), s); void queryClient.invalidateQueries({ queryKey: keys.sales() }); },
    // Someone decided first: show the sale as it now stands.
    onError: () => { void queryClient.invalidateQueries({ queryKey: keys.sale(id) }); },
  });

  if (sale.isPending) return <p className="text-sm text-stone-500">{t('loading')}</p>;
  if (sale.error) return <Alert>{errorText(sale.error)}</Alert>;
  const s = sale.data;
  const a = s.approval;
  const pending = s.status === 'PENDING_DISCOUNT_APPROVAL';
  const openRequest = a?.kind === 'OPEN_SALE';
  const canDecide = openRequest ? canDecideOpenSale : canDecideDiscount;
  const run = (approve: boolean) => decide.run({
    version: s.version, approve, comment: comment.trim() || null,
    // An open sale is approved as it stands — never lower.
    lines: approve && !openRequest ? s.lines.map((l) => ({ lineId: l.id, discount: decimalText(given[l.id] ?? trimPercent(l.requestedDiscount)) || '0' })) : undefined,
  });

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title={partyOf(s, t)} subtitle={t('soldBy', { seller: s.seller.name, time: format.dateTime(s.completedAt ?? s.createdAt) })}
        back={{ href: '/console/sales', label: t('title') }} actions={<Badge tone={SALE_TONE[s.status]} data-testid="sale-status">{t(`statuses.${s.status}`)}</Badge>} />

      {a ? (
        <Section title={openRequest ? t('open.requestTitle') : t('requestTitleConsole')}>
          <Facts items={[
            ...(openRequest ? [{ label: t('open.whyWaiting'), value: <span data-testid="open-grounds">{a.grounds.map((g) => t(`open.grounds.${g}`)).join(' ')}</span> }] : []),
            { label: openRequest ? t('open.requestReason') : t('requestReason'), value: a.reason },
            { label: t('requestedAt'), value: format.dateTime(a.requestedAt) },
            { label: tStatus(a.status), value: a.decidedBy ? t('decidedBy', { name: a.decidedBy.name, time: format.dateTime(a.decidedAt ?? a.requestedAt) }) : pending ? t('expiresAt', { time: format.dateTime(a.expiresAt) }) : '—' },
            { label: t('comment'), value: a.comment ?? '—' },
          ]} />
          {pending && canDecide ? (
            <div className="space-y-4 border-t border-stone-200 p-5" data-testid="decide">
              <p className="text-sm text-stone-600">{openRequest ? t('open.decideHintOpen') : t('decideHint')}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                {openRequest ? null : s.lines.map((l) => (
                  <Field key={l.id} id={`given-${l.id}`} label={t('approvedFor', { code: l.code })} hint={t('askedCeiling', { asked: trimPercent(l.requestedDiscount), ceiling: trimPercent(l.ceiling) })}>
                    <Input id={`given-${l.id}`} inputMode="decimal" dir="ltr" value={given[l.id] ?? trimPercent(l.requestedDiscount)}
                      onChange={(e) => setGiven({ ...given, [l.id]: e.target.value })} />
                  </Field>
                ))}
              </div>
              <Field id="decision-comment" label={t('comment')} hint={openRequest ? t('open.commentHint') : t('commentHint')}><Input id="decision-comment" value={comment} maxLength={500} onChange={(e) => setComment(e.target.value)} /></Field>
              {decide.error ? <Alert>{errorText(decide.error)}</Alert> : null}
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => run(true)} disabled={decide.isPending}>{openRequest ? t('open.approveOpen') : t('approve')}</Button>
                <Button variant="danger" onClick={() => run(false)} disabled={decide.isPending}>{t('reject')}</Button>
              </div>
            </div>
          ) : null}
        </Section>
      ) : null}

      <Section title={t('lines')}><SaleLinesTable sale={s} showBatches /></Section>

      {/* SAL-018: an open sale is never returned. */}
      {s.status === 'COMPLETED' && s.store ? <Section title={tr('sectionTitle')}><div className="p-5"><SaleReturns saleId={s.id} surface="console" canReturn={canReturn} /></div></Section> : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title={t('details')}>
          <Facts items={[
            { label: t('seller'), value: s.seller.name },
            { label: t('vehicle'), value: s.vehicle ? <bdi dir="ltr">{s.vehicle.registration}</bdi> : t('fromWarehouse') },
            ...(s.store ? [{ label: ts('creditMode'), value: ts(`modes.${s.store.creditMode}`) }] : []),
            ...(s.open ? [
              {
                label: t('open.buyer'),
                value: <span data-testid="open-buyer">{s.open.buyerName ?? t('open.noBuyer')}{s.open.buyerPhone ? <bdi dir="ltr" className="block">{s.open.buyerPhone}</bdi> : null}</span>,
              },
              {
                label: t('open.where'),
                value: <a href={`https://www.google.com/maps?q=${s.open.location.lat},${s.open.location.lng}`} target="_blank" rel="noreferrer" className="text-brand-800 underline">{t('open.onMap')}</a>,
              },
            ] : []),
            { label: t('payment'), value: s.payment ? t('paidWith', { method: ts(`methods.${s.payment.method}`), amount: format.money(s.payment.amount) }) : s.status === 'COMPLETED' ? t('onAccount') : '—' },
            { label: t('override'), value: s.creditOverride ? t('overrideUsed', { name: s.creditOverride.grantedBy, reason: s.creditOverride.reason }) : '—' },
            { label: tStatus(null), value: s.cancelReason ? t(`cancelReasons.${s.cancelReason}`) : t(`statuses.${s.status}`) },
          ]} />
        </Section>
        {s.document ? <Section title={s.open ? t('open.documentTitle') : t('documentTitle')}><div className="p-5"><DeliveryDocumentPanel sale={s} canSend={false} canKeep={canKeep} onChanged={(next) => queryClient.setQueryData(keys.sale(id), next)} /></div></Section> : null}
      </div>
    </div>
  );

  function tStatus(status: string | null) {
    return status ? t(`approvalStatuses.${status as NonNullable<Sale['approval']>['status']}`) : t('outcome');
  }
}
