'use client';

import { dec, sumMoney, toMoney, type Money } from '@gsa/core';
import { useTranslations } from 'next-intl';
import { useFormat } from '@/lib/format';
import type { CreditStatus, LedgerEntry } from './types';

/**
 * What the ledger adds up to, above the entries themselves.
 *
 * The rows carry every fact already — a debit here, a credit there, a running
 * balance — but reading a year of them to answer "how much have they paid, and
 * what is left" is not reading, it is arithmetic. A bill-to-bill store makes
 * that worse, because its sale and its payment sit on adjacent lines and net
 * to nothing.
 *
 * Totalled from the entries on screen, so the figures cannot disagree with the
 * table under them. Owed and past due come from the credit status, which is
 * derived server-side (ADR-0036) and is what blocking is judged on.
 */
export function LedgerSummary({ entries, credit }: { entries: LedgerEntry[]; credit: CreditStatus }) {
  const t = useTranslations('stores');
  const format = useFormat();

  // Debits are positive on the ledger and credits negative, so a credit's size
  // is its absolute value (ADR-0001).
  const totalOf = (keep: (e: LedgerEntry) => boolean): Money =>
    toMoney(dec(sumMoney(entries.filter(keep).map((e) => e.amount))).abs());

  const invoiced = totalOf((e) => e.entryType === 'SALE' || (e.entryType === 'ADJUSTMENT' && dec(e.amount).gt(0)));
  const paid = totalOf((e) => e.entryType === 'PAYMENT');
  const returned = totalOf((e) => e.entryType === 'CREDIT_NOTE');

  const items: { label: string; value: string; testid: string; strong?: boolean }[] = [
    { label: t('totalInvoiced'), value: format.money(invoiced), testid: 'invoiced' },
    { label: t('totalPaid'), value: format.money(paid), testid: 'paid' },
    { label: t('totalReturned'), value: format.money(returned), testid: 'returned' },
    { label: t('outstanding'), value: format.money(credit.outstanding), testid: 'outstanding', strong: true },
    { label: t('pastDue'), value: format.money(credit.pastDue), testid: 'past-due', strong: true },
  ];

  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-4 border-b border-stone-200 p-5 sm:grid-cols-5" data-testid="ledger-summary">
      {items.map((item) => (
        <div key={item.testid}>
          <dt className="text-xs font-medium uppercase tracking-wide text-stone-500">{item.label}</dt>
          <dd className={`mt-1 text-sm ${item.strong ? 'font-semibold text-stone-900' : 'text-stone-700'}`} data-testid={`total-${item.testid}`}>
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
