'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, CardHeader, Checkbox, Select } from '@gsa/ui';
import { api } from '@/lib/api';
import { useCommand, useErrorText } from '@/lib/hooks';
import type { AccountDetail } from './types';

type Preset = { code: string; permissions: string[] };
const moduleOf = (code: string) => code.slice(0, code.indexOf('.'));
const PRESET_KEYS = ['WAREHOUSE', 'SALES_MANAGER', 'OPERATIONS_MANAGER'] as const;
// Preset codes come from the database; only known ones have a translated name.
const isPresetKey = (code: string): code is (typeof PRESET_KEYS)[number] => (PRESET_KEYS as readonly string[]).includes(code);

/**
 * USR-005..007, USR-014. Grant a module, then actions within it. Only the
 * role's configurable permissions are editable; the rest are always on.
 * An actor cannot grant what they do not hold (PERMISSIONS §3.2).
 */
export function PermissionEditor({ account, actorPermissions }: { account: AccountDetail; actorPermissions: string[] }) {
  const t = useTranslations();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const held = useMemo(() => new Set(account.permissions), [account.permissions]);
  const [draft, setDraft] = useState<Set<string>>(() => new Set(account.permissions));
  const actor = new Set(actorPermissions);
  const configurable = new Set(account.configurable);
  const fixed = account.permissions.filter((p) => !configurable.has(p));

  const modules = [...new Set(account.configurable.map(moduleOf))];
  const changes = account.configurable.filter((p) => held.has(p) !== draft.has(p)).map((p) => ({ permission: p, granted: draft.has(p) }));

  const refresh = (next: AccountDetail) => {
    queryClient.setQueryData(['user', account.id], next);
    setDraft(new Set(next.permissions));
  };
  const save = useCommand((body: { changes: typeof changes }, key) =>
    api<AccountDetail>(`/users/${account.id}/permissions`, { method: 'PATCH', body, idempotencyKey: key }), { onSuccess: refresh });
  const apply = useCommand((body: { preset: string }, key) =>
    api<AccountDetail>(`/users/${account.id}/apply-preset`, { method: 'POST', body, idempotencyKey: key }), { onSuccess: refresh });
  const presets = useQuery({ queryKey: ['presets'], queryFn: () => api<Preset[]>('/permission-presets'), enabled: account.role === 'MANAGER' });
  const [preset, setPreset] = useState('');

  const toggle = (code: string, on: boolean) => setDraft((d) => { const n = new Set(d); if (on) n.add(code); else n.delete(code); return n; });
  const toggleModule = (mod: string, on: boolean) => setDraft((d) => {
    const n = new Set(d);
    for (const p of account.configurable) if (moduleOf(p) === mod && actor.has(p)) { if (on) n.add(p); else n.delete(p); }
    return n;
  });

  const error = save.error ?? apply.error;
  return (
    <Card>
      <CardHeader title={t('users.permissions')} description={t('users.permissionsSubtitle')} />
      <div className="space-y-5 p-5">
        {error ? <Alert>{errorText(error)}</Alert> : null}

        {account.role === 'MANAGER' ? (
          <div className="flex flex-wrap items-end gap-2 rounded-md bg-stone-50 p-3">
            <div className="min-w-56 flex-1">
              <label htmlFor="preset" className="block text-sm font-medium">{t('users.preset')}</label>
              <p className="mb-1.5 text-xs text-stone-500">{t('users.presetNote')}</p>
              <Select id="preset" value={preset} onChange={(e) => setPreset(e.target.value)}>
                <option value="">{t('users.choosePreset')}</option>
                {(presets.data ?? []).map((p) => (
                  <option key={p.code} value={p.code}>{isPresetKey(p.code) ? t(`presets.${p.code}`) : p.code}</option>
                ))}
              </Select>
            </div>
            <Button variant="secondary" disabled={!preset || apply.isPending} onClick={() => apply.run({ preset })}>{t('users.applyPreset')}</Button>
          </div>
        ) : null}

        <div className="grid gap-4 md:grid-cols-2">
          {modules.map((mod) => {
            const perms = account.configurable.filter((p) => moduleOf(p) === mod);
            const onCount = perms.filter((p) => draft.has(p)).length;
            return (
              <fieldset key={mod} className="rounded-md border border-stone-200 p-3">
                <legend className="px-1">
                  <label className="flex items-center gap-2 text-sm font-semibold">
                    <Checkbox checked={onCount === perms.length} ref={(el: HTMLInputElement | null) => { if (el) el.indeterminate = onCount > 0 && onCount < perms.length; }}
                      onChange={(e) => toggleModule(mod, e.target.checked)} />
                    {t(`modules.${mod}` as 'modules.users')}
                  </label>
                </legend>
                <div className="mt-1 space-y-2 ps-6">
                  {perms.map((p) => (
                    <label key={p} className="flex items-start gap-2 text-sm">
                      <Checkbox className="mt-0.5" checked={draft.has(p)} disabled={!actor.has(p)} onChange={(e) => toggle(p, e.target.checked)} />
                      <span>{t(`permissions.${p}` as 'permissions.users.manage_staff')}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            );
          })}
        </div>

        {fixed.length > 0 ? (
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-stone-500">{t('users.alwaysIncluded')}</p>
            <div className="flex flex-wrap gap-1.5">
              {fixed.map((p) => <Badge key={p}>{t(`permissions.${p}` as 'permissions.users.manage_staff')}</Badge>)}
            </div>
          </div>
        ) : null}

        <div className="flex items-center gap-3 border-t border-stone-100 pt-4">
          <Button disabled={changes.length === 0 || save.isPending} onClick={() => save.run({ changes })}>
            {save.isPending ? t('common.saving') : t('users.savePermissions')}
          </Button>
          {changes.length === 0 ? <span className="text-xs text-stone-500">{t('users.noChanges')}</span> : null}
          {save.isSuccess && changes.length === 0 ? <span className="text-xs text-brand-700">{t('users.saved')}</span> : null}
        </div>
      </div>
    </Card>
  );
}
