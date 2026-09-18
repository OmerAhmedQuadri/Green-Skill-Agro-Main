'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import type { FormEvent } from 'react';
import { Alert, Button, Input } from '@gsa/ui';
import { Section } from '@/components/common/Section';
import { Cell, Table } from '@/components/common/Table';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { formText } from '@/lib/forms';
import { useCommand, useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import type { Ceilings, CommissionRate } from './types';

type Kind = 'CASH_IN_HAND' | 'VEHICLE_STOCK_VALUE';
const KINDS: readonly Kind[] = ['CASH_IN_HAND', 'VEHICLE_STOCK_VALUE'];

/** LIM-001, SYS-002: global ceilings, and per-seller ceilings that take precedence (OQ-005). */
export function CeilingsSection() {
  const t = useTranslations();
  const format = useFormat();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const ceilings = useQuery({ queryKey: keys.ceilings, queryFn: () => api<Ceilings>('/ceilings') });
  const set = useCommand((body: { kind: Kind; sellerId: string | null; amount: string | null }, key) =>
    api<Ceilings>('/ceilings', { method: 'PUT', body, idempotencyKey: key }), { onSuccess: (next) => queryClient.setQueryData(keys.ceilings, next) });

  const amountForm = (kind: Kind, sellerId: string | null, current: string | null, placeholder: string) => (
    <form className="flex gap-2" noValidate onSubmit={(e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const value = formText(new FormData(e.currentTarget), 'amount');
      set.run({ kind, sellerId, amount: value === '' ? null : value });
    }}>
      <Input name="amount" defaultValue={current ?? ''} placeholder={placeholder} inputMode="decimal" dir="ltr" className="w-36"
        aria-label={t(`settings.ceilingKinds.${kind}`)} />
      <Button type="submit" variant="secondary" size="sm" disabled={set.isPending}>{t('common.save')}</Button>
    </form>
  );

  return (
    <Section title={t('settings.ceilings')} description={t('settings.ceilingsHint')}>
      {set.error ? <div className="px-5 pt-4"><Alert>{errorText(set.error)}</Alert></div> : null}
      {ceilings.data ? (
        <>
          <div className="grid gap-4 p-5 sm:grid-cols-2">
            {KINDS.map((k) => (
              <div key={`${k}-${ceilings.data.global[k] ?? ''}`}>
                <div className="mb-1.5 text-sm font-medium">{t('settings.globalCeiling', { kind: t(`settings.ceilingKinds.${k}`) })}</div>
                {amountForm(k, null, ceilings.data.global[k], t('settings.noCeiling'))}
              </div>
            ))}
          </div>
          {ceilings.data.sellers.length > 0 ? (
            <Table head={[t('settings.seller'), ...KINDS.map((k) => t(`settings.ceilingKinds.${k}`))]}>
              {ceilings.data.sellers.map((s) => (
                <tr key={s.sellerId}>
                  <Cell className="font-medium">{s.name}</Cell>
                  {KINDS.map((k) => (
                    <Cell key={`${k}-${s.own[k] ?? ''}`}>
                      {amountForm(k, s.sellerId, s.own[k], s.effective[k] ? t('settings.usesGlobal', { amount: format.money(s.effective[k]) }) : t('settings.noCeiling'))}
                    </Cell>
                  ))}
                </tr>
              ))}
            </Table>
          ) : <p className="px-5 pb-5 text-sm text-stone-500">{t('settings.noSellers')}</p>}
        </>
      ) : <p className="p-5 text-sm text-stone-500">{t('common.loading')}</p>}
    </Section>
  );
}

/** SYS-008: commission rates per seller, on target and below target. */
export function CommissionSection() {
  const t = useTranslations();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const rates = useQuery({ queryKey: keys.commissionRates, queryFn: () => api<CommissionRate[]>('/commission-rates') });
  const set = useCommand(({ sellerId, rate }: { sellerId: string; rate: { onTarget: string; belowTarget: string } | null }, key) =>
    api<CommissionRate[]>(`/commission-rates/${sellerId}`, { method: 'PUT', body: { rate }, idempotencyKey: key }),
  { onSuccess: (next) => queryClient.setQueryData(keys.commissionRates, next) });

  return (
    <Section title={t('settings.commission')} description={t('settings.commissionHint')}>
      {set.error ? <div className="px-5 pt-4"><Alert>{errorText(set.error)}</Alert></div> : null}
      {rates.data && rates.data.length === 0 ? <p className="p-5 text-sm text-stone-500">{t('settings.noSellers')}</p> : null}
      {rates.data && rates.data.length > 0 ? (
        <Table head={[t('settings.seller'), t('settings.rates')]}>
          {rates.data.map((r) => (
            <tr key={`${r.sellerId}-${r.onTarget ?? ''}-${r.belowTarget ?? ''}`}>
              <Cell className="font-medium">{r.name}</Cell>
              <Cell>
                <form className="flex flex-wrap items-center gap-2" noValidate onSubmit={(e: FormEvent<HTMLFormElement>) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  const onTarget = formText(f, 'onTarget');
                  const belowTarget = formText(f, 'belowTarget');
                  set.run({ sellerId: r.sellerId, rate: onTarget === '' && belowTarget === '' ? null : { onTarget, belowTarget } });
                }}>
                  <Input name="onTarget" defaultValue={r.onTarget ?? ''} inputMode="decimal" dir="ltr" className="w-24" aria-label={t('settings.onTarget')} placeholder={t('settings.onTarget')} />
                  <Input name="belowTarget" defaultValue={r.belowTarget ?? ''} inputMode="decimal" dir="ltr" className="w-24" aria-label={t('settings.belowTarget')} placeholder={t('settings.belowTarget')} />
                  <Button type="submit" variant="secondary" size="sm" disabled={set.isPending}>{t('common.save')}</Button>
                </form>
              </Cell>
            </tr>
          ))}
        </Table>
      ) : null}
    </Section>
  );
}
