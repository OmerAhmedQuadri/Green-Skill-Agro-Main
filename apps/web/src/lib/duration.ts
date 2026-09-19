'use client';

import { useTranslations } from 'next-intl';

/** "3 h 25 min" — active time, less breaks (ATT-002). */
export function useDuration() {
  const t = useTranslations('field');
  return (ms: number) => {
    const minutes = Math.floor(ms / 60_000);
    return t('duration', { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
  };
}
