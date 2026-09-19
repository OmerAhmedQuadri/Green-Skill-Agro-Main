'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Badge } from '@gsa/ui';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { keys } from '@/lib/query-keys';
import type { Page } from '@/components/sales/types';
import type { ReturnSummary } from './types';

/** RET-001: the returns raised against one sale, newest first, and the way to raise another. */
export function SaleReturns({ saleId, surface, canReturn }: { saleId: string; surface: 'field' | 'console'; canReturn: boolean }) {
  const t = useTranslations('returns');
  const format = useFormat();
  const list = useQuery({ queryKey: keys.returns({ saleId }), queryFn: () => api<Page<ReturnSummary>>(`/returns?saleId=${saleId}`) });
  const base = surface === 'field' ? '/field' : '/console';
  const items = list.data?.items ?? [];
  return (
    <div className="space-y-2" data-testid="sale-returns">
      {items.length > 0 ? (
        <ul className="divide-y divide-stone-100 text-sm">
          {items.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 py-2">
              <Link href={`${base}/returns/${r.id}`} className="min-w-0 font-medium underline"><bdi dir="ltr">{r.number}</bdi></Link>
              <span className="flex items-center gap-2">
                <Badge tone={r.kind === 'CREDIT_NOTE' ? 'warning' : 'neutral'}>{t(`kinds.${r.kind}`)}</Badge>
                <span>{t('packsCount', { packs: r.packs })}</span>
                {r.kind === 'CREDIT_NOTE' ? <span>{format.money(r.amount)}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {canReturn ? (
        <Link href={`${base}/sales/${saleId}/return`} className="inline-flex h-11 w-full items-center justify-center rounded-md border border-stone-300 text-sm font-medium" data-testid="start-return">
          {t('start')}
        </Link>
      ) : null}
    </div>
  );
}
