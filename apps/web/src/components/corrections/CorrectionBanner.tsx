'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, Button } from '@gsa/ui';
import { useFormat } from '@/lib/format';
import { CloseSessionForm } from './CloseSessionForm';
import { isolate, useCorrectionStatus } from './status';

/**
 * COR-004, on every console page: the Super Admin's own session as a soft warning, closed from here too; and, for
 * everyone else, who is correcting history and until when. Sellers never see it — the console is not theirs.
 */
export function CorrectionBanner() {
  const t = useTranslations('corrections.banner');
  const format = useFormat();
  const status = useCorrectionStatus();
  const [closing, setClosing] = useState(false);
  const mine = status.data?.mine ?? null;
  const others = status.data?.others ?? [];
  if (!mine && others.length === 0) return null;

  return (
    <div className="mb-6 space-y-3">
      {mine ? (
        <Alert tone="warning" data-testid="correction-banner-mine">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="min-w-0 break-words">
              {mine.state === 'OPEN'
                ? t('mine', { number: mine.number, time: format.time(mine.endsAt), reason: isolate(mine.reason) })
                : t('ended', { number: mine.number, time: format.dateTime(mine.endsAt) })}
            </span>
            {closing ? null : <Button size="sm" variant="secondary" onClick={() => setClosing(true)}>{t('close')}</Button>}
          </div>
          {closing ? (
            <div className="mt-4 border-t border-amber-200 pt-4">
              <CloseSessionForm session={mine} onDone={() => setClosing(false)} onCancel={() => setClosing(false)} />
            </div>
          ) : null}
        </Alert>
      ) : null}
      {others.map((o) => (
        <Alert key={o.number} tone="info" data-testid="correction-banner-other">
          {t('others', { name: isolate(o.by), time: format.time(o.endsAt) })}
        </Alert>
      ))}
    </div>
  );
}
