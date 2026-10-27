'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Badge, Button, cn } from '@gsa/ui';
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

/**
 * RPT-008, CRD-003: the store ledger, newest first, with the running balance and what each debt still owes.
 *
 * COR-002 (ADR-0059): every entry stays. One a correction replaced, removed or moved is struck through; the entries
 * that reversed it say so; the corrected entry shows what was there before, struck through beside it. Given
 * `onCorrect`, entries the open correction session may correct offer it.
 */
export function LedgerTable({ entries, compact = false, area = 'console', onCorrect }: {
  entries: LedgerEntry[]; compact?: boolean; area?: Area; onCorrect?: ((entry: LedgerEntry) => void) | undefined;
}) {
  const t = useTranslations('stores');
  const tc = useTranslations('corrections');
  const format = useFormat();
  if (entries.length === 0) return <p className="p-4 text-sm text-stone-500">{t('noEntries')}</p>;
  const rows = [...entries].reverse();
  const head = compact ? [t('when'), t('entry'), t('amount'), t('balance')] : [t('when'), t('entry'), t('amount'), t('balance'), t('dueOn'), t('stillOwed'), t('by')];
  return (
    <Table head={onCorrect ? [...head, ''] : head}>
      {rows.map((e) => {
        const href = LINKS[e.reference.type]?.(e.reference.id, area) ?? null;
        // ADR-0046: debt put back because a bank transfer never arrived says so, not just "Adjustment".
        const label = e.reversalOf ? tc('ledger.reversal', { number: e.reversalOf.number })
          : e.reference.type === 'TRANSFER_NOT_RECEIVED' ? t('transferNotReceived') : t(`entries.${e.entryType}`);
        const was = e.correctionOf?.was;
        return (
          <tr key={e.id} data-testid={`ledger-${e.entryType}`} className={cn(e.replacedBy || e.reversalOf ? 'text-stone-400' : undefined)}>
            <Cell>
              {format.dateTime(e.occurredAt)}
              {was?.date ? <div className="text-xs"><del>{format.date(was.date)}</del></div> : null}
            </Cell>
            <Cell>
              {href ? <Link href={href} className="font-medium text-brand-800 hover:underline">{label}</Link> : label}
              {/* IMP-003: an entry from Green Agro's books says so, and where it was written. */}
              {e.imported ? (
                <div className="mt-1 space-y-0.5" data-testid="ledger-imported">
                  <Badge tone="neutral">{t('importedBadge')}</Badge>
                  {/* Where it was written is for the console; on the phone the label says enough. */}
                  {e.imported.book && !compact ? (
                    <div className="text-xs text-stone-500">
                      {e.imported.serial ? t('importedSourceSale', { book: e.imported.book, row: e.imported.row ?? 0, serial: e.imported.serial, batch: e.imported.batch })
                        : e.imported.voucherNumber ? t('importedSourceVoucher', { book: e.imported.book, row: e.imported.row ?? 0, number: e.imported.voucherNumber, batch: e.imported.batch })
                        : t('importedSource', { book: e.imported.book, row: e.imported.row ?? 0, batch: e.imported.batch })}
                    </div>
                  ) : null}
                </div>
              ) : null}
              {e.correctionOf ? <div className="mt-1"><Badge tone="warning" title={e.correctionOf.reason}>{tc('ledger.corrected', { number: e.correctionOf.number })}</Badge></div> : null}
              {e.correctionOf?.movedFrom ? <div className="text-xs text-stone-500">{tc('ledger.movedFrom', { store: e.correctionOf.movedFrom })}</div> : null}
              {e.replacedBy ? (
                <div className="text-xs text-stone-500" data-testid="ledger-replaced" title={e.replacedBy.reason}>
                  {e.replacedBy.removed ? tc('ledger.removed', { number: e.replacedBy.number })
                    : e.replacedBy.movedTo ? tc('ledger.moved', { store: e.replacedBy.movedTo, number: e.replacedBy.number })
                    : tc('ledger.replaced', { number: e.replacedBy.number })}
                </div>
              ) : null}
              {(e.correctionOf ?? e.replacedBy) ? <div className="text-xs text-stone-500">{(e.correctionOf ?? e.replacedBy)?.reason}</div> : null}
              {e.paymentNumber ? <div className="text-xs text-stone-500"><bdi dir="ltr">{e.paymentNumber}</bdi></div> : null}
              {e.voucher ? (
                <div className="text-xs">
                  <a href={`/files/${e.voucher.photoId}`} target="_blank" rel="noreferrer" className="text-brand-800 hover:underline">{t('voucherIs', { number: e.voucher.number })}</a>
                  {was?.voucherNumber ? <> <del className="text-stone-500">{was.voucherNumber}</del></> : null}
                </div>
              ) : null}
              {e.note ? <div className="text-xs text-stone-500">{e.note}</div> : null}
              {compact && e.dueOn ? <div className="text-xs text-stone-500">{t('dueBy', { date: format.date(e.dueOn) })}</div> : null}
            </Cell>
            <Cell>
              {e.replacedBy ? <del>{format.money(e.amount)}</del> : format.money(e.amount)}
              {was?.amount ? <div className="text-xs text-stone-500" data-testid="ledger-was">{tc('ledger.was')} <del>{format.money(was.amount)}</del></div> : null}
            </Cell>
            <Cell>{format.money(e.balance)}</Cell>
            {compact ? null : <Cell>{e.dueOn ? format.date(e.dueOn) : '—'}</Cell>}
            {compact ? null : <Cell>{e.open === null ? '—' : format.money(e.open)}</Cell>}
            {compact ? null : <Cell>{e.by}</Cell>}
            {onCorrect ? (
              <Cell>
                {e.correctable ? <Button size="sm" variant="secondary" title={tc('entry.hint')} onClick={() => onCorrect(e)}>{tc('entry.correct')}</Button> : null}
              </Cell>
            ) : null}
          </tr>
        );
      })}
    </Table>
  );
}
