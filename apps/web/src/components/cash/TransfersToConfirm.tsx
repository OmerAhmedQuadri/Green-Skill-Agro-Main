'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, Button, Field, Input } from '@gsa/ui';
import { Cell, Table } from '@/components/common/Table';
import { Section } from '@/components/common/Section';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useErrorText, useOnceCommand } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import type { AwaitingTransfer } from './types';

/**
 * ADR-0046: the stores' bank transfers nobody has checked yet, oldest first,
 * to work through against the bank statement. Confirmed, a transfer counts
 * towards the seller's commission; not received, the store owes it again.
 */
export function TransfersToConfirm() {
  const t = useTranslations('cash');
  const errorText = useErrorText();
  const awaiting = useQuery({
    queryKey: keys.transfers, queryFn: () => api<{ items: AwaitingTransfer[]; total: number }>('/cash/transfers?limit=50'), refetchInterval: 30_000,
  });
  const more = (awaiting.data?.total ?? 0) - (awaiting.data?.items.length ?? 0);
  return (
    <Section title={t('transfersTitle')} description={t('transfersHint')}>
      {awaiting.error ? <Alert>{errorText(awaiting.error)}</Alert> : null}
      {awaiting.data?.items.length === 0 ? <p className="p-5 text-sm text-stone-500" data-testid="no-transfers">{t('noTransfers')}</p> : (
        <Table head={[t('number'), t('store'), t('seller'), t('reference'), t('amount'), t('received'), t('decision')]}>
          {awaiting.data?.items.map((transfer) => <TransferRow key={transfer.id} transfer={transfer} />)}
        </Table>
      )}
      {more > 0 ? <p className="px-5 pb-4 text-sm text-stone-500">{t('moreTransfers', { count: more })}</p> : null}
    </Section>
  );
}

function TransferRow({ transfer }: { transfer: AwaitingTransfer }) {
  const t = useTranslations('cash');
  const tCommon = useTranslations('common');
  const format = useFormat();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  // Null until "Not received" is pressed: only then is a reason asked for.
  const [reason, setReason] = useState<string | null>(null);
  const decide = useOnceCommand((body: unknown, key) => api(`/cash/transfers/${transfer.id}/decide`, { method: 'POST', body, idempotencyKey: key }), {
    // A confirmation moves the seller's commission, so the standings are stale too.
    onSuccess: () => { for (const k of [keys.transfers, keys.standings()]) void queryClient.invalidateQueries({ queryKey: k }); },
  });
  const reasonId = `not-received-${transfer.id}`;
  return (
    <tr data-testid={`transfer-${transfer.number}`}>
      <Cell className="whitespace-nowrap"><bdi dir="ltr">{transfer.number}</bdi></Cell>
      <Cell>{transfer.store.name}</Cell>
      <Cell>{transfer.seller.name}</Cell>
      <Cell className="whitespace-nowrap"><bdi dir="ltr">{transfer.reference}</bdi></Cell>
      <Cell className="whitespace-nowrap">{format.money(transfer.amount)}</Cell>
      <Cell>{format.dateTime(transfer.receivedAt)}</Cell>
      <Cell>
        {!transfer.decidable ? <span className="text-sm text-stone-500">{t('ownTransfer')}</span> : reason === null ? (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={decide.isPending} onClick={() => decide.run({ outcome: 'CONFIRMED' })}>{t('confirmArrived')}</Button>
            <Button size="sm" variant="secondary" disabled={decide.isPending} onClick={() => setReason('')}>{t('notReceived')}</Button>
          </div>
        ) : (
          <div className="min-w-56 space-y-2">
            <Field id={reasonId} label={t('notReceivedReason')}>
              <Input id={reasonId} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="danger" disabled={decide.isPending || !reason.trim()} onClick={() => decide.run({ outcome: 'NOT_RECEIVED', reason: reason.trim() })}>
                {t('markNotReceived')}
              </Button>
              <Button size="sm" variant="secondary" disabled={decide.isPending} onClick={() => setReason(null)}>{tCommon('cancel')}</Button>
            </div>
          </div>
        )}
        {decide.error ? <Alert>{errorText(decide.error)}</Alert> : null}
      </Cell>
    </tr>
  );
}
