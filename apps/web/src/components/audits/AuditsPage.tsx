'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, Badge, Button, Card, Field, Select } from '@gsa/ui';
import { PageHeader } from '@/components/common/PageHeader';
import { Cell, Table } from '@/components/common/Table';
import { Section } from '@/components/common/Section';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useErrorText, useOnceCommand } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import type { AuditSummary, OverdueVehicle, VehicleAudit } from './types';

type Vehicle = { id: string; registration: string; status: string };

/**
 * Workflow N (VEH-011, VEH-015): the audits done so far, the vehicles that
 * are due one, and the way to start counting.
 */
export function AuditsPage({ overdue, canAudit }: { overdue: readonly OverdueVehicle[]; canAudit: boolean }) {
  const t = useTranslations('audits');
  const format = useFormat();
  const errorText = useErrorText();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [vehicleId, setVehicleId] = useState('');
  const audits = useQuery({ queryKey: keys.audits(), queryFn: () => api<{ items: AuditSummary[] }>('/vehicle-audits') });
  const vehicles = useQuery({ queryKey: keys.vehicles, queryFn: () => api<Vehicle[]>('/vehicles'), enabled: canAudit });
  const start = useOnceCommand((body: unknown, key) => api<VehicleAudit>('/vehicle-audits', { method: 'POST', body, idempotencyKey: key }), {
    onSuccess: (a) => { void queryClient.invalidateQueries({ queryKey: keys.audits() }); router.push(`/console/audits/${a.id}`); },
  });
  const active = (vehicles.data ?? []).filter((v) => v.status === 'ACTIVE');

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title={t('listTitle')} subtitle={t('listSubtitle')} />

      {overdue.length > 0 ? (
        <Card className="border-amber-200 bg-amber-50 p-4 text-sm text-amber-900" data-testid="overdue">
          <p className="font-semibold">{t('overdueTitle', { count: overdue.length })}</p>
          <ul className="mt-1 space-y-1">
            {overdue.map((v) => (
              <li key={v.id} data-testid={`overdue-${v.registration}`}>
                <bdi dir="ltr">{v.registration}</bdi>
                {v.seller ? ` · ${v.seller.name}` : ''}
                {` · ${v.lastAuditedAt ? t('lastAudited', { time: format.dateTime(v.lastAuditedAt) }) : t('neverAudited')}`}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {canAudit ? (
        <Card className="flex flex-wrap items-end gap-3 p-4">
          <Field id="vehicle" label={t('vehicle')}>
            <Select id="vehicle" value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
              <option value="">{t('chooseVehicle')}</option>
              {active.map((v) => <option key={v.id} value={v.id}>{v.registration}</option>)}
            </Select>
          </Field>
          <Button disabled={!vehicleId || start.isPending} onClick={() => start.run({ vehicleId, note: null })}>{t('startAudit')}</Button>
          {start.error ? <Alert>{errorText(start.error)}</Alert> : null}
        </Card>
      ) : null}

      <Section title={t('doneTitle')}>
        {audits.data?.items.length === 0 ? <p className="p-5 text-sm text-stone-500">{t('none')}</p> : (
          <Table head={[t('number'), t('vehicle'), t('sellerHead'), t('opened'), t('statusHead'), t('differences')]}>
            {audits.data?.items.map((a) => (
              <tr key={a.id} data-testid={`audit-${a.number}`}>
                <Cell><Link href={`/console/audits/${a.id}`} className="font-medium underline"><bdi dir="ltr">{a.number}</bdi></Link></Cell>
                <Cell><bdi dir="ltr">{a.vehicle.registration}</bdi></Cell>
                <Cell>{a.seller?.name ?? '—'}</Cell>
                <Cell>{format.dateTime(a.openedAt)}</Cell>
                <Cell><Badge tone={a.status === 'IN_PROGRESS' ? 'warning' : 'success'}>{t(`statuses.${a.status}`)}</Badge></Cell>
                <Cell>{t('differenceCount', { shortfalls: a.shortfalls, surpluses: a.surpluses })}</Cell>
              </tr>
            ))}
          </Table>
        )}
      </Section>
    </div>
  );
}
