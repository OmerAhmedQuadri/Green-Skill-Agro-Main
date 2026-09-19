'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, Badge, Button, Card, Field, Input, Select } from '@gsa/ui';
import { PageHeader } from '@/components/common/PageHeader';
import { EvidenceUpload } from '@/components/common/EvidenceUpload';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { decimalText } from '@/lib/forms';
import { useErrorText, useOnceCommand } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import { SETTLEMENT_TONE, type Settlement } from './types';

type Page<T> = { items: T[]; nextCursor: string | null };
type Manager = { id: string; name: string };

/**
 * Workflow M on the phone (CSH-002..005): the seller banks the cash or hands
 * it to a manager, with the slip or a photo. Nothing leaves their cash in
 * hand until a manager approves it (CSH-005).
 */
export function FieldCashScreen() {
  const t = useTranslations('cash');
  const format = useFormat();
  const errorText = useErrorText();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [route, setRoute] = useState<'BANK_DEPOSIT' | 'MANAGER_HANDOVER'>('BANK_DEPOSIT');
  const [amount, setAmount] = useState('');
  const [depositedOn, setDepositedOn] = useState(new Date().toISOString().slice(0, 10));
  const [receivedById, setReceivedById] = useState('');
  const [photoId, setPhotoId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const managerList = useQuery({ queryKey: keys.cashManagers, queryFn: () => api<{ items: Manager[] }>('/cash/managers') });
  const managers = managerList.data?.items ?? [];
  const mine = useQuery({ queryKey: keys.settlements(), queryFn: () => api<Page<Settlement>>('/cash/settlements?limit=20') });
  const held = useQuery({ queryKey: keys.cashInHand, queryFn: () => api<{ cashInHand: string }>('/cash/me') });
  const submit = useOnceCommand((body: unknown, key) => api<Settlement>('/cash/settlements', { method: 'POST', body, idempotencyKey: key }), {
    onSuccess: (s) => {
      for (const k of [keys.settlements(), keys.cashInHand]) void queryClient.invalidateQueries({ queryKey: k });
      router.push(`/field/cash/${s.id}`);
    },
  });

  const banking = route === 'BANK_DEPOSIT';
  const ready = Boolean(photoId) && decimalText(amount).length > 0 && (banking ? depositedOn : receivedById);
  return (
    <div className="space-y-4 pb-6">
      <PageHeader title={t('title')} />
      <Card className="p-4">
        <div className="text-sm text-stone-500">{t('inHand')}</div>
        <div className="text-2xl font-semibold" data-testid="cash-in-hand">{format.money(held.data?.cashInHand ?? '0.00')}</div>
      </Card>

      <Card className="space-y-3 p-4">
        <p className="font-semibold">{t('settleTitle')}</p>
        <Field id="route" label={t('route')}>
          <Select id="route" value={route} onChange={(e) => setRoute(e.target.value === 'MANAGER_HANDOVER' ? 'MANAGER_HANDOVER' : 'BANK_DEPOSIT')}>
            <option value="BANK_DEPOSIT">{t('routes.BANK_DEPOSIT')}</option>
            <option value="MANAGER_HANDOVER">{t('routes.MANAGER_HANDOVER')}</option>
          </Select>
        </Field>
        <Field id="amount" label={t('amount')}>
          <Input id="amount" inputMode="decimal" dir="ltr" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        {banking ? (
          <Field id="deposited-on" label={t('depositedOn')}>
            <Input id="deposited-on" type="date" dir="ltr" value={depositedOn} onChange={(e) => setDepositedOn(e.target.value)} />
          </Field>
        ) : (
          <Field id="received-by" label={t('receivedBy')}>
            <Select id="received-by" value={receivedById} onChange={(e) => setReceivedById(e.target.value)}>
              <option value="">{t('chooseManager')}</option>
              {managers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </Select>
          </Field>
        )}
        <EvidenceUpload id="slip" kind="DEPOSIT_SLIP" label={banking ? t('slip') : t('handoverPhoto')} onChange={setPhotoId} />
        <Field id="note" label={t('note')}><Input id="note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} /></Field>
        {submit.error ? <Alert>{errorText(submit.error)}</Alert> : null}
        <p className="text-sm text-stone-600">{t('untilApproved')}</p>
        <Button block disabled={!ready || submit.isPending} onClick={() => submit.run({
          route, amount: decimalText(amount), photoId, note: note.trim() || null,
          depositedOn: banking ? depositedOn : null, receivedById: banking ? null : receivedById,
        })}>{submit.isPending ? t('saving') : t('submit')}</Button>
      </Card>

      <div className="space-y-2">
        <p className="font-semibold">{t('mySettlements')}</p>
        {mine.data?.items.length === 0 ? <p className="text-sm text-stone-500">{t('none')}</p> : null}
        <ul className="space-y-2">
          {mine.data?.items.map((s) => (
            <li key={s.id}>
              <Link href={`/field/cash/${s.id}`} className="block">
                <Card className="flex items-center justify-between gap-3 p-4" data-testid={`settlement-${s.number}`}>
                  <div>
                    <div className="font-medium"><bdi dir="ltr">{s.number}</bdi></div>
                    <div className="text-xs text-stone-500">{`${format.dateTime(s.submittedAt)} · ${t(`routes.${s.route}`)}`}</div>
                  </div>
                  <div className="text-end">
                    <div className="font-semibold">{format.money(s.approvedAmount ?? s.declaredAmount)}</div>
                    <Badge tone={SETTLEMENT_TONE[s.status]}>{t(`statuses.${s.status}`)}</Badge>
                  </div>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
