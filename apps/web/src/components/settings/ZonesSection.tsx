'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import type { FormEvent } from 'react';
import { Alert, Badge, Button, Field, Input } from '@gsa/ui';
import type { attendance } from '@gsa/services';
import { Section } from '@/components/common/Section';
import { Cell, Table } from '@/components/common/Table';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { formText } from '@/lib/forms';
import { useCommand, useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';

type Zone = attendance.Zone;
// Coordinates and a radius — not money or quantities, so a plain number is right here.
const num = (v: string) => (/^-?\d+(\.\d+)?$/.test(v) ? Number(v) : Number.NaN);

/**
 * ATT-008 (ADR-0032): the places check-in may be restricted to — a centre and
 * a radius. They apply only while "Restrict check-in to a location" is on.
 */
export function ZonesSection() {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const format = useFormat();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const zones = useQuery({ queryKey: keys.zones, queryFn: () => api<Zone[]>('/check-in-zones') });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: keys.zones });
  const create = useCommand((body: unknown, key) => api<Zone>('/check-in-zones', { method: 'POST', body, idempotencyKey: key }), { onSuccess: refresh });
  const toggle = useCommand((z: Zone, key) => api<Zone>(`/check-in-zones/${z.id}`, { method: 'PATCH', body: { version: z.version, isActive: !z.isActive }, idempotencyKey: key }), { onSuccess: refresh });
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    create.run({ name: formText(f, 'name'), lat: num(formText(f, 'lat')), lng: num(formText(f, 'lng')), radiusM: Math.round(num(formText(f, 'radius'))) });
    form.reset();
  };
  const error = zones.error ?? create.error ?? toggle.error;

  return (
    <Section title={t('zones')} description={t('zonesHint')}>
      {error ? <div className="p-4"><Alert>{errorText(error)}</Alert></div> : null}
      {(zones.data ?? []).length > 0 ? (
        <Table head={[t('zoneName'), t('zoneCentre'), t('zoneRadius'), tc('status'), '']}>
          {(zones.data ?? []).map((z) => (
            <tr key={z.id}>
              <Cell>{z.name}</Cell>
              <Cell><bdi dir="ltr">{`${z.lat.toFixed(5)}, ${z.lng.toFixed(5)}`}</bdi></Cell>
              <Cell>{t('metres', { m: format.number(z.radiusM) })}</Cell>
              <Cell><Badge tone={z.isActive ? 'success' : 'neutral'}>{z.isActive ? tc('active') : tc('inactive')}</Badge></Cell>
              <Cell className="text-end"><Button size="sm" variant="ghost" onClick={() => toggle.run(z)} disabled={toggle.isPending}>{z.isActive ? tc('deactivate') : tc('activate')}</Button></Cell>
            </tr>
          ))}
        </Table>
      ) : null}
      <form className="grid gap-4 border-t border-stone-200 p-5 sm:grid-cols-5" noValidate onSubmit={submit}>
        <Field id="zone-name" label={t('zoneName')}><Input id="zone-name" name="name" maxLength={120} /></Field>
        <Field id="zone-lat" label={t('latitude')}><Input id="zone-lat" name="lat" inputMode="decimal" dir="ltr" /></Field>
        <Field id="zone-lng" label={t('longitude')}><Input id="zone-lng" name="lng" inputMode="decimal" dir="ltr" /></Field>
        <Field id="zone-radius" label={t('zoneRadius')}><Input id="zone-radius" name="radius" inputMode="numeric" dir="ltr" /></Field>
        <div className="flex items-end"><Button type="submit" disabled={create.isPending}>{t('addZone')}</Button></div>
      </form>
    </Section>
  );
}
