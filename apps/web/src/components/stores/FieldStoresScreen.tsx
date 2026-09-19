'use client';

import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Plus } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Alert, Badge, Card } from '@gsa/ui';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import { STATUS_TONE, type StoreSummary } from './types';

/** STO-006: the seller's portfolio — each store's status and whether it can be sold to now. */
export function FieldStoresScreen() {
  const t = useTranslations('stores');
  const format = useFormat();
  const errorText = useErrorText();
  const list = useQuery({ queryKey: keys.stores(), queryFn: () => api<StoreSummary[]>('/stores') });
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t('myStores')}</h1>
        <Link href="/field/stores/new" className="inline-flex h-10 items-center gap-1.5 rounded-md bg-brand-700 px-3 text-sm font-medium text-white">
          <Plus className="size-4" aria-hidden />{t('onboard')}
        </Link>
      </div>
      {list.error ? <Alert>{errorText(list.error)}</Alert> : null}
      {list.data?.length === 0 ? <p className="text-sm text-stone-600">{t('noStores')}</p> : null}
      <div className="space-y-2">
        {(list.data ?? []).map((s) => (
          <Link key={s.id} href={`/field/stores/${s.id}`} className="block" data-testid={`store-${s.name}`}>
            <Card className="flex items-center gap-3 p-4">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{s.name}</div>
                <div className="text-sm text-stone-600">{t('owes', { amount: format.money(s.credit.outstanding) })}</div>
                <div className="mt-1 flex flex-wrap gap-1">
                  <Badge tone={STATUS_TONE[s.status]}>{t(`statuses.${s.status}`)}</Badge>
                  {s.status === 'ACTIVE' && s.credit.blocked ? <Badge tone="danger">{t('blocked')}</Badge> : null}
                </div>
              </div>
              <ChevronRight className="size-4 text-stone-400 rtl:rotate-180" aria-hidden />
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
