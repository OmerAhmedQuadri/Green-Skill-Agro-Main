'use client';

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { Alert, Button, Field, Input, Select } from '@gsa/ui';
import { CountrySelect } from '@/components/common/CountrySelect';
import { NameFields } from '@/components/common/NameFields';
import { api, type ApiError } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { formText, wholeNumber } from '@/lib/forms';
import { useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import type { Category, ProductDetail, ProductType, VendorCode } from './types';

export type ProductInput = {
  productTypeId?: string; categoryId: string; subCategoryId: string; nameEn: string; nameAr: string;
  hybrid: 'HYBRID' | 'NON_HYBRID' | null; countryOfOrigin: string | null; vendorId: string | null; shelfLifeMonths: number | null;
};

type Mode = 'HIDDEN' | 'OPTIONAL' | 'REQUIRED';

/**
 * Workflow A, steps 1–3 and 6. The chosen type's template decides which
 * attributes appear and which are required (CAT-013); hidden ones are absent.
 */
export function ProductForm({ product, submitLabel, pending, error, onSubmit, onCancel }: {
  product?: ProductDetail; submitLabel: string; pending: boolean; error: ApiError | null;
  onSubmit: (input: ProductInput) => void; onCancel?: () => void;
}) {
  const t = useTranslations();
  const format = useFormat();
  const errorText = useErrorText();
  const types = useQuery({ queryKey: keys.productTypes, queryFn: () => api<ProductType[]>('/product-types') });
  const categories = useQuery({ queryKey: keys.categories, queryFn: () => api<Category[]>('/categories') });
  const vendorCodes = useQuery({ queryKey: keys.vendorCodes, queryFn: () => api<VendorCode[]>('/vendor-codes') });

  const [typeId, setTypeId] = useState(product?.productType.id ?? '');
  const [categoryId, setCategoryId] = useState(product?.category.id ?? '');
  const type = product ? { ...product.productType } : types.data?.find((pt) => pt.id === typeId);
  const activeCategories = categories.data?.filter((c) => c.isActive || c.id === product?.category.id) ?? [];
  const subs = activeCategories.find((c) => c.id === categoryId)?.subCategories.filter((s) => s.isActive || s.id === product?.subCategory.id) ?? [];

  const mode = (attribute: 'HYBRID' | 'COUNTRY_OF_ORIGIN' | 'VENDOR' | 'SHELF_LIFE'): Mode => type?.template[attribute] ?? 'HIDDEN';
  const label = (key: 'catalogue.hybrid' | 'catalogue.countryOfOrigin' | 'catalogue.vendor' | 'catalogue.shelfLife', m: Mode) => (m === 'OPTIONAL' ? `${t(key)} (${t('common.optional')})` : t(key));

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    const text = (name: string) => formText(f, name);
    const months = text('shelfLifeMonths');
    onSubmit({
      ...(product ? {} : { productTypeId: typeId }),
      categoryId, subCategoryId: text('subCategoryId'), nameEn: text('nameEn'), nameAr: text('nameAr'),
      hybrid: text('hybrid') === 'HYBRID' || text('hybrid') === 'NON_HYBRID' ? (text('hybrid') as 'HYBRID' | 'NON_HYBRID') : null,
      countryOfOrigin: text('countryOfOrigin') || null,
      vendorId: text('vendorId') || null,
      shelfLifeMonths: wholeNumber(months),
    });
  };

  return (
    <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
      {error ? <Alert className="sm:col-span-2">{errorText(error)}</Alert> : null}

      <Field id="productTypeId" label={t('catalogue.productType')}>
        {product ? (
          <Input id="productTypeId" value={format.name(product.productType)} disabled readOnly />
        ) : (
          <Select id="productTypeId" value={typeId} onChange={(e) => setTypeId(e.target.value)} required>
            <option value="">{t('common.choose')}</option>
            {types.data?.filter((pt) => pt.isActive).map((pt) => <option key={pt.id} value={pt.id}>{format.name(pt)}</option>)}
          </Select>
        )}
      </Field>
      <div className="hidden sm:block" />

      {type ? (
        <>
          <Field id="categoryId" label={t('catalogue.category')}>
            <Select id="categoryId" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} required>
              <option value="">{t('common.choose')}</option>
              {activeCategories.map((c) => <option key={c.id} value={c.id}>{format.name(c)}</option>)}
            </Select>
          </Field>
          <Field id="subCategoryId" label={t('catalogue.subCategory')}>
            <Select key={categoryId} id="subCategoryId" name="subCategoryId" defaultValue={product?.subCategory.id ?? ''} required>
              <option value="">{t('common.choose')}</option>
              {subs.map((s) => <option key={s.id} value={s.id}>{format.name(s)}</option>)}
            </Select>
          </Field>

          <NameFields prefix="product" defaults={product} labelEn={t('catalogue.productNameEn')} labelAr={t('catalogue.productNameAr')} />

          {mode('HYBRID') !== 'HIDDEN' ? (
            <Field id="hybrid" label={label('catalogue.hybrid', mode('HYBRID'))}>
              <Select id="hybrid" name="hybrid" defaultValue={product?.hybrid ?? ''}>
                <option value="">{t('common.choose')}</option>
                <option value="HYBRID">{t('catalogue.hybridValues.HYBRID')}</option>
                <option value="NON_HYBRID">{t('catalogue.hybridValues.NON_HYBRID')}</option>
              </Select>
            </Field>
          ) : null}
          {mode('COUNTRY_OF_ORIGIN') !== 'HIDDEN' ? (
            <Field id="countryOfOrigin" label={label('catalogue.countryOfOrigin', mode('COUNTRY_OF_ORIGIN'))}>
              <CountrySelect id="countryOfOrigin" name="countryOfOrigin" defaultValue={product?.countryOfOrigin} />
            </Field>
          ) : null}
          {mode('VENDOR') !== 'HIDDEN' ? (
            <Field id="vendorId" label={label('catalogue.vendor', mode('VENDOR'))}>
              <Select id="vendorId" name="vendorId" defaultValue={product?.vendor?.id ?? ''} dir="ltr">
                <option value="">{t('common.choose')}</option>
                {vendorCodes.data?.map((v) => <option key={v.id} value={v.id}>{v.code}</option>)}
              </Select>
            </Field>
          ) : null}
          {mode('SHELF_LIFE') !== 'HIDDEN' ? (
            <Field id="shelfLifeMonths" label={label('catalogue.shelfLife', mode('SHELF_LIFE'))} hint={t('catalogue.shelfLifeHint')}>
              <Input id="shelfLifeMonths" name="shelfLifeMonths" type="number" inputMode="numeric" min={1} max={240} dir="ltr"
                defaultValue={product?.shelfLifeMonths ?? ''} />
            </Field>
          ) : null}
        </>
      ) : null}

      <div className="flex items-end gap-2 sm:col-span-2">
        <Button type="submit" disabled={pending || !type}>{pending ? t('common.saving') : submitLabel}</Button>
        {onCancel ? <Button variant="ghost" onClick={onCancel}>{t('common.cancel')}</Button> : null}
      </div>
    </form>
  );
}
