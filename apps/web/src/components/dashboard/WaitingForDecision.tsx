import type { DecisionQueue } from '@gsa/core';
import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Badge } from '@gsa/ui';
import { Section } from '@/components/common/Section';

/** Each queue opens its list, filtered to what waits (ADR-0051). */
const WHERE = {
  DISCOUNTS: '/console/sales?status=AWAITING',
  OPEN_SALES: '/console/sales?status=AWAITING',
  CHECK_INS: '/console/attendance?attention=true',
  DISPATCH: '/console/dispatch?status=REQUESTED',
  STORES: '/console/stores?status=PENDING_APPROVAL',
  SETTLEMENTS: '/console/cash',
  TRANSFERS: '/console/cash#transfers',
  LOST_CLAIMS: '/console/dispatch?status=CLAIMED',
  WRITE_OFFS: '/console/write-offs?status=SUBMITTED',
  PURCHASE_ORDERS: '/console/purchase-orders?status=PENDING_APPROVAL',
  CLOSING_VARIANCES: '/console/closing-stock?status=VARIANCE_FLAGGED',
} as const satisfies Record<DecisionQueue, string>;

/**
 * ADR-0051 (SYS-016): what waits for a decision the reader can make, counted
 * from the records as the page opens — the bell says what happened, this says
 * what is left. Queues with nothing in them are left out.
 */
export async function WaitingForDecision({ queues }: { queues: readonly { queue: DecisionQueue; count: number }[] }) {
  const t = await getTranslations('dashboard.waiting');
  const waiting = queues.filter((q) => q.count > 0);
  return (
    <Section title={t('title')} description={t('hint')} id="waiting">
      {waiting.length === 0 ? <p className="px-5 pb-5 text-sm text-stone-500" data-testid="nothing-waiting">{t('none')}</p> : (
        <ul className="divide-y divide-stone-100 border-t border-stone-100">
          {waiting.map(({ queue, count }) => (
            <li key={queue}>
              <Link href={WHERE[queue]} className="flex items-center gap-3 px-5 py-3 text-sm hover:bg-stone-50" data-testid={`waiting-${queue}`}>
                <span className="min-w-0 flex-1 font-medium text-stone-800">{t(`queues.${queue}`)}</span>
                {/* Latin digits in both languages (I18N-005). */}
                <Badge tone="warning" data-testid={`waiting-count-${queue}`}>{count}</Badge>
                <ChevronRight className="size-4 shrink-0 text-stone-400 rtl:rotate-180" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
