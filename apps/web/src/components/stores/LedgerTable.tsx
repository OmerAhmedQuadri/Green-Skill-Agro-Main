'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Cell, Table } from '@/components/common/Table';
import { useFormat } from '@/lib/format';
import type { LedgerEntry } from './types';

/**
 * Where a ledger entry came from. A credit note is only ever posted by a
 * return, so it is the one entry whose row was a dead end: it said "Credit
 * note" and led nowhere, which is why returns did not read as returns.
 */
const LINKS: Record<string, (id: string, area: Area) => string> = {
  RETURN: (id, area) => `/${area}/returns/${id}`,
  SALE: (id, area) => `/${area}/sales/${id}`,
};

type Area = 'console' | 'field';

/** RPT-008, CRD-003: the store ledger, newest first, with the running balance and what each debt still owes. */
export function LedgerTable({ entries, compact = false, area = 'console' }: { entries: LedgerEntry[]; compact?: boolean; area?: Area }) {
  const t = useTranslations('stores');
  const format = useFormat();
  if (entries.length === 0) return <p className="p-4 text-sm text-stone-500">{t('noEntries')}</p>;
  const rows = [...entries].reverse();
  return (
    <Table head={compact ? [t('when'), t('entry'), t('amount'), t('balance')] : [t('when'), t('entry'), t('amount'), t('balance'), t('dueOn'), t('stillOwed'), t('by')]}>
      {rows.map((e) => {
        const href = LINKS[e.reference.type]?.(e.reference.id, area) ?? null;
        return (
          <tr key={e.id} data-testid={`ledger-${e.entryType}`}>
            <Cell>{format.dateTime(e.occurredAt)}</Cell>
            <Cell>
              {href
                ? <Link href={href} className="font-medium text-brand-800 hover:underline">{t(`entries.${e.entryType}`)}</Link>
                : t(`entries.${e.entryType}`)}
              {e.paymentNumber ? <div className="text-xs text-stone-500"><bdi dir="ltr">{e.paymentNumber}</bdi></div> : null}
              {e.note ? <div className="text-xs text-stone-500">{e.note}</div> : null}
              {compact && e.dueOn ? <div className="text-xs text-stone-500">{t('dueBy', { date: format.date(e.dueOn) })}</div> : null}
            </Cell>
            <Cell>{format.money(e.amount)}</Cell>
            <Cell>{format.money(e.balance)}</Cell>
            {compact ? null : <Cell>{e.dueOn ? format.date(e.dueOn) : '—'}</Cell>}
            {compact ? null : <Cell>{e.open === null ? '—' : format.money(e.open)}</Cell>}
            {compact ? null : <Cell>{e.by}</Cell>}
          </tr>
        );
      })}
    </Table>
  );
}
