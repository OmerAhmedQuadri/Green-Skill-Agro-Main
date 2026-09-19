'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Card, Checkbox, Field, Input, Select } from '@gsa/ui';
import type { attendance } from '@gsa/services';
import { PageHeader } from '@/components/common/PageHeader';
import { Section } from '@/components/common/Section';
import { Cell, Table } from '@/components/common/Table';
import type { Seller } from '@/components/vehicles/types';
import { api } from '@/lib/api';
import { useDuration } from '@/lib/duration';
import { useFormat } from '@/lib/format';
import { formText, wholeNumber } from '@/lib/forms';
import { useCommand, useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';

type Day = attendance.AttendanceDay;
const riyadhToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date());

/**
 * Attendance (ATT-002, 005, 006, 009, 011, 012): each seller's day — sessions,
 * active hours less breaks, distance from the odometer — and what needs a
 * manager: a check-in outside the zone, a doubtful odometer reading, a missed
 * check-in to open on the seller's behalf.
 */
export function AttendancePage({ canManage }: { canManage: boolean }) {
  const t = useTranslations();
  const format = useFormat();
  const duration = useDuration();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState({ from: riyadhToday(), to: riyadhToday(), sellerId: '', attention: false });
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const days = useQuery({
    queryKey: keys.attendance(filter),
    queryFn: () => {
      const qs = new URLSearchParams({ from: filter.from, to: filter.to });
      if (filter.sellerId) qs.set('sellerId', filter.sellerId);
      if (filter.attention) qs.set('attention', 'true');
      return api<Day[]>(`/attendance?${qs.toString()}`);
    },
    refetchInterval: 60_000,
  });
  const sellers = useQuery({ queryKey: keys.sellers, queryFn: () => api<Seller[]>('/sellers') });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: keys.attendance() });
  const authorise = useCommand((id: string, key) => api(`/attendance/sessions/${id}/authorise-zone`, { method: 'POST', body: {}, idempotencyKey: key }), { onSuccess: refresh });
  const review = useCommand(({ id, comment }: { id: string; comment: string }, key) => api(`/attendance/sessions/${id}/review`, { method: 'POST', body: { comment }, idempotencyKey: key }),
    { onSuccess: () => { setReviewing(null); refresh(); } });
  const open = useCommand((body: unknown, key) => api('/attendance/days', { method: 'POST', body, idempotencyKey: key }), { onSuccess: () => { setOpening(false); refresh(); } });
  const error = authorise.error ?? review.error;

  const openDay = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const odometer = formText(f, 'odometer');
    open.run({ sellerId: formText(f, 'sellerId'), reason: formText(f, 'reason'), odometer: wholeNumber(odometer) });
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title={t('attendance.title')} subtitle={t('attendance.subtitle')}
        actions={canManage && !opening ? <Button variant="secondary" onClick={() => setOpening(true)}>{t('attendance.openOnBehalf')}</Button> : undefined} />

      {opening ? (
        <Section title={t('attendance.openOnBehalf')} description={t('attendance.openOnBehalfHint')}>
          <form className="grid gap-4 p-5 sm:grid-cols-3" noValidate onSubmit={openDay}>
            {open.error ? <Alert className="sm:col-span-3">{errorText(open.error)}</Alert> : null}
            <Field id="od-seller" label={t('vehicles.seller')}>
              <Select id="od-seller" name="sellerId" defaultValue="">
                <option value="">{t('common.choose')}</option>
                {(sellers.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </Field>
            <Field id="od-reason" label={t('attendance.reason')}><Input id="od-reason" name="reason" maxLength={500} /></Field>
            <Field id="od-odometer" label={t('attendance.odometerOptional')}><Input id="od-odometer" name="odometer" inputMode="numeric" dir="ltr" /></Field>
            <div className="flex gap-2 sm:col-span-3">
              <Button type="submit" disabled={open.isPending}>{t('attendance.openDay')}</Button>
              <Button variant="ghost" onClick={() => setOpening(false)}>{t('common.cancel')}</Button>
            </div>
          </form>
        </Section>
      ) : null}

      <Card>
        <div className="flex flex-wrap items-end gap-3 border-b border-stone-200 p-4">
          <Field id="at-from" label={t('attendance.from')}><Input id="at-from" type="date" value={filter.from} onChange={(e) => setFilter({ ...filter, from: e.target.value })} dir="ltr" /></Field>
          <Field id="at-to" label={t('attendance.to')}><Input id="at-to" type="date" value={filter.to} onChange={(e) => setFilter({ ...filter, to: e.target.value })} dir="ltr" /></Field>
          <Field id="at-seller" label={t('vehicles.seller')}>
            <Select id="at-seller" value={filter.sellerId} onChange={(e) => setFilter({ ...filter, sellerId: e.target.value })}>
              <option value="">{t('common.all')}</option>
              {(sellers.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
          <label className="flex h-11 items-center gap-2 text-sm">
            <Checkbox checked={filter.attention} onChange={(e) => setFilter({ ...filter, attention: e.target.checked })} />{t('attendance.needsAttention')}
          </label>
        </div>
        {days.error ? <div className="p-4"><Alert>{errorText(days.error)}</Alert></div> : null}
        {error ? <div className="p-4"><Alert>{errorText(error)}</Alert></div> : null}
        {days.data?.length === 0 ? <p className="p-5 text-sm text-stone-500">{t('attendance.none')}</p> : null}
        {days.data && days.data.length > 0 ? (
          <Table head={[t('attendance.date'), t('vehicles.seller'), t('attendance.sessions'), t('attendance.hours'), t('attendance.distance'), t('common.status')]}>
            {days.data.map((d) => (
              <tr key={d.id} data-testid={`day-${d.seller.name}`}>
                <Cell>{format.date(d.workDate)}</Cell>
                <Cell>
                  {d.seller.name}
                  <div className="text-xs text-stone-500">{d.vehicle ? <bdi dir="ltr">{d.vehicle.registration}</bdi> : t('attendance.noVehicle')}</div>
                  {d.openedOnBehalf ? <Badge className="mt-1">{t('attendance.onBehalf')}</Badge> : null}
                </Cell>
                <Cell>
                  <ul className="space-y-2">
                    {d.sessions.map((s) => (
                      <li key={s.id}>
                        <span>{`${format.dateTime(s.checkedInAt)} – ${s.checkedOutAt ? format.dateTime(s.checkedOutAt) : '…'}`}</span>
                        {s.checkInOdometer !== null ? <span className="text-xs text-stone-500">{` · ${t('vehicles.km', { km: format.number(s.checkInOdometer) })}${s.checkOutOdometer !== null ? ` → ${format.number(s.checkOutOdometer)}` : ''}`}</span> : null}
                        {s.breaks.length > 0 ? <span className="text-xs text-stone-500">{` · ${t('attendance.breaks', { count: s.breaks.length })}`}</span> : null}
                        <div className="mt-1 flex flex-wrap gap-1">
                          {s.awaitingAuthorisation ? <Badge tone="warning">{t('attendance.outsideZone')}</Badge> : null}
                          {s.flags.map((f) => <Badge key={f} tone={s.reviewed ? 'neutral' : 'danger'}>{t(`attendance.flags.${f}`)}</Badge>)}
                          {s.onBehalfReason ? <span className="text-xs text-stone-500">{s.onBehalfReason}</span> : null}
                          {s.reviewComment ? <span className="text-xs text-stone-500">{s.reviewComment}</span> : null}
                        </div>
                        <div className="mt-1 flex flex-wrap gap-2 text-xs">
                          {(Object.entries(s.photos) as [keyof typeof s.photos, string | null][]).filter(([, id]) => id).map(([k, id]) => (
                            <a key={k} href={`/api/v1/media/${id}`} target="_blank" rel="noreferrer" className="text-brand-800 hover:underline">{t(`attendance.photos.${k}`)}</a>
                          ))}
                        </div>
                        {canManage && s.awaitingAuthorisation ? <Button size="sm" className="mt-1" onClick={() => authorise.run(s.id)} disabled={authorise.isPending}>{t('attendance.authorise')}</Button> : null}
                        {canManage && s.flags.length > 0 && !s.reviewed && reviewing !== s.id ? <Button size="sm" variant="secondary" className="mt-1" onClick={() => setReviewing(s.id)}>{t('attendance.review')}</Button> : null}
                        {reviewing === s.id ? (
                          <form className="mt-2 flex flex-wrap items-end gap-2" noValidate onSubmit={(e: FormEvent<HTMLFormElement>) => {
                            e.preventDefault();
                            review.run({ id: s.id, comment: formText(new FormData(e.currentTarget), 'comment') });
                          }}>
                            <Field id={`rv-${s.id}`} label={t('attendance.reviewComment')}><Input id={`rv-${s.id}`} name="comment" maxLength={500} /></Field>
                            <Button type="submit" size="sm" disabled={review.isPending}>{t('attendance.markReviewed')}</Button>
                          </form>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </Cell>
                <Cell>
                  {duration(d.totals.activeMs)}
                  {d.attribution ? <div className="mt-1 text-xs text-stone-500">{d.attribution.map((a) => t('attendance.split', { date: format.date(a.date), hours: duration(a.activeMs), km: a.distanceKm ?? '—' })).join(' · ')}</div> : null}
                </Cell>
                <Cell>{d.totals.distanceKm === null ? '—' : t('vehicles.km', { km: format.number(d.totals.distanceKm) })}</Cell>
                <Cell><Badge tone={d.status === 'OPEN' ? 'success' : d.status === 'ON_BREAK' ? 'warning' : 'neutral'}>{t(`attendance.statuses.${d.status}`)}</Badge></Cell>
              </tr>
            ))}
          </Table>
        ) : null}
      </Card>
    </div>
  );
}
