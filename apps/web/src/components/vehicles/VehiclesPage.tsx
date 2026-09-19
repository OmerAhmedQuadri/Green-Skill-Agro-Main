'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Card, Field, Input } from '@gsa/ui';
import { PageHeader } from '@/components/common/PageHeader';
import { Section } from '@/components/common/Section';
import { Cell, Table } from '@/components/common/Table';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { formText } from '@/lib/forms';
import { useCommand, useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import type { Vehicle, VehicleListItem } from './types';

/**
 * VEH-001, STK-006: the vehicle register — each vehicle, the seller
 * accountable for it, its odometer, and the stock it carries.
 */
export function VehiclesPage({ canManage }: { canManage: boolean }) {
  const t = useTranslations();
  const format = useFormat();
  const errorText = useErrorText();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const list = useQuery({ queryKey: keys.vehicles, queryFn: () => api<VehicleListItem[]>('/vehicles') });
  const create = useCommand((body: unknown, key) => api<Vehicle>('/vehicles', { method: 'POST', body, idempotencyKey: key }), {
    onSuccess: (v) => { void queryClient.invalidateQueries({ queryKey: keys.vehicles }); router.push(`/console/vehicles/${v.id}`); },
  });
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const odometer = formText(f, 'odometer');
    create.run({ registration: formText(f, 'registration'), description: formText(f, 'description') || null, odometer: /^\d+$/.test(odometer) ? Number.parseInt(odometer, 10) : -1 });
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title={t('vehicles.title')} subtitle={t('vehicles.subtitle')}
        actions={canManage && !adding ? <Button onClick={() => setAdding(true)}>{t('vehicles.add')}</Button> : undefined} />
      {adding ? (
        <Section title={t('vehicles.add')}>
          <form className="grid gap-4 p-5 sm:grid-cols-3" noValidate onSubmit={submit}>
            {create.error ? <Alert className="sm:col-span-3">{errorText(create.error)}</Alert> : null}
            <Field id="v-registration" label={t('vehicles.registration')}><Input id="v-registration" name="registration" dir="ltr" required maxLength={20} /></Field>
            <Field id="v-description" label={t('vehicles.description')}><Input id="v-description" name="description" maxLength={200} /></Field>
            <Field id="v-odometer" label={t('vehicles.odometerKm')}><Input id="v-odometer" name="odometer" inputMode="numeric" dir="ltr" required /></Field>
            <div className="flex gap-2 sm:col-span-3">
              <Button type="submit" disabled={create.isPending}>{create.isPending ? t('common.saving') : t('vehicles.create')}</Button>
              <Button variant="ghost" onClick={() => setAdding(false)}>{t('common.cancel')}</Button>
            </div>
          </form>
        </Section>
      ) : null}
      <Card>
        {list.error ? <div className="p-4"><Alert>{errorText(list.error)}</Alert></div> : null}
        {list.isPending ? <p className="p-5 text-sm text-stone-500">{t('common.loading')}</p> : null}
        {list.data?.length === 0 ? <p className="p-5 text-sm text-stone-500">{t('vehicles.none')}</p> : null}
        {list.data && list.data.length > 0 ? (
          <Table head={[t('vehicles.registration'), t('vehicles.seller'), t('vehicles.odometer'), t('vehicles.packs'), t('vehicles.value'), t('common.status')]}>
            {list.data.map((v) => (
              <tr key={v.id}>
                <Cell>
                  <Link href={`/console/vehicles/${v.id}`} className="font-medium text-brand-800 hover:underline"><bdi dir="ltr">{v.registration}</bdi></Link>
                  {v.description ? <div className="text-xs text-stone-500">{v.description}</div> : null}
                </Cell>
                <Cell>{v.seller?.name ?? <span className="text-stone-400">{t('vehicles.unassigned')}</span>}</Cell>
                <Cell>{v.odometer === null ? '—' : t('vehicles.km', { km: format.number(v.odometer) })}</Cell>
                <Cell>{format.number(v.packs)}</Cell>
                <Cell>{format.money(v.value)}</Cell>
                <Cell>
                  <Badge tone={v.status === 'ACTIVE' ? 'success' : 'neutral'}>{t(`vehicles.statuses.${v.status}`)}</Badge>
                  {v.outstandingLoads > 0 ? <Badge tone="warning" className="ms-1">{t('vehicles.loadsWaiting', { count: v.outstandingLoads })}</Badge> : null}
                  {v.handoverPending ? <Badge tone="warning" className="ms-1">{t('vehicles.handoverPending')}</Badge> : null}
                </Cell>
              </tr>
            ))}
          </Table>
        ) : null}
      </Card>
    </div>
  );
}
