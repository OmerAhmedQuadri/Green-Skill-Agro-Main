'use client';

import { dec, type Money } from '@gsa/core';
import { useTranslations } from 'next-intl';
import { Alert, Button } from '@gsa/ui';
import { useFormat } from '@/lib/format';

/**
 * IMP-007: imported sales are always labelled — how much of the figures came from the sellers' books before the
 * app, that they never count towards targets, commission or seller performance, and the filter that hides them.
 */
export function ImportedNote({ amount, channel, onHide, testId }: { amount: Money; channel: string; onHide: () => void; testId: string }) {
  const t = useTranslations('analytics.imported');
  const format = useFormat();
  if (dec(amount).isZero()) return null;
  const only = channel === 'IMPORTED';
  return (
    <Alert tone="info" className="flex flex-wrap items-center justify-between gap-3" data-testid={testId}>
      <span>{t(only ? 'only' : 'note', { amount: format.money(amount) })}</span>
      {only ? null : <Button size="sm" variant="secondary" onClick={onHide}>{t('hide')}</Button>}
    </Alert>
  );
}
