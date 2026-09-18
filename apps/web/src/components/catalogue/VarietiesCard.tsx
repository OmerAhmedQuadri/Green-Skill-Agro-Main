'use client';

import { Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { Alert, Button } from '@gsa/ui';
import { ActiveBadge } from '@/components/common/ActiveBadge';
import { NameFields } from '@/components/common/NameFields';
import { Section } from '@/components/common/Section';
import { Cell, Table } from '@/components/common/Table';
import { api } from '@/lib/api';
import { formText } from '@/lib/forms';
import { useCommand, useErrorText } from '@/lib/hooks';
import type { ProductDetail } from './types';

type Variety = ProductDetail['varieties'][number];

/** CAT-001, CAT-004: a product's varieties, named in both languages. */
export function VarietiesCard({ product, canEdit, onChange }: { product: ProductDetail; canEdit: boolean; onChange: (p: ProductDetail) => void }) {
  const t = useTranslations();
  const errorText = useErrorText();
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const create = useCommand((body: { nameEn: string; nameAr: string }, key) =>
    api<ProductDetail>(`/products/${product.id}/varieties`, { method: 'POST', body, idempotencyKey: key }),
  { onSuccess: (p) => { onChange(p); setAdding(false); } });
  const update = useCommand(({ id, ...body }: { id: string; version: number; nameEn?: string; nameAr?: string; isActive?: boolean }, key) =>
    api<ProductDetail>(`/varieties/${id}`, { method: 'PATCH', body, idempotencyKey: key }),
  { onSuccess: (p) => { onChange(p); setEditingId(null); } });

  const names = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    return { nameEn: formText(f, 'nameEn'), nameAr: formText(f, 'nameAr') };
  };
  const error = create.error ?? update.error;

  return (
    <Section
      title={t('catalogue.varieties')}
      description={t('catalogue.varietiesHint')}
      actions={canEdit && !adding ? <Button variant="secondary" size="sm" onClick={() => setAdding(true)}><Plus className="size-4" aria-hidden />{t('catalogue.addVariety')}</Button> : undefined}
    >
      {error ? <div className="p-4"><Alert>{errorText(error)}</Alert></div> : null}
      {adding ? (
        <form onSubmit={(e) => create.run(names(e))} className="grid gap-4 border-b border-stone-200 p-5 sm:grid-cols-2" noValidate>
          <NameFields prefix="variety-new" labelEn={t('catalogue.varietyNameEn')} labelAr={t('catalogue.varietyNameAr')} />
          <div className="flex gap-2 sm:col-span-2">
            <Button type="submit" disabled={create.isPending}>{create.isPending ? t('common.saving') : t('catalogue.addVariety')}</Button>
            <Button variant="ghost" onClick={() => setAdding(false)}>{t('common.cancel')}</Button>
          </div>
        </form>
      ) : null}
      {product.varieties.length === 0 && !adding ? <p className="p-5 text-sm text-stone-500">{t('catalogue.noVarieties')}</p> : null}
      {product.varieties.length > 0 ? (
        <Table head={[t('catalogue.varietyNameEn'), t('catalogue.varietyNameAr'), t('common.status'), '']}>
          {product.varieties.map((v: Variety) => (editingId === v.id ? (
            <tr key={v.id}>
              <td colSpan={4} className="p-4">
                <form onSubmit={(e) => update.run({ id: v.id, version: v.version, ...names(e) })} className="grid gap-4 sm:grid-cols-2" noValidate>
                  <NameFields prefix={`variety-${v.id}`} defaults={v} labelEn={t('catalogue.varietyNameEn')} labelAr={t('catalogue.varietyNameAr')} />
                  <div className="flex gap-2 sm:col-span-2">
                    <Button type="submit" disabled={update.isPending}>{t('common.save')}</Button>
                    <Button variant="ghost" onClick={() => setEditingId(null)}>{t('common.cancel')}</Button>
                  </div>
                </form>
              </td>
            </tr>
          ) : (
            <tr key={v.id}>
              <Cell><bdi dir="ltr">{v.nameEn}</bdi></Cell>
              <Cell><bdi dir="rtl">{v.nameAr}</bdi></Cell>
              <Cell><ActiveBadge active={v.isActive} /></Cell>
              <Cell className="text-end">
                {canEdit ? (
                  <span className="inline-flex gap-1">
                    <Button variant="ghost" size="sm" onClick={() => setEditingId(v.id)}>{t('common.edit')}</Button>
                    <Button variant="ghost" size="sm" disabled={update.isPending} onClick={() => update.run({ id: v.id, version: v.version, isActive: !v.isActive })}>
                      {v.isActive ? t('common.deactivate') : t('common.reactivate')}
                    </Button>
                  </span>
                ) : null}
              </Cell>
            </tr>
          )))}
        </Table>
      ) : null}
    </Section>
  );
}
