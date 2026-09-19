'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, Badge, Button, Card, Field, Input } from '@gsa/ui';
import { PageHeader } from '@/components/common/PageHeader';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { decimalText } from '@/lib/forms';
import { useErrorText, useOnceCommand } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import { SETTLEMENT_TONE, type Settlement } from './types';

/**
 * One settlement (CSH-004..006). A manager approves it — for the amount they
 * counted, which needs a comment if it differs — or rejects it with one. Only
 * then does the cash leave the seller's hands.
 */
export function SettlementDetail({ id, surface, canDecide = false }: { id: string; surface: 'field' | 'console'; canDecide?: boolean }) {
  const t = useTranslations('cash');
  const format = useFormat();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState('');
  const [comment, setComment] = useState('');
  const query = useQuery({
    queryKey: keys.settlement(id), queryFn: () => api<Settlement>(`/cash/settlements/${id}`),
    refetchInterval: (q) => (q.state.data?.status === 'SUBMITTED' && surface === 'field' ? 15_000 : false),
  });
  const decide = useOnceCommand((body: unknown, key) => api<Settlement>(`/cash/settlements/${id}/decide`, { method: 'POST', body, idempotencyKey: key }), {
    onSuccess: (s) => {
      queryClient.setQueryData(keys.settlement(id), s);
      for (const k of [keys.settlements(), keys.cashInHand, keys.sellerCash, keys.dashboardFlags]) void queryClient.invalidateQueries({ queryKey: k });
    },
  });

  if (query.isPending) return <p className="text-sm text-stone-500">{t('loading')}</p>;
  if (query.error) return <Alert>{errorText(query.error)}</Alert>;
  const s = query.data;
  const back = surface === 'field' ? { href: '/field/cash', label: t('title') } : { href: '/console/cash', label: t('title') };
  return (
    <div className={surface === 'field' ? 'space-y-4 pb-6' : 'mx-auto max-w-3xl space-y-6'}>
      <PageHeader title={<bdi dir="ltr">{s.number}</bdi>} subtitle={t(`routes.${s.route}`)} back={back} />
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={SETTLEMENT_TONE[s.status]} data-testid="settlement-status">{t(`statuses.${s.status}`)}</Badge>
        <span className="text-sm text-stone-600">{format.dateTime(s.submittedAt)}</span>
      </div>

      <Card className="space-y-1 p-4 text-sm">
        <div className="flex justify-between"><span>{t('seller')}</span><span>{s.seller.name}</span></div>
        <div className="flex justify-between"><span>{t('declared')}</span><span data-testid="declared">{format.money(s.declaredAmount)}</span></div>
        {s.depositedOn ? <div className="flex justify-between"><span>{t('depositedOn')}</span><span>{format.date(s.depositedOn)}</span></div> : null}
        {s.receivedBy ? <div className="flex justify-between"><span>{t('receivedBy')}</span><span>{s.receivedBy.name}</span></div> : null}
        {s.approvedAmount ? <div className="flex justify-between font-semibold"><span>{t('approved')}</span><span data-testid="approved">{format.money(s.approvedAmount)}</span></div> : null}
        {s.shortfall ? <div className="flex justify-between text-amber-800"><span>{t('shortfall')}</span><span data-testid="shortfall">{format.money(s.shortfall)}</span></div> : null}
        {s.discrepancy ? <div className="flex justify-between text-amber-800"><span>{t('discrepancy')}</span><span data-testid="discrepancy">{format.money(s.discrepancy)}</span></div> : null}
        {s.note ? <div className="pt-1 text-stone-600">{t('noteLine', { note: s.note })}</div> : null}
        {s.decidedBy ? <div className="pt-1 text-stone-600">{t('decidedBy', { name: s.decidedBy.name, time: format.dateTime(s.decidedAt ?? s.submittedAt) })}</div> : null}
        {s.decisionComment ? <div className="text-stone-600">{t('commentLine', { comment: s.decisionComment })}</div> : null}
      </Card>

      {s.status === 'SUBMITTED' && surface === 'field' ? <Alert tone="info" data-testid="waiting">{t('waiting')}</Alert> : null}
      {s.status === 'REJECTED' && surface === 'field' ? <Alert tone="warning">{t('rejectedHint')}</Alert> : null}

      {s.status === 'SUBMITTED' && canDecide ? (
        <Card className="space-y-3 p-4" data-testid="decide">
          <p className="font-semibold">{t('decideTitle')}</p>
          <Field id="counted" label={t('counted')} hint={t('countedHint')}>
            <Input id="counted" inputMode="decimal" dir="ltr" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field id="comment" label={t('comment')}><Input id="comment" value={comment} maxLength={500} onChange={(e) => setComment(e.target.value)} /></Field>
          {decide.error ? <Alert>{errorText(decide.error)}</Alert> : null}
          <div className="flex flex-wrap gap-2">
            <Button disabled={decide.isPending} onClick={() => decide.run({ version: s.version, approve: true, amount: decimalText(amount) || null, comment: comment.trim() || null })}>
              {t('approve')}
            </Button>
            <Button variant="danger" disabled={decide.isPending} onClick={() => decide.run({ version: s.version, approve: false, comment: comment.trim() || null })}>
              {t('reject')}
            </Button>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
