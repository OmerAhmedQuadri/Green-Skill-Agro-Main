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
    <div className="flex min-h-5 items-center gap-2 whitespace-nowrap px-3 text-xs text-brand-200" title={t('riyadhHint')} data-testid="riyadh-clock">
      <Clock className="size-3.5 shrink-0" aria-hidden />
      {now ? (
        <span>
          <time dateTime={now.toISOString()} className="font-medium text-white">{format.format(now)}</time> {t('riyadh')}
        </span>
      ) : null}
    </div>
  );
}
