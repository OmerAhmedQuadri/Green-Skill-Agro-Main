'use client';

import { COUNTRY_CODES } from '@gsa/core';
import { useTranslations } from 'next-intl';
import { useMemo } from 'react';
import { Select } from '@gsa/ui';
import { useFormat } from '@/lib/format';

/** ISO 3166-1 codes, named in the reader's language by Intl (no country names in code). */
export function CountrySelect({ id, name, defaultValue, required }: { id: string; name: string; defaultValue?: string | null | undefined; required?: boolean | undefined }) {
  const t = useTranslations('common');
  const format = useFormat();
  const options = useMemo(
    () => COUNTRY_CODES.map((code) => ({ code, label: format.country(code) })).sort((a, b) => a.label.localeCompare(b.label, format.locale)),
    [format],
  );
  return (
    <Select id={id} name={name} defaultValue={defaultValue ?? ''} required={required}>
      <option value="">{t('choose')}</option>
      {options.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
    </Select>
  );
}
