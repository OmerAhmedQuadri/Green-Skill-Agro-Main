'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Card, Field, Input, Select } from '@gsa/ui';
import { PageHeader } from '@/components/common/PageHeader';
import { Cell, Table } from '@/components/common/Table';
import { Section } from '@/components/common/Section';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { decimalText, formText } from '@/lib/forms';
import { useErrorText, useOnceCommand } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import { TargetProgressBars } from './TargetProgressBars';
import type { SellerTarget, TargetGoals, TargetStanding } from './types';

/** The last twelve months, newest first — targets are monthly (TGT-002). */
function recentPeriods(count = 12): string[] {
  const out: string[] = [];
  const cursor = new Date();
  for (let i = 0; i < count; i += 1) {
    out.push(cursor.toISOString().slice(0, 7));
    cursor.setUTCMonth(cursor.getUTCMonth() - 1, 15);
  }
  return out;
}

/**
 * TGT-001..005, COM-004 (ADR-0042): every seller's month — the figures set for
 * them, where they stand, and the commission that follows. A frozen month is
 * shown as it was, and cannot be retargeted.
 */
export function TargetsPage({ canManage }: { canManage: boolean }) {
  const t = useTranslations('targets');
  const format = useFormat();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const periods = recentPeriods();
  const [period, setPeriod] = useState(periods[0] ?? '');
  const [editing, setEditing] = useState<string | null>(null);

  const standings = useQuery({ queryKey: keys.standings(period), queryFn: () => api<{ items: TargetStanding[] }>(`/targets/standings?period=${period}`) });
  const targets = useQuery({
    queryKey: keys.targets(period), queryFn: () => api<{ items: SellerTarget[] }>(`/targets?period=${period}`), enabled: canManage,
  });
  const save = useOnceCommand((body: unknown, key) => api<SellerTarget>('/targets', { method: 'PUT', body, idempotencyKey: key }), {
    onSuccess: () => {
      setEditing(null);
      for (const k of [keys.targets(period), keys.standings(period)]) void queryClient.invalidateQueries({ queryKey: k });
    },
  });

  const goalsFor = (sellerId: string): TargetGoals => targets.data?.items.find((x) => x.seller.id === sellerId)?.goals ?? {};

  const submit = (sellerId: string) => (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    const text = (name: string) => formText(f, name).trim();
    const goals: TargetGoals = {
      ...(text('REVENUE') ? { REVENUE: decimalText(text('REVENUE')) } : {}),
      ...(text('PACKS_SOLD') ? { PACKS_SOLD: text('PACKS_SOLD') } : {}),
      ...(text('NEW_STORES') ? { NEW_STORES: text('NEW_STORES') } : {}),
      ...(text('COLLECTED') ? { COLLECTED: decimalText(text('COLLECTED')) } : {}),
    };
    save.run({ sellerId, period, goals, note: null });
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title={t('listTitle')} subtitle={t('listSubtitle')} />

      <Card className="flex flex-wrap items-end gap-3 p-4">
        <Field id="period" label={t('period')}>
          <Select id="period" value={period} onChange={(e) => { setPeriod(e.target.value); setEditing(null); }}>
            {periods.map((p) => <option key={p} value={p}>{p}</option>)}
          </Select>
        </Field>
      </Card>

      {save.error ? <Alert>{errorText(save.error)}</Alert> : null}
      {standings.error ? <Alert>{errorText(standings.error)}</Alert> : null}

      <Section title={t('standingsTitle')}>
        {standings.data?.items.length === 0 ? <p className="p-5 text-sm text-stone-500">{t('noSellers')}</p> : (
          <Table head={[t('seller'), t('progress'), t('baseHead'), t('commissionHead'), t('stateHead')]}>
            {standings.data?.items.map((s) => (
              <tr key={s.seller.id} data-testid={`standing-${s.seller.id}`}>
                <Cell className="align-top font-medium">
                  {s.seller.name}
                  {s.behindPace ? <div className="mt-1"><Badge tone="warning" data-testid={`pace-${s.seller.id}`}>{t('behindPaceShort')}</Badge></div> : null}
                </Cell>
                <Cell className="align-top">
                  <div className="max-w-sm"><TargetProgressBars metrics={s.progress.metrics} testIdPrefix={`m-${s.seller.id}`} /></div>
                  {canManage && !s.final ? (
                    editing === s.seller.id ? (
                      <form className="mt-3 flex flex-wrap items-end gap-2" noValidate onSubmit={submit(s.seller.id)}>
                        {(['REVENUE', 'PACKS_SOLD', 'NEW_STORES', 'COLLECTED'] as const).map((metric) => (
                          <Field key={metric} id={`${metric}-${s.seller.id}`} label={t(`metrics.${metric}`)}>
                            <Input id={`${metric}-${s.seller.id}`} name={metric} inputMode="decimal" dir="ltr" className="w-28"
                              defaultValue={goalsFor(s.seller.id)[metric] ?? ''} />
                          </Field>
                        ))}
                        <Button type="submit" size="sm" disabled={save.isPending}>{t('saveTarget')}</Button>
                        <Button type="button" size="sm" variant="secondary" onClick={() => setEditing(null)}>{t('cancel')}</Button>
                      </form>
                    ) : (
                      <Button className="mt-2" size="sm" variant="secondary" data-testid={`set-${s.seller.id}`} onClick={() => setEditing(s.seller.id)}>
                        {s.goals ? t('changeTarget') : t('setTarget')}
                      </Button>
                    )
                  ) : null}
                </Cell>
                <Cell className="align-top" data-testid={`base-${s.seller.id}`}>{format.money(s.base)}</Cell>
                <Cell className="align-top" data-testid={`commission-${s.seller.id}`}>
                  {s.commission === null ? <span className="text-stone-500">{t('noRate')}</span> : format.money(s.commission)}
                  {s.rate ? <div className="text-xs text-stone-500"><bdi dir="ltr">{format.percent(s.rate)}</bdi></div> : null}
                </Cell>
                <Cell className="align-top">
                  <Badge tone={s.final ? 'neutral' : 'warning'}>{s.final ? t('final') : t('live')}</Badge>
                </Cell>
              </tr>
            ))}
          </Table>
        )}
      </Section>
      {/* COM-008: what "final" means, said once where it is shown. */}
      <p className="text-sm text-stone-500">{t('finalHint')}</p>
    </div>
  );
}
