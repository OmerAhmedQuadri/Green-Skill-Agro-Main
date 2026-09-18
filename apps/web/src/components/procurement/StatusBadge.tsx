'use client';

import { useTranslations } from 'next-intl';
import { Badge } from '@gsa/ui';
import type { PoSummary } from './types';

const TONES = {
  DRAFT: 'neutral', PENDING_APPROVAL: 'warning', APPROVED: 'neutral', PLACED: 'neutral', CONFIRMED: 'neutral',
  IN_TRANSIT: 'warning', PARTIALLY_RECEIVED: 'warning', FULLY_RECEIVED: 'success', CLOSED: 'success',
} as const;

/** PO-007: a closed order shows how it closed. */
export function PoStatusBadge({ po }: { po: Pick<PoSummary, 'status' | 'closeReason'> }) {
  const t = useTranslations('procurement');
  if (po.status === 'CLOSED' && po.closeReason) {
    return <Badge tone={po.closeReason === 'COMPLETE' ? 'success' : po.closeReason === 'SHORT' ? 'warning' : 'danger'}>{t(`closeReasons.${po.closeReason}`)}</Badge>;
  }
  return <Badge tone={TONES[po.status]}>{t(`statuses.${po.status}`)}</Badge>;
}
