'use client';

import { useTranslations } from 'next-intl';
import { Alert } from '@gsa/ui';
import { Facts } from '@/components/common/Section';
import { useFormat } from '@/lib/format';
import type { CreditStatus } from './types';

/**
 * CRD-004, CRD-005: whether this store can be sold to now, and why not —
 * shown before anything is added to a sale.
 */
export function CreditPanel({ credit }: { credit: CreditStatus }) {
  const t = useTranslations('stores');
  const format = useFormat();
  return (
    <div className="space-y-3" data-testid="credit-panel">
      {credit.blocked ? (
        <Alert data-testid="credit-blocked">
          <div className="font-semibold">{t('blocked')}</div>
          <ul className="mt-1 list-disc ps-5">
            {credit.reasons.map((r, i) => (
              <li key={i}>
                {r.code === 'PAST_DUE' ? t('reasons.PAST_DUE', { amount: format.money(r.amount), date: format.date(r.oldestDueOn) })
                  : r.code === 'OVER_LIMIT' ? t('reasons.OVER_LIMIT', { outstanding: format.money(r.outstanding), limit: format.money(r.limit) })
                    : t(`reasons.${r.code}`)}
              </li>
            ))}
          </ul>
        </Alert>
      ) : credit.overridden ? (
        <Alert tone="warning" data-testid="credit-overridden">{t('overridden')}</Alert>
      ) : <Alert tone="success" data-testid="credit-clear">{t('clear')}</Alert>}
      <Facts items={[
        { label: t('outstanding'), value: format.money(credit.outstanding) },
        { label: t('pastDue'), value: format.money(credit.pastDue) },
        { label: t('creditLimit'), value: format.money(credit.limit) },
        { label: t('available'), value: format.money(credit.available) },
      ]} />
    </div>
  );
}
