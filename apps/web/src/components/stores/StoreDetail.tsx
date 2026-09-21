'use client';

import { dec } from '@gsa/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Field, Input, Select } from '@gsa/ui';
import { PageHeader } from '@/components/common/PageHeader';
import { Facts, Section } from '@/components/common/Section';
import { Cell, Table } from '@/components/common/Table';
import type { Seller } from '@/components/vehicles/types';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { decimalText, formText } from '@/lib/forms';
import { useCommand, useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import { CreditPanel } from './CreditPanel';
import { LedgerSummary } from './LedgerSummary';
import { LedgerTable } from './LedgerTable';
import { STATUS_TONE, type LedgerEntry, type Store, type StoreOptions } from './types';

type Can = { approve: boolean; editTerms: boolean; reassign: boolean; override: boolean; adjust: boolean };

/**
 * One store for managers (STO-005..009, CRD-004..007): approve or reject it,
 * its terms, its account manager, why it is blocked and releasing it for a
 * sale, corrections, and its ledger.
 */
export function StoreDetail({ id, can }: { id: string; can: Can }) {
  const t = useTranslations('stores');
  const tc = useTranslations('common');
  const format = useFormat();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const store = useQuery({ queryKey: keys.store(id), queryFn: () => api<Store>(`/stores/${id}`) });
  const ledger = useQuery({ queryKey: keys.storeLedger(id), queryFn: () => api<LedgerEntry[]>(`/stores/${id}/ledger`) });
  const options = useQuery({ queryKey: keys.storeOptions, queryFn: () => api<StoreOptions>('/stores/options'), enabled: can.editTerms });
  const sellers = useQuery({ queryKey: keys.sellers, queryFn: () => api<Seller[]>('/sellers'), enabled: can.reassign });
  const refresh = () => { for (const k of [keys.store(id), keys.storeLedger(id), keys.stores()]) void queryClient.invalidateQueries({ queryKey: k }); };
  const act = useCommand(({ path, method, body }: { path: string; method: 'POST' | 'PATCH'; body: object }, key) =>
    api(`/stores/${id}${path}`, { method, body, idempotencyKey: key }), { onSuccess: refresh });
  const [rejecting, setRejecting] = useState(false);

  if (store.isPending) return <p className="text-sm text-stone-500">{tc('loading')}</p>;
  if (store.error) return <Alert>{errorText(store.error)}</Alert>;
  const s = store.data;
  const form = (run: (f: FormData) => void) => (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); run(new FormData(e.currentTarget)); e.currentTarget.reset(); };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title={s.name} subtitle={s.ownerName} back={{ href: '/console/stores', label: t('title') }}
        actions={<Badge tone={STATUS_TONE[s.status]}>{t(`statuses.${s.status}`)}</Badge>} />
      {act.error ? <Alert>{errorText(act.error)}</Alert> : null}

      {s.status === 'PENDING_APPROVAL' && can.approve ? (
        <Section title={t('approval')} description={t('approvalHint')}>
          <div className="flex flex-wrap items-end gap-2 p-5">
            {!rejecting ? (
              <>
                <Button onClick={() => act.run({ path: '/approve', method: 'POST', body: { version: s.version } })} disabled={act.isPending}>{t('approve')}</Button>
                <Button variant="secondary" onClick={() => setRejecting(true)}>{t('reject')}</Button>
              </>
            ) : (
              <form className="flex flex-wrap items-end gap-2" noValidate onSubmit={form((f) => act.run({ path: '/reject', method: 'POST', body: { version: s.version, reason: formText(f, 'reason') } }))}>
                <Field id="rej-reason" label={t('rejectReason')}><Input id="rej-reason" name="reason" maxLength={500} /></Field>
                <Button type="submit" variant="danger" disabled={act.isPending}>{t('reject')}</Button>
                <Button variant="ghost" onClick={() => setRejecting(false)}>{tc('cancel')}</Button>
              </form>
            )}
          </div>
        </Section>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title={t('credit')}>
          <div className="p-5">
            <CreditPanel credit={s.credit} />
            {s.override ? <p className="mt-2 text-sm text-stone-600">{t('overrideBy', { name: s.override.grantedBy, reason: s.override.reason })}</p> : null}
          </div>
          {/* OQ-018: for a blocked store, or for one sale above its limit. */}
          {can.override && s.status === 'ACTIVE' && !s.credit.overrideAvailable && !s.credit.overridden ? (
            <form className="flex flex-wrap items-end gap-2 border-t border-stone-200 p-5" noValidate
              onSubmit={form((f) => act.run({ path: '/credit-overrides', method: 'POST', body: { reason: formText(f, 'reason') } }))}>
              <Field id="ov-reason" label={t('overrideReason')} hint={t('overrideHint')}><Input id="ov-reason" name="reason" maxLength={500} /></Field>
              <Button type="submit" variant="secondary" disabled={act.isPending}>{t('releaseForOneSale')}</Button>
            </form>
          ) : null}
        </Section>

        <Section title={t('details')}>
          <Facts items={[
            { label: t('seller'), value: s.seller?.name ?? '—' },
            { label: t('contactNumber'), value: <bdi dir="ltr">{s.contactNumber}</bdi> },
            { label: t('category'), value: s.category ?? '—' },
            { label: t('address'), value: s.address ?? '—' },
            { label: t('location'), value: <a className="text-brand-800 hover:underline" target="_blank" rel="noreferrer" href={`https://www.google.com/maps?q=${s.location.lat},${s.location.lng}`}><bdi dir="ltr">{`${s.location.lat.toFixed(5)}, ${s.location.lng.toFixed(5)}`}</bdi></a> },
            { label: t('storefront'), value: s.storefrontMediaId ? <a className="text-brand-800 hover:underline" target="_blank" rel="noreferrer" href={`/api/v1/media/${s.storefrontMediaId}`}>{t('viewPhoto')}</a> : '—' },
            { label: t('crNumber'), value: s.crNumber ?? '—' },
            { label: t('vatNumber'), value: s.vatNumber ?? '—' },
            { label: t('nationalAddress'), value: s.nationalAddress ?? '—' },
            { label: t('onboardedBy'), value: t('onboardedOn', { name: s.onboardedBy.name, date: format.dateTime(s.createdAt) }) },
          ]} />
        </Section>
      </div>

      <Section title={t('terms')}>
        <Facts items={[
          {
            label: t('creditMode'),
            value: (
              <>
                {s.creditMode === 'CUSTOM' ? t('customCycle', { days: s.creditCycleDays ?? 0 }) : t(`modes.${s.creditMode}`)}
                {dec(s.credit.outstanding).gt(0) ? <div className="mt-1 text-xs text-stone-500">{t('cycleKeepsDueDates')}</div> : null}
              </>
            ),
          },
          { label: t('creditLimit'), value: format.money(s.creditLimit) },
          { label: t('priceList'), value: format.name(s.priceList) },
        ]} />
        {can.editTerms ? (
          <form className="grid gap-3 border-t border-stone-200 p-5 sm:grid-cols-3" noValidate
            onSubmit={form((f) => act.run({ path: '/terms', method: 'PATCH', body: { version: s.version, creditLimit: decimalText(formText(f, 'creditLimit')) || undefined, priceListId: formText(f, 'priceListId') || undefined } }))}>
            <Field id="tm-limit" label={t('creditLimit')}><Input id="tm-limit" name="creditLimit" inputMode="decimal" dir="ltr" defaultValue={s.creditLimit} /></Field>
            <Field id="tm-list" label={t('priceList')}>
              <Select id="tm-list" name="priceListId" defaultValue={s.priceList.id}>
                {(options.data?.priceLists ?? [s.priceList]).map((l) => <option key={l.id} value={l.id}>{format.name(l)}</option>)}
              </Select>
            </Field>
            <div className="flex items-end gap-2">
              <Button type="submit" disabled={act.isPending}>{tc('save')}</Button>
              {s.status === 'ACTIVE' || s.status === 'INACTIVE' ? (
                <Button variant="ghost" onClick={() => act.run({ path: '/status', method: 'POST', body: { version: s.version, active: s.status !== 'ACTIVE' } })}>
                  {s.status === 'ACTIVE' ? tc('deactivate') : tc('activate')}
                </Button>
              ) : null}
            </div>
          </form>
        ) : null}
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title={t('accountManager')}>
          <Table head={[t('seller'), t('from'), t('to')]}>
            {s.assignments.map((a, i) => (
              <tr key={i}><Cell>{a.name}</Cell><Cell>{format.dateTime(a.startedAt)}</Cell><Cell>{a.endedAt ? format.dateTime(a.endedAt) : t('current')}</Cell></tr>
            ))}
          </Table>
          {can.reassign ? (
            <form className="flex flex-wrap items-end gap-2 border-t border-stone-200 p-5" noValidate
              onSubmit={form((f) => act.run({ path: '/reassign', method: 'POST', body: { sellerId: formText(f, 'sellerId'), note: formText(f, 'note') || null } }))}>
              <Field id="ra-seller" label={t('reassignTo')}>
                <Select id="ra-seller" name="sellerId" defaultValue="">
                  <option value="">{tc('choose')}</option>
                  {(sellers.data ?? []).filter((x) => x.id !== s.seller?.id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </Select>
              </Field>
              <Field id="ra-note" label={t('note')}><Input id="ra-note" name="note" maxLength={300} /></Field>
              <Button type="submit" variant="secondary" disabled={act.isPending}>{t('reassign')}</Button>
            </form>
          ) : null}
        </Section>

        {can.adjust ? (
          <Section title={t('adjust')} description={t('adjustHint')}>
            <form className="grid gap-3 p-5 sm:grid-cols-2" noValidate
              onSubmit={form((f) => act.run({ path: '/adjustments', method: 'POST', body: { amount: decimalText(formText(f, 'amount')), reason: formText(f, 'reason'), dueOn: formText(f, 'dueOn') || null } }))}>
              <Field id="adj-amount" label={t('adjustAmount')}><Input id="adj-amount" name="amount" inputMode="decimal" dir="ltr" /></Field>
              <Field id="adj-due" label={t('adjustDueOn')} hint={t('optional')}><Input id="adj-due" name="dueOn" type="date" dir="ltr" /></Field>
              <div className="sm:col-span-2"><Field id="adj-reason" label={t('adjustReason')}><Input id="adj-reason" name="reason" maxLength={500} /></Field></div>
              <div><Button type="submit" variant="secondary" disabled={act.isPending}>{t('postAdjustment')}</Button></div>
            </form>
          </Section>
        ) : null}
      </div>

      <Section title={t('ledger')}>
        {ledger.data && ledger.data.length > 0 ? <LedgerSummary entries={ledger.data} credit={s.credit} /> : null}
        <LedgerTable entries={ledger.data ?? []} />
      </Section>
    </div>
  );
}
