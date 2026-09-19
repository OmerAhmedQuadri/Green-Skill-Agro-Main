'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Card, Field, Input } from '@gsa/ui';
import { PageHeader } from '@/components/common/PageHeader';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { wholeNumber } from '@/lib/forms';
import { useCommand, useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import type { ClosingDeclaration, MyVehicle } from './types';

/**
 * Workflow G step 5 (STK-010, 011; ADR-0033): count what is left on the
 * vehicle, SKU by SKU. The count is not shown beforehand — it is the seller's
 * declaration. A difference goes to a manager; nothing is adjusted.
 */
export function ClosingScreen() {
  const t = useTranslations('field');
  const format = useFormat();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const [result, setResult] = useState<ClosingDeclaration | null>(null);
  const vehicle = useQuery({ queryKey: keys.myVehicle, queryFn: () => api<MyVehicle>('/stock/my-vehicle') });
  const declare = useCommand((body: unknown, key) => api<ClosingDeclaration>('/closing-stock-declarations', { method: 'POST', body, idempotencyKey: key }), {
    onSuccess: (d) => { setResult(d); void queryClient.invalidateQueries({ queryKey: keys.today }); },
  });
  const skus = [...new Map((vehicle.data?.batches ?? []).map((b) => [b.skuId, b])).values()];

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    declare.run({
      lines: skus.map((s) => {
        const raw = f.get(`packs-${s.skuId}`);
        return { skuId: s.skuId, packs: typeof raw === 'string' ? (wholeNumber(raw) ?? 0) : 0 };
      }),
    });
  };

  if (result) {
    return (
      <div className="space-y-4">
        <PageHeader title={t('closingTitle')} back={{ href: '/field/today', label: t('backToToday') }} />
        <Alert tone={result.status === 'MATCHED' ? 'success' : 'warning'}>{t(result.status === 'MATCHED' ? 'closingMatched' : 'closingFlagged')}</Alert>
        <Card>
          <ul className="divide-y divide-stone-100 text-sm">
            {result.lines.map((l) => (
              <li key={l.skuId} className="flex items-center justify-between p-3">
                <bdi dir="ltr" className="font-mono">{l.code}</bdi>
                <span>{t('declaredPacks', { count: l.declaredPacks })}{l.variancePacks !== 0 ? <Badge tone="warning" className="ms-2">{t('difference', { count: l.variancePacks })}</Badge> : null}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader title={t('closingTitle')} subtitle={t('closingHint')} back={{ href: '/field/today', label: t('backToToday') }} />
      {vehicle.error ? <Alert>{errorText(vehicle.error)}</Alert> : null}
      <form className="space-y-4" noValidate onSubmit={submit}>
        {declare.error ? <Alert>{errorText(declare.error)}</Alert> : null}
        <Card className="divide-y divide-stone-100">
          {skus.length === 0 && vehicle.data ? <p className="p-4 text-sm text-stone-500">{t('emptyVehicle')}</p> : null}
          {skus.map((s) => (
            <div key={s.skuId} className="p-4">
              <Field id={`packs-${s.skuId}`} label={<span><bdi dir="ltr" className="font-mono">{s.code}</bdi>{' · '}{format.name(s.product)}</span>}>
                <Input id={`packs-${s.skuId}`} name={`packs-${s.skuId}`} inputMode="numeric" dir="ltr" autoComplete="off" />
              </Field>
            </div>
          ))}
        </Card>
        <Button type="submit" block disabled={declare.isPending || !vehicle.data}>{declare.isPending ? t('sending') : t('declare')}</Button>
      </form>
    </div>
  );
}
