'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Field, Input, Select } from '@gsa/ui';
import { PageHeader } from '@/components/common/PageHeader';
import { Facts, Section } from '@/components/common/Section';
import { Cell, Table } from '@/components/common/Table';
import { api, ApiError } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { formText } from '@/lib/forms';
import { useCommand, useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import { LoadBuilder } from './LoadBuilder';
import { LOAD_TONE, RETURN_REASONS, type Load, type Seller, type Vehicle, type VehicleReturn } from './types';

const whole = (v: string) => (/^\d+$/.test(v) ? Number.parseInt(v, 10) : 0);
type Can = { manage: boolean; issue: boolean };

/**
 * One vehicle (VEH-001..010, STK-006, STK-012): who holds it, what it
 * carries, loads issued to it, stock sent back, and its history.
 */
export function VehicleDetail({ id, can }: { id: string; can: Can }) {
  const t = useTranslations();
  const format = useFormat();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const [panel, setPanel] = useState<'load' | 'return' | 'edit' | null>(null);
  const vehicle = useQuery({ queryKey: keys.vehicle(id), queryFn: () => api<Vehicle>(`/vehicles/${id}`) });
  const loads = useQuery({ queryKey: keys.loads({ vehicleId: id }), queryFn: () => api<Load[]>(`/vehicle-loads?vehicleId=${id}`), enabled: can.issue });
  const returns = useQuery({ queryKey: keys.vehicleReturns(id), queryFn: () => api<VehicleReturn[]>(`/vehicles/${id}/returns`) });
  const refresh = () => {
    for (const key of [keys.vehicle(id), keys.loads(), keys.vehicleReturns(id), keys.vehicles, keys.sellers]) void queryClient.invalidateQueries({ queryKey: key });
  };

  if (vehicle.isPending) return <p className="text-sm text-stone-500">{t('common.loading')}</p>;
  if (vehicle.error) return <Alert>{errorText(vehicle.error)}</Alert>;
  const v = vehicle.data;
  const canLoad = can.issue && v.status === 'ACTIVE' && v.seller !== null && v.pendingHandover === null;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title={<bdi dir="ltr">{v.registration}</bdi>} subtitle={v.description ?? undefined} back={{ href: '/console/vehicles', label: t('vehicles.title') }}
        actions={(
          <div className="flex flex-wrap gap-2">
            {canLoad && panel !== 'load' ? <Button onClick={() => setPanel('load')}>{t('vehicles.newLoad')}</Button> : null}
            {can.issue && v.packs > 0 && panel !== 'return' ? <Button variant="secondary" onClick={() => setPanel('return')}>{t('vehicles.returnStock')}</Button> : null}
            {can.manage && panel !== 'edit' ? <Button variant="ghost" onClick={() => setPanel('edit')}>{t('common.edit')}</Button> : null}
          </div>
        )} />

      <Section title={t('vehicles.summary')}>
        <Facts items={[
          { label: t('common.status'), value: <Badge tone={v.status === 'ACTIVE' ? 'success' : 'neutral'}>{t(`vehicles.statuses.${v.status}`)}</Badge> },
          { label: t('vehicles.seller'), value: v.seller ? t('vehicles.sellerSince', { name: v.seller.name, date: format.dateTime(v.seller.since) }) : t('vehicles.unassigned') },
          { label: t('vehicles.odometer'), value: v.odometer === null ? '—' : t('vehicles.km', { km: format.number(v.odometer) }) },
          { label: t('vehicles.stockValue'), value: t('vehicles.packsAndValue', { packs: format.number(v.packs), value: format.money(v.value) }) },
        ]} />
      </Section>

      {panel === 'edit' ? <EditVehicle vehicle={v} onDone={() => { setPanel(null); refresh(); }} /> : null}
      {panel === 'load' ? <LoadBuilder vehicleId={v.id} onDone={() => { setPanel(null); refresh(); }} /> : null}
      {panel === 'return' ? <ReturnForm vehicle={v} onDone={() => { setPanel(null); refresh(); }} /> : null}

      {can.manage ? <Assignment vehicle={v} onChange={refresh} /> : null}

      <Section title={t('vehicles.stockOnBoard')}>
        {v.batches.length === 0 ? <p className="p-5 text-sm text-stone-500">{t('vehicles.empty')}</p> : (
          <Table head={[t('catalogue.skuCode'), t('receiving.lotNumber'), t('receiving.expiresOn'), t('vehicles.packs'), t('vehicles.basePrice')]}>
            {v.batches.map((b) => (
              <tr key={b.batchId}>
                <Cell><bdi dir="ltr" className="font-mono">{b.code}</bdi><div className="text-xs text-stone-500">{format.name(b.product)}</div></Cell>
                <Cell><bdi dir="ltr">{b.lotNumber ?? '—'}</bdi></Cell>
                <Cell>{b.expiresOn ? format.date(b.expiresOn) : '—'}</Cell>
                <Cell>{format.number(b.packs)}{b.heldPacks > 0 ? <div className="text-xs text-amber-800">{t('vehicles.heldPacks', { count: b.heldPacks })}</div> : null}</Cell>
                <Cell>{b.unitPrice === null ? <Badge tone="warning">{t('vehicles.unpriced')}</Badge> : format.money(b.unitPrice)}</Cell>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      {can.issue ? <Loads loads={loads.data ?? []} onChange={refresh} /> : null}

      <Section title={t('vehicles.returns')}>
        {(returns.data ?? []).length === 0 ? <p className="p-5 text-sm text-stone-500">{t('vehicles.noReturns')}</p> : (
          <Table head={[t('warehouse.number'), t('vehicles.reason'), t('vehicles.lines'), t('vehicles.recorded')]}>
            {(returns.data ?? []).map((r) => (
              <tr key={r.id}>
                <Cell><bdi dir="ltr" className="font-mono">{r.number}</bdi></Cell>
                <Cell>{t(`vehicles.returnReasons.${r.reason}`)}{r.note ? <div className="text-xs text-stone-500">{r.note}</div> : null}</Cell>
                <Cell>{r.lines.map((l) => <div key={l.batchId}><bdi dir="ltr" className="font-mono">{l.code}</bdi>{` · ${format.number(l.packs)}`}</div>)}</Cell>
                <Cell>{r.recordedBy}<div className="text-xs text-stone-500">{format.dateTime(r.recordedAt)}</div></Cell>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title={t('vehicles.assignmentHistory')}>
          <Table head={[t('vehicles.seller'), t('vehicles.from'), t('vehicles.to')]}>
            {v.assignments.map((a, i) => (
              <tr key={i}><Cell>{a.name}</Cell><Cell>{format.dateTime(a.startedAt)}</Cell><Cell>{a.endedAt ? format.dateTime(a.endedAt) : t('vehicles.current')}</Cell></tr>
            ))}
          </Table>
        </Section>
        <Section title={t('vehicles.readings')}>
          <Table head={[t('vehicles.odometer'), t('vehicles.source'), t('vehicles.recorded')]}>
            {v.readings.map((r, i) => (
              <tr key={i}>
                <Cell>{t('vehicles.km', { km: format.number(r.readingKm) })}</Cell>
                <Cell>{t(`vehicles.sources.${r.source}`)}{r.note ? <div className="text-xs text-stone-500">{r.note}</div> : null}</Cell>
                <Cell>{format.dateTime(r.recordedAt)}</Cell>
              </tr>
            ))}
          </Table>
        </Section>
      </div>
    </div>
  );
}

/** VEH-002, 009, 010: assign, hand over with stock, or release an empty vehicle. */
function Assignment({ vehicle: v, onChange }: { vehicle: Vehicle; onChange: () => void }) {
  const t = useTranslations();
  const format = useFormat();
  const errorText = useErrorText();
  const [outcome, setOutcome] = useState<string | null>(null);
  const sellers = useQuery({ queryKey: keys.sellers, queryFn: () => api<Seller[]>('/sellers') });
  const assign = useCommand((sellerId: string, key) => api<{ outcome: 'ASSIGNED' | 'HANDOVER_PROPOSED' }>(`/vehicles/${v.id}/assign`, { method: 'POST', body: { sellerId }, idempotencyKey: key }), {
    onSuccess: (r) => { setOutcome(r.outcome); onChange(); },
  });
  const unassign = useCommand((_: null, key) => api(`/vehicles/${v.id}/unassign`, { method: 'POST', body: {}, idempotencyKey: key }), { onSuccess: onChange });
  const cancel = useCommand((body: { id: string; version: number; reason: string }, key) =>
    api(`/vehicle-handovers/${body.id}/cancel`, { method: 'POST', body: { version: body.version, reason: body.reason }, idempotencyKey: key }), { onSuccess: onChange });
  const error = assign.error ?? unassign.error ?? cancel.error;
  const h = v.pendingHandover;

  return (
    <Section title={t('vehicles.assignment')} description={v.packs > 0 && v.seller ? t('vehicles.handoverHint') : undefined}>
      <div className="space-y-4 p-5">
        {error ? <Alert>{errorText(error)}</Alert> : null}
        {outcome ? <Alert tone="success">{t(outcome === 'ASSIGNED' ? 'vehicles.assigned' : 'vehicles.handoverProposed')}</Alert> : null}
        {h ? (
          <div className="space-y-3 rounded-md border border-amber-200 bg-amber-50 p-4 text-sm" data-testid="pending-handover">
            <p className="font-medium">{t('vehicles.handoverFromTo', { from: h.outgoing.name, to: h.incoming.name })}</p>
            <p>{t('vehicles.handoverConfirmations', {
              outgoing: h.outgoing.confirmedAt ? format.dateTime(h.outgoing.confirmedAt) : t('vehicles.notYet'),
              incoming: h.incoming.confirmedAt ? format.dateTime(h.incoming.confirmedAt) : t('vehicles.notYet'),
            })}</p>
            <form className="flex flex-wrap items-end gap-2" noValidate onSubmit={(e: FormEvent<HTMLFormElement>) => {
              e.preventDefault();
              cancel.run({ id: h.id, version: h.version, reason: formText(new FormData(e.currentTarget), 'reason') });
            }}>
              <Field id="ho-reason" label={t('vehicles.cancelReason')}><Input id="ho-reason" name="reason" maxLength={500} /></Field>
              <Button type="submit" variant="danger" disabled={cancel.isPending}>{t('vehicles.cancelHandover')}</Button>
            </form>
          </div>
        ) : (
          <form className="flex flex-wrap items-end gap-2" noValidate onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            assign.run(formText(new FormData(e.currentTarget), 'sellerId'));
          }}>
            <Field id="assign-seller" label={v.seller ? t('vehicles.reassignTo') : t('vehicles.assignTo')}>
              <Select id="assign-seller" name="sellerId" defaultValue="" disabled={v.status !== 'ACTIVE'}>
                <option value="">{t('common.choose')}</option>
                {(sellers.data ?? []).filter((s) => s.id !== v.seller?.id).map((s) => (
                  <option key={s.id} value={s.id} disabled={s.vehicle !== null}>{s.vehicle ? t('vehicles.sellerHolds', { name: s.name, registration: s.vehicle.registration }) : s.name}</option>
                ))}
              </Select>
            </Field>
            <Button type="submit" disabled={assign.isPending || v.status !== 'ACTIVE'}>{v.seller ? t('vehicles.reassign') : t('vehicles.assign')}</Button>
            {v.seller && v.packs === 0 && v.outstandingLoads === 0
              ? <Button variant="ghost" onClick={() => unassign.run(null)} disabled={unassign.isPending}>{t('vehicles.unassign')}</Button> : null}
          </form>
        )}
      </div>
    </Section>
  );
}

/** VEH-001, VEH-004: description and status; a corrected odometer is a new reading with a note. */
function EditVehicle({ vehicle: v, onDone }: { vehicle: Vehicle; onDone: () => void }) {
  const t = useTranslations();
  const errorText = useErrorText();
  const save = useCommand((body: unknown, key) => api(`/vehicles/${v.id}`, { method: 'PATCH', body, idempotencyKey: key }), { onSuccess: onDone });
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const odometer = formText(f, 'odometer');
    save.run({
      version: v.version, description: formText(f, 'description') || null, status: formText(f, 'status'),
      ...(odometer ? { odometer: whole(odometer), odometerNote: formText(f, 'odometerNote') } : {}),
    });
  };
  return (
    <Section title={t('common.edit')}>
      <form className="grid gap-4 p-5 sm:grid-cols-2" noValidate onSubmit={submit}>
        {save.error ? <Alert className="sm:col-span-2">{errorText(save.error)}</Alert> : null}
        <Field id="ev-description" label={t('vehicles.description')}><Input id="ev-description" name="description" defaultValue={v.description ?? ''} maxLength={200} /></Field>
        <Field id="ev-status" label={t('common.status')}>
          <Select id="ev-status" name="status" defaultValue={v.status}>
            {(['ACTIVE', 'MAINTENANCE', 'RETIRED'] as const).map((s) => <option key={s} value={s}>{t(`vehicles.statuses.${s}`)}</option>)}
          </Select>
        </Field>
        <Field id="ev-odometer" label={t('vehicles.correctOdometer')}><Input id="ev-odometer" name="odometer" inputMode="numeric" dir="ltr" /></Field>
        <Field id="ev-note" label={t('vehicles.correctionNote')}><Input id="ev-note" name="odometerNote" maxLength={300} /></Field>
        <div className="flex gap-2 sm:col-span-2">
          <Button type="submit" disabled={save.isPending}>{save.isPending ? t('common.saving') : t('common.save')}</Button>
          <Button variant="ghost" onClick={onDone}>{t('common.cancel')}</Button>
        </div>
      </form>
    </Section>
  );
}

/** STK-012: stock back to the warehouse, with its reason; posted as it arrives. */
function ReturnForm({ vehicle: v, onDone }: { vehicle: Vehicle; onDone: () => void }) {
  const t = useTranslations();
  const format = useFormat();
  const errorText = useErrorText();
  const send = useCommand((body: unknown, key) => api('/vehicle-returns', { method: 'POST', body, idempotencyKey: key }), { onSuccess: onDone });
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    send.run({
      vehicleId: v.id, reason: formText(f, 'reason'), note: formText(f, 'note') || null,
      lines: v.batches.map((b) => ({ batchId: b.batchId, packs: whole(formText(f, `back-${b.batchId}`)) })).filter((l) => l.packs > 0),
    });
  };
  return (
    <Section title={t('vehicles.returnStock')} description={t('vehicles.returnHint')}>
      <form noValidate onSubmit={submit}>
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          {send.error ? <Alert className="sm:col-span-2">{errorText(send.error)}</Alert> : null}
          <Field id="ret-reason" label={t('vehicles.reason')}>
            <Select id="ret-reason" name="reason" defaultValue="MANAGER_RECALL">
              {RETURN_REASONS.map((r) => <option key={r} value={r}>{t(`vehicles.returnReasons.${r}`)}</option>)}
            </Select>
          </Field>
          <Field id="ret-note" label={t('warehouse.note')}><Input id="ret-note" name="note" maxLength={500} /></Field>
        </div>
        <Table head={[t('catalogue.skuCode'), t('receiving.lotNumber'), t('vehicles.onVehicle'), t('vehicles.packsBack')]}>
          {v.batches.map((b) => (
            <tr key={b.batchId}>
              <Cell><bdi dir="ltr" className="font-mono">{b.code}</bdi></Cell>
              <Cell><bdi dir="ltr">{b.lotNumber ?? '—'}</bdi></Cell>
              <Cell>{format.number(b.packs - b.heldPacks)}</Cell>
              <Cell><Input aria-label={t('vehicles.packsBackFor', { lot: b.lotNumber ?? '—' })} name={`back-${b.batchId}`} inputMode="numeric" dir="ltr" className="w-24" /></Cell>
            </tr>
          ))}
        </Table>
        <div className="flex gap-2 p-5">
          <Button type="submit" disabled={send.isPending}>{send.isPending ? t('common.saving') : t('vehicles.recordReturn')}</Button>
          <Button variant="ghost" onClick={onDone}>{t('common.cancel')}</Button>
        </div>
      </form>
    </Section>
  );
}

/** VEH-007: loads issued to this vehicle — amend a disputed one, or cancel. */
function Loads({ loads, onChange }: { loads: Load[]; onChange: () => void }) {
  const t = useTranslations();
  const format = useFormat();
  const errorText = useErrorText();
  const [editing, setEditing] = useState<{ id: string; mode: 'amend' | 'cancel' } | null>(null);
  const [pending, setPending] = useState<{ id: string; action: 'amend' | 'cancel'; body: Record<string, unknown> } | null>(null);
  const act = useCommand(({ id, action, body }: { id: string; action: 'amend' | 'cancel'; body: object }, key) =>
    api<Load>(`/vehicle-loads/${id}/${action}`, { method: 'POST', body, idempotencyKey: key }), { onSuccess: () => { setEditing(null); setPending(null); onChange(); } });
  const run = (next: { id: string; action: 'amend' | 'cancel'; body: Record<string, unknown> }) => { setPending(next); act.run(next); };
  // VEH-006: an amended load over the ceiling warns too, and goes ahead only when acknowledged.
  const overCeiling = act.error instanceof ApiError && act.error.code === 'CEILING_WARNING';

  return (
    <Section title={t('vehicles.loads')}>
      {overCeiling && pending ? (
        <div className="flex flex-wrap items-center gap-3 p-4">
          <Alert tone="warning" className="flex-1">{t('vehicles.ceilingWarningShort')}</Alert>
          <Button variant="danger" onClick={() => run({ ...pending, body: { ...pending.body, acknowledgeCeiling: true } })} disabled={act.isPending}>{t('vehicles.issueAnyway')}</Button>
        </div>
      ) : act.error ? <div className="p-4"><Alert>{errorText(act.error)}</Alert></div> : null}
      {loads.length === 0 ? <p className="p-5 text-sm text-stone-500">{t('vehicles.noLoads')}</p> : (
        <ul className="divide-y divide-stone-100">
          {loads.map((l) => (
            <li key={l.id} className="space-y-2 p-5 text-sm" data-testid={`console-load-${l.number}`}>
              <div className="flex flex-wrap items-center gap-2">
                <bdi dir="ltr" className="font-mono font-medium">{l.number}</bdi>
                <Badge tone={LOAD_TONE[l.status]}>{t(`vehicles.loadStatuses.${l.status}`)}</Badge>
                <span className="text-stone-600">{t('vehicles.issuedBy', { name: l.issuedBy, date: format.dateTime(l.issuedAt) })}</span>
                <span className="text-stone-600">{format.money(l.loadValue)}</span>
                {l.ceilingAcknowledged ? <Badge tone="warning">{t('vehicles.overCeiling')}</Badge> : null}
              </div>
              {l.disputeComment && l.status === 'DISPUTED' ? <Alert tone="warning">{t('vehicles.disputed', { comment: l.disputeComment })}</Alert> : null}
              {editing?.id === l.id && editing.mode === 'amend' ? (
                <form className="space-y-2" noValidate onSubmit={(e: FormEvent<HTMLFormElement>) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  run({ id: l.id, action: 'amend', body: { version: l.version, lines: l.lines.map((line) => ({ batchId: line.batchId, packs: whole(formText(f, `amend-${line.batchId}`)) })).filter((x) => x.packs > 0) } });
                }}>
                  {l.lines.map((line) => (
                    <div key={line.batchId} className="flex items-center gap-2">
                      <span className="w-64"><bdi dir="ltr" className="font-mono">{line.code}</bdi>{' · '}<bdi dir="ltr">{line.lotNumber ?? '—'}</bdi>{line.disputeNote ? <span className="block text-xs text-amber-800">{line.disputeNote}</span> : null}</span>
                      <Input aria-label={t('vehicles.packsFrom', { lot: line.lotNumber ?? '—' })} name={`amend-${line.batchId}`} defaultValue={line.packs} inputMode="numeric" dir="ltr" className="w-24" />
                    </div>
                  ))}
                  <div className="flex gap-2"><Button type="submit" disabled={act.isPending}>{t('vehicles.reissue')}</Button><Button variant="ghost" onClick={() => setEditing(null)}>{t('common.cancel')}</Button></div>
                </form>
              ) : (
                <div className="text-stone-700">{l.lines.map((line) => <div key={line.batchId}><bdi dir="ltr" className="font-mono">{line.code}</bdi>{` · `}<bdi dir="ltr">{line.lotNumber ?? '—'}</bdi>{` · ${format.number(line.packs)}`}</div>)}</div>
              )}
              {editing?.id === l.id && editing.mode === 'cancel' ? (
                <form className="flex flex-wrap items-end gap-2" noValidate onSubmit={(e: FormEvent<HTMLFormElement>) => {
                  e.preventDefault();
                  run({ id: l.id, action: 'cancel', body: { version: l.version, reason: formText(new FormData(e.currentTarget), 'reason') } });
                }}>
                  <Field id={`cl-${l.id}`} label={t('vehicles.cancelReason')}><Input id={`cl-${l.id}`} name="reason" maxLength={500} /></Field>
                  <Button type="submit" variant="danger" disabled={act.isPending}>{t('vehicles.cancelLoad')}</Button>
                  <Button variant="ghost" onClick={() => setEditing(null)}>{t('common.cancel')}</Button>
                </form>
              ) : null}
              {(l.status === 'ISSUED' || l.status === 'DISPUTED') && !editing ? (
                <div className="flex gap-2">
                  <Button size="sm" variant="secondary" onClick={() => setEditing({ id: l.id, mode: 'amend' })}>{t('vehicles.amend')}</Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing({ id: l.id, mode: 'cancel' })}>{t('vehicles.cancelLoad')}</Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
