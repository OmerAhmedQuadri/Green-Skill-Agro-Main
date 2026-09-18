'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, Button } from '@gsa/ui';
import { ActiveBadge } from '@/components/common/ActiveBadge';
import { PageHeader } from '@/components/common/PageHeader';
import { Facts, Section } from '@/components/common/Section';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useCommand, useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import type { Vendor } from './types';
import { VendorForm, type VendorInput } from './VendorForm';

export function VendorView({ id, canManage }: { id: string; canManage: boolean }) {
  const t = useTranslations();
  const format = useFormat();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const vendor = useQuery({ queryKey: keys.vendor(id), queryFn: () => api<Vendor>(`/vendors/${id}`) });
  const update = useCommand((body: Partial<VendorInput> & { version: number; isActive?: boolean }, key) =>
    api<Vendor>(`/vendors/${id}`, { method: 'PATCH', body, idempotencyKey: key }), {
    onSuccess: (v) => {
      queryClient.setQueryData(keys.vendor(id), v);
      void queryClient.invalidateQueries({ queryKey: keys.vendors() });
      void queryClient.invalidateQueries({ queryKey: keys.vendorCodes });
      setEditing(false);
    },
  });

  if (vendor.error) return <Alert>{errorText(vendor.error)}</Alert>;
  if (!vendor.data) return <p className="text-sm text-stone-500">{t('common.loading')}</p>;
  const v = vendor.data;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader
        back={{ href: '/console/vendors', label: t('vendors.title') }}
        title={<span className="flex flex-wrap items-center gap-3">{v.name}<ActiveBadge active={v.isActive} /></span>}
        subtitle={<bdi dir="ltr" className="font-mono">{v.code}</bdi>}
        actions={canManage ? (
          <Button variant="secondary" disabled={update.isPending} onClick={() => update.run({ version: v.version, isActive: !v.isActive })}>
            {v.isActive ? t('common.deactivate') : t('common.reactivate')}
          </Button>
        ) : undefined}
      />
      {update.error && !editing ? <Alert>{errorText(update.error)}</Alert> : null}
      <Section title={t('vendors.profile')}
        actions={canManage && !editing ? <Button variant="ghost" size="sm" onClick={() => setEditing(true)}><Pencil className="size-4" aria-hidden />{t('common.edit')}</Button> : undefined}>
        {editing ? (
          <div className="p-5">
            <VendorForm key={v.version} vendor={v} submitLabel={t('common.save')} pending={update.isPending} error={update.error}
              onSubmit={(input) => update.run({ ...input, version: v.version })} onCancel={() => setEditing(false)} />
          </div>
        ) : (
          <Facts items={[
            { label: t('vendors.code'), value: <bdi dir="ltr" className="font-mono">{v.code}</bdi> },
            { label: t('vendors.name'), value: v.name },
            { label: t('vendors.country'), value: format.country(v.country) },
            { label: t('vendors.contactPerson'), value: v.contactPerson ?? '—' },
            { label: t('vendors.phone'), value: v.phone ? <bdi dir="ltr">{v.phone}</bdi> : '—' },
            { label: t('vendors.email'), value: v.email ? <bdi dir="ltr">{v.email}</bdi> : '—' },
            { label: t('vendors.address'), value: v.address ?? '—' },
          ]} />
        )}
      </Section>
    </div>
  );
}
