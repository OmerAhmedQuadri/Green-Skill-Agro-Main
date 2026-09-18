'use client';

import { FEATURE_TOGGLE_KEYS, SETTING_GROUPS, SETTINGS, type FeatureToggles, type SettingKey } from '@gsa/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { Alert, Button, Checkbox, Field, Input, Select } from '@gsa/ui';
import { PageHeader } from '@/components/common/PageHeader';
import { Section } from '@/components/common/Section';
import { api } from '@/lib/api';
import { formText } from '@/lib/forms';
import { useCommand, useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import { CeilingsSection, CommissionSection } from './LimitsSections';
import { ProductTypesSection } from './ProductTypesSection';

export type SettingsCan = { configure: boolean; templates: boolean; limits: boolean; returns: boolean; commission: boolean };

export function SettingsPage({ can }: { can: SettingsCan }) {
  const t = useTranslations();
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={t('settings.title')} subtitle={t('settings.subtitle')} />
      {can.configure || can.returns || can.limits ? <GeneralSettings /> : null}
      {can.configure ? <TogglesSection /> : null}
      {can.templates ? <ProductTypesSection /> : null}
      {can.limits ? <CeilingsSection /> : null}
      {can.commission ? <CommissionSection /> : null}
    </div>
  );
}

type SettingsData = { values: Partial<Record<SettingKey, string | number | boolean>>; editable: SettingKey[] };
// Discount settings live on the pricing screen, beside the per-SKU ceilings.
const GROUPS = SETTING_GROUPS.filter((g) => g !== 'discounts');

/** SYS-001..007: each value is shown only to those whose permission governs it. */
function GeneralSettings() {
  const t = useTranslations();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const [saved, setSaved] = useState(false);
  const settings = useQuery({ queryKey: keys.settings, queryFn: () => api<SettingsData>('/settings') });
  const save = useCommand((body: { changes: { key: string; value: string | number | boolean }[] }, key) =>
    api<SettingsData>('/settings', { method: 'PATCH', body, idempotencyKey: key }),
  { onSuccess: (next) => { queryClient.setQueryData(keys.settings, next); setSaved(true); } });

  if (settings.error) return <Alert>{errorText(settings.error)}</Alert>;
  if (!settings.data) return null;
  const { values, editable } = settings.data;
  const groups = GROUPS.map((g) => ({ group: g, keys: editable.filter((k) => SETTINGS[k].group === g) })).filter((g) => g.keys.length > 0);
  if (groups.length === 0) return null;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaved(false);
    const f = new FormData(event.currentTarget);
    const changes = groups.flatMap((g) => g.keys).map((k) => {
      const spec = SETTINGS[k];
      const raw = formText(f, k);
      const value = spec.kind === 'boolean' ? f.get(k) === 'on' : spec.kind === 'integer' ? Number.parseInt(raw, 10) : raw;
      return { key: k, value };
    }).filter((c) => c.value !== values[c.key]);
    if (changes.length) save.run({ changes });
  };

  return (
    <Section title={t('settings.general')} description={t('settings.generalHint')}>
      <form key={JSON.stringify(values)} onSubmit={submit} className="space-y-6 p-5" noValidate>
        {save.error ? <Alert>{errorText(save.error)}</Alert> : null}
        {saved ? <Alert tone="success">{t('common.saved')}</Alert> : null}
        {groups.map(({ group, keys: groupKeys }) => (
          <fieldset key={group} className="space-y-4">
            <legend className="text-sm font-semibold text-stone-900">{t(`settings.groups.${group}`)}</legend>
            <div className="grid gap-4 sm:grid-cols-2">
              {groupKeys.map((k) => <SettingField key={k} settingKey={k} value={values[k]} />)}
            </div>
          </fieldset>
        ))}
        <Button type="submit" disabled={save.isPending}>{save.isPending ? t('common.saving') : t('common.save')}</Button>
      </form>
    </Section>
  );
}

function SettingField({ settingKey, value }: { settingKey: SettingKey; value: string | number | boolean | undefined }) {
  const t = useTranslations('settings');
  const spec = SETTINGS[settingKey];
  const id = `setting-${settingKey}`;
  const label = t(`fields.${settingKey}`);
  if (spec.kind === 'boolean') {
    return (
      <label htmlFor={id} className="flex items-start gap-3 rounded-md border border-stone-200 p-3 text-sm">
        <Checkbox id={id} name={settingKey} defaultChecked={value === true} className="mt-0.5" />
        <span>{label}</span>
      </label>
    );
  }
  if (spec.kind === 'choice') {
    return (
      <Field id={id} label={label}>
        <Select id={id} name={settingKey} defaultValue={String(value ?? spec.default)}>
          {spec.options.map((o) => <option key={o} value={o}>{t(`choices.${o}`)}</option>)}
        </Select>
      </Field>
    );
  }
  return (
    <Field id={id} label={label} hint={spec.kind === 'integer' ? t('range', { min: spec.min, max: spec.max }) : undefined}>
      <Input id={id} name={settingKey} dir="ltr" inputMode={spec.kind === 'integer' ? 'numeric' : 'decimal'}
        {...(spec.kind === 'integer' ? { type: 'number', min: spec.min, max: spec.max } : {})} defaultValue={String(value ?? spec.default)} />
    </Field>
  );
}

/** SYS-005: a switched-off feature is hidden from everyone, whatever their permissions. */
function TogglesSection() {
  const t = useTranslations();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const toggles = useQuery({ queryKey: keys.toggles, queryFn: () => api<FeatureToggles>('/feature-toggles') });
  const save = useCommand((body: { changes: { key: string; enabled: boolean }[] }, key) =>
    api<FeatureToggles>('/feature-toggles', { method: 'PATCH', body, idempotencyKey: key }), { onSuccess: (next) => queryClient.setQueryData(keys.toggles, next) });

  return (
    <Section title={t('settings.toggles')} description={t('settings.togglesHint')}>
      {save.error ? <div className="px-5 pt-4"><Alert>{errorText(save.error)}</Alert></div> : null}
      <ul className="divide-y divide-stone-100">
        {FEATURE_TOGGLE_KEYS.map((k) => (
          <li key={k} className="flex items-start gap-3 px-5 py-3">
            <Checkbox id={`toggle-${k}`} checked={toggles.data?.[k] ?? false} disabled={!toggles.data || save.isPending} className="mt-1"
              onChange={(e) => save.run({ changes: [{ key: k, enabled: e.target.checked }] })} />
            <label htmlFor={`toggle-${k}`} className="text-sm">
              <span className="font-medium">{t(`settings.toggleNames.${k}`)}</span>
              <span className="block text-stone-500">{t(`settings.toggleHints.${k}`)}</span>
            </label>
          </li>
        ))}
      </ul>
    </Section>
  );
}
