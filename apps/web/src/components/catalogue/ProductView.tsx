'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, Badge, Button } from '@gsa/ui';
import { ActiveBadge } from '@/components/common/ActiveBadge';
import { PageHeader } from '@/components/common/PageHeader';
import { Facts, Section } from '@/components/common/Section';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useCommand, useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import { ProductForm, type ProductInput } from './ProductForm';
import { SkusCard } from './SkusCard';
import type { CatalogueCan, ProductDetail } from './types';
import { VarietiesCard } from './VarietiesCard';

export function ProductView({ id, can }: { id: string; can: CatalogueCan }) {
  const t = useTranslations();
  const format = useFormat();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const product = useQuery({ queryKey: keys.product(id), queryFn: () => api<ProductDetail>(`/products/${id}`) });

  const replace = (next: ProductDetail) => {
    queryClient.setQueryData(keys.product(id), next);
    void queryClient.invalidateQueries({ queryKey: keys.products() });
  };
  const update = useCommand((body: Partial<ProductInput> & { version: number; isActive?: boolean }, key) =>
    api<ProductDetail>(`/products/${id}`, { method: 'PATCH', body, idempotencyKey: key }), { onSuccess: (p) => { replace(p); setEditing(false); } });

  if (product.error) return <Alert>{errorText(product.error)}</Alert>;
  if (!product.data) return <p className="text-sm text-stone-500">{t('common.loading')}</p>;
  const p = product.data;
  const template = p.productType.template;

  const vendor = p.vendor
    ? (can.viewVendors
      ? <Link href={`/console/vendors/${p.vendor.id}`} className="text-brand-800 hover:underline"><bdi dir="ltr">{p.vendor.code}</bdi></Link>
      : <bdi dir="ltr">{p.vendor.code}</bdi>)
    : '—';
  const facts = [
    { label: t('catalogue.productType'), value: format.name(p.productType) },
    { label: t('catalogue.category'), value: `${format.name(p.category)} › ${format.name(p.subCategory)}` },
    { label: t('catalogue.productNameEn'), value: <bdi dir="ltr">{p.nameEn}</bdi> },
    { label: t('catalogue.productNameAr'), value: <bdi dir="rtl">{p.nameAr}</bdi> },
    ...(template.HYBRID !== 'HIDDEN' ? [{ label: t('catalogue.hybrid'), value: p.hybrid ? t(`catalogue.hybridValues.${p.hybrid}`) : '—' }] : []),
    ...(template.COUNTRY_OF_ORIGIN !== 'HIDDEN' ? [{ label: t('catalogue.countryOfOrigin'), value: p.countryOfOrigin ? format.country(p.countryOfOrigin) : '—' }] : []),
    ...(template.VENDOR !== 'HIDDEN' ? [{ label: t('catalogue.vendor'), value: vendor }] : []),
    ...(template.SHELF_LIFE !== 'HIDDEN' ? [{ label: t('catalogue.shelfLife'), value: p.shelfLifeMonths ? t('catalogue.months', { count: p.shelfLifeMonths }) : '—' }] : []),
  ];

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        back={{ href: '/console/catalogue', label: t('catalogue.title') }}
        title={<span className="flex flex-wrap items-center gap-3">{format.name(p)}<Badge>{format.name(p.productType)}</Badge><ActiveBadge active={p.isActive} /></span>}
        subtitle={format.otherName(p)}
        actions={can.manageProducts ? (
          <Button variant="secondary" disabled={update.isPending}
            onClick={() => update.run({ version: p.version, isActive: !p.isActive })}>
            {p.isActive ? t('common.deactivate') : t('common.reactivate')}
          </Button>
        ) : undefined}
      />

      {update.error && !editing ? <Alert>{errorText(update.error)}</Alert> : null}

      <Section
        title={t('catalogue.details')}
        actions={can.manageProducts && !editing
          ? <Button variant="ghost" size="sm" onClick={() => setEditing(true)}><Pencil className="size-4" aria-hidden />{t('common.edit')}</Button>
          : undefined}
      >
        {editing ? (
          <div className="p-5">
            <ProductForm key={p.version} product={p} submitLabel={t('common.save')} pending={update.isPending} error={update.error}
              onSubmit={(input) => update.run({ ...input, version: p.version })} onCancel={() => setEditing(false)} />
          </div>
        ) : <Facts items={facts} />}
      </Section>

      {template.VARIETY !== 'HIDDEN' ? <VarietiesCard product={p} canEdit={can.manageProducts} onChange={replace} /> : null}
      <SkusCard product={p} can={can} onChange={replace} />
    </div>
  );
}
