'use client';

import type { RetentionPeriod } from '@gsa/core';
import { useTranslations } from 'next-intl';

/** A retention period as people say it: "3 months", "2 years", "Forever". */
export function usePeriodText() {
  const t = useTranslations('storage');
  return (period: RetentionPeriod): string => {
    if (period === 'FOREVER') return t('forever');
    return period % 12 === 0 ? t('years', { count: period / 12 }) : t('months', { count: period });
  };
}
