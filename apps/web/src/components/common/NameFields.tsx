'use client';

import { useTranslations } from 'next-intl';
import { Field, Input } from '@gsa/ui';

/** CAT-004, I18N-003: names are captured in both languages, each in its own direction. */
export function NameFields({ prefix, defaults, labelEn, labelAr }: {
  prefix: string; defaults?: { nameEn: string; nameAr: string } | undefined; labelEn?: string | undefined; labelAr?: string | undefined;
}) {
  const t = useTranslations('common');
  return (
    <>
      <Field id={`${prefix}-nameEn`} label={labelEn ?? t('nameEn')}>
        <Input id={`${prefix}-nameEn`} name="nameEn" dir="ltr" lang="en" required maxLength={120} defaultValue={defaults?.nameEn} />
      </Field>
      <Field id={`${prefix}-nameAr`} label={labelAr ?? t('nameAr')}>
        <Input id={`${prefix}-nameAr`} name="nameAr" dir="rtl" lang="ar" required maxLength={120} defaultValue={defaults?.nameAr} />
      </Field>
    </>
  );
}
