'use client';

import { useTranslations } from 'next-intl';
import { Card } from '@gsa/ui';
import { useFormat } from '@/lib/format';
import type { ImportedHistory } from './types';

/** IMP-005, IMP-008: what an imported store's books say — its bills, its payments, and the balance shown to the store. */
export function ImportedHistoryCard({ history }: { history: ImportedHistory }) {
  const t = useTranslations('stores');
  const format = useFormat();
  const empty = history.sales.length === 0 && history.payments.length === 0;
  return (
    <Card className="space-y-3 p-4 text-sm" data-testid="imported-history">
      <h2 className="font-semibold">{t('importedTitle')}</h2>
      {empty ? <p className="text-stone-500">{t('importedNothing')}</p> : (
        <>
          {history.sales.length > 0 ? (
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-stone-500">{t('importedBills')}</div>
              <ul className="divide-y divide-stone-100">
                {history.sales.map((s) => (
                  <li key={s.id} className="flex justify-between gap-3 py-1.5">
                    <span>{t('importedBill', { serial: s.serial, date: format.date(s.soldOn) })}</span>
                    <span className="tabular-nums">{format.money(s.total)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {history.payments.length > 0 ? (
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-stone-500">{t('importedPayments')}</div>
              <ul className="divide-y divide-stone-100">
                {history.payments.map((p) => (
                  <li key={p.id} className="flex justify-between gap-3 py-1.5">
                    <span>{p.voucherNumber ? t('importedPaymentVoucher', { date: format.date(p.paidOn), voucher: p.voucherNumber }) : t('importedPaymentNoVoucher', { date: format.date(p.paidOn) })}</span>
                    <span className="tabular-nums">{format.money(`-${p.amount}`)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
      <div className="flex justify-between gap-3 border-t border-stone-200 pt-2 font-semibold" data-testid="imported-balance">
        <span>{t('importedBalance')}</span>
        <span className="tabular-nums">{format.money(history.balance)}</span>
      </div>
    </Card>
  );
}
