'use client';

import { useTranslations } from 'next-intl';
import { Badge } from '@gsa/ui';
import { useFormat } from '@/lib/format';
import type { Sale } from './types';

/**
 * COR-006 (ADR-0059): what corrected a sale — each correction with its reason, who made it and when, the figures it
 * changed beside what they were (struck through), and what the Super Admin chose to follow it.
 */
export function SaleCorrections({ sale }: { sale: Sale }) {
  const t = useTranslations('corrections.sale');
  const format = useFormat();
  const codeOf = (lineId: string) => sale.lines.find((l) => l.id === lineId)?.code ?? '';
  return (
    <ol className="divide-y divide-stone-100" data-testid="sale-corrections">
      {sale.corrections.map((c) => {
        const applied = (['stock', 'document', 'account', 'cashInHand'] as const).filter((k) => c.applied[k]);
        const changed = c.after
          ? c.after.lines.flatMap((l) => {
            const was = c.before.lines.find((b) => b.lineId === l.lineId);
            return was && (was.packs !== l.packs || was.unitPrice !== l.unitPrice) ? [{ after: l, was }] : [];
          })
          : [];
        return (
          <li key={c.number} className="space-y-1.5 p-5 text-sm" data-testid={`sale-correction-${c.number}`}>
            <div className="font-medium text-stone-900">{t('historyLine', { number: c.number, by: c.by, time: format.dateTime(c.at) })}</div>
            <p className="whitespace-pre-wrap text-stone-700">{c.reason}</p>
            {c.after === null ? <p className="font-medium text-red-800">{t('removed')}</p> : null}
            {c.after && c.after.store?.id !== c.before.store?.id ? (
              <div className="flex flex-wrap gap-2"><span className="text-stone-500">{t('movedStore')}</span><del>{c.before.store?.name}</del><span>{c.after.store?.name}</span></div>
            ) : null}
            {changed.map(({ after, was }) => (
              <div key={after.lineId} className="flex flex-wrap gap-2 tabular-nums">
                <span className="font-medium">{t('line', { code: codeOf(after.lineId) })}</span>
                {was.packs !== after.packs ? <><del className="text-stone-500">{format.number(was.packs)}</del><span>{format.number(after.packs)}</span></> : null}
                {was.unitPrice !== after.unitPrice ? <><del className="text-stone-500">{format.money(was.unitPrice)}</del><span>{format.money(after.unitPrice)}</span></> : null}
              </div>
            ))}
            {c.after ? (
              <div className="flex flex-wrap gap-2 tabular-nums">
                <span className="text-stone-500">{t('total')}</span><del className="text-stone-500">{format.money(c.before.total)}</del><span className="font-semibold">{format.money(c.after.total)}</span>
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-1.5">
              {applied.length > 0 ? (
                <><span className="text-xs text-stone-500">{t('followedBy')}</span>{applied.map((k) => <Badge key={k} tone="neutral">{t(`applied.${k}`)}</Badge>)}</>
              ) : <span className="text-xs text-stone-500">{t('nothingFollowed')}</span>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
