'use client';

import { Clock } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import { INTL_LOCALE } from '@/lib/format';

/**
 * The business runs on Riyadh time (CONVENTIONS §4), and so does every time
 * the app shows. This says what time it is there now, for whoever is working
 * from another time zone. Drawn after mount: the server's minute and the
 * browser's could differ, and a mismatch would only flicker.
 */
export function RiyadhClock() {
  const t = useTranslations('nav');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const format = useMemo(() => new Intl.DateTimeFormat(INTL_LOCALE[locale], {
    timeZone: 'Asia/Riyadh', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }), [locale]);
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    const tick = () => setNow(new Date());
    tick();
    const timer = setInterval(tick, 15_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="flex items-start gap-2 px-3 text-xs" title={t('riyadhHint')} data-testid="riyadh-clock">
      <Clock className="mt-0.5 size-3.5 shrink-0 text-brand-200" aria-hidden />
      <div className="min-h-8 leading-snug">
        <div className="text-brand-200">{t('riyadhTime')}</div>
        {now ? <time dateTime={now.toISOString()} className="block whitespace-nowrap font-medium text-white">{format.format(now)}</time> : null}
      </div>
    </div>
  );
}
