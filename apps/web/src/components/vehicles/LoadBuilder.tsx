'use client';

import { useQuery } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, Badge, Button, Input, Select } from '@gsa/ui';
import type { Page, SkuSummary } from '@/components/catalogue/types';
import { Section } from '@/components/common/Section';
import { Cell, Table } from '@/components/common/Table';
import { api, ApiError } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useCommand, useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import type { Load, LoadProposal } from './types';

type Row = { skuId: string; packs: string };
const whole = (v: string) => (/^\d+$/.test(v) ? Number.parseInt(v, 10) : 0);

/**
 * Workflow F steps 2–3 (VEH-005, 006): choose SKUs and packs; batches are
 * proposed first-expiry-first-out, flagged ones on top, and may be changed.
 * Over the vehicle's ceiling the manager is warned, and may go ahead.
 */
export function LoadBuilder({ vehicleId, onDone }: { vehicleId: string; onDone: (load: Load | null) => void }) {
  const t = useTranslations();
  const format = useFormat();
  const errorText = useErrorText();
  const [rows, setRows] = useState<Row[]>([{ skuId: '', packs: '' }]);
  const [proposal, setProposal] = useState<LoadProposal[] | null>(null);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [proposing, setProposing] = useState(false);
  const [proposeError, setProposeError] = useState<unknown>(null);
  const skus = useQuery({
    queryKey: keys.skus({ active: true, all: true }),
    queryFn: () => api<Page<SkuSummary>>('/skus?isActive=true&limit=200'),
  });
  const issue = useCommand((body: { acknowledgeCeiling: boolean }, key) => api<Load>('/vehicle-loads', {
    method: 'POST', idempotencyKey: key,
    body: { vehicleId, acknowledgeCeiling: body.acknowledgeCeiling, lines: Object.entries(picked).map(([batchId, p]) => ({ batchId, packs: whole(p) })).filter((l) => l.packs > 0) },
  }), { onSuccess: onDone });

  const propose = async () => {
    setProposing(true);
    setProposeError(null);
    try {
      const qs = new URLSearchParams();
      for (const r of rows) if (r.skuId && whole(r.packs) > 0) qs.append('line', `${r.skuId}:${whole(r.packs)}`);
      const result = await api<LoadProposal[]>(`/vehicle-loads/proposal?${qs.toString()}`);
      setProposal(result);
      setPicked(Object.fromEntries(result.flatMap((p) => p.batches.filter((b) => b.packs > 0).map((b) => [b.batchId, String(b.packs)]))));
    } catch (e) {
      setProposeError(e);
    } finally {
      setProposing(false);
    }
  };
  const warning = issue.error instanceof ApiError && issue.error.code === 'CEILING_WARNING' ? issue.error.details as Record<string, string | null> : null;

  return (
    <Section title={t('vehicles.newLoad')} description={t('vehicles.newLoadHint')}>
      <div className="space-y-4 p-5">
        {rows.map((row, i) => (
          <div key={i} className="flex flex-wrap items-end gap-2">
            <Select aria-label={t('vehicles.sku')} value={row.skuId} className="min-w-64 flex-1"
              onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, skuId: e.target.value } : r)))}>
              <option value="">{t('common.choose')}</option>
              {(skus.data?.items ?? []).map((s) => <option key={s.id} value={s.id}>{`${s.code} · ${format.name(s.product)}`}</option>)}
            </Select>
            <Input aria-label={t('vehicles.packsWanted')} value={row.packs} inputMode="numeric" dir="ltr" className="w-24"
              onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, packs: e.target.value } : r)))} />
            {rows.length > 1 ? <Button variant="ghost" size="sm" aria-label={t('common.remove')} onClick={() => setRows(rows.filter((_, j) => j !== i))}><Trash2 className="size-4" aria-hidden /></Button> : null}
          </div>
        ))}
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => setRows([...rows, { skuId: '', packs: '' }])}><Plus className="size-4" aria-hidden />{t('vehicles.addLine')}</Button>
          <Button variant="secondary" onClick={() => void propose()} disabled={proposing}>{proposing ? t('common.loading') : t('vehicles.propose')}</Button>
        </div>
        {proposeError ? <Alert>{errorText(proposeError)}</Alert> : null}
      </div>

      {proposal ? (
        <div className="border-t border-stone-200">
          {proposal.map((p) => (
            <div key={p.skuId} className="border-b border-stone-100">
              <div className="flex flex-wrap items-center gap-2 px-5 pt-4 text-sm font-medium">
                <bdi dir="ltr" className="font-mono">{p.code}</bdi>{format.name(p.product)}
                {p.shortfallPacks > 0 ? <Badge tone="danger">{t('vehicles.shortfall', { count: p.shortfallPacks })}</Badge> : null}
                {p.unitPrice === null ? <Badge tone="warning">{t('vehicles.unpriced')}</Badge> : null}
              </div>
              <Table head={[t('receiving.lotNumber'), t('receiving.expiresOn'), t('vehicles.available'), t('vehicles.packsToLoad')]}>
                {p.batches.map((b) => (
                  <tr key={b.batchId} data-testid={`proposed-${b.lotNumber ?? b.batchId}`}>
                    <Cell><bdi dir="ltr">{b.lotNumber ?? '—'}</bdi>{b.flagged ? <Badge tone="warning" className="ms-2">{t('vehicles.flagged')}</Badge> : null}</Cell>
                    <Cell>{b.expiresOn ? format.date(b.expiresOn) : '—'}</Cell>
                    <Cell>{format.number(b.availablePacks)}</Cell>
                    <Cell>
                      <Input aria-label={t('vehicles.packsFrom', { lot: b.lotNumber ?? '—' })} value={picked[b.batchId] ?? ''} inputMode="numeric" dir="ltr" className="w-24"
                        onChange={(e) => setPicked({ ...picked, [b.batchId]: e.target.value })} />
                    </Cell>
                  </tr>
                ))}
              </Table>
            </div>
          ))}
          <div className="space-y-3 p-5">
            {warning ? (
              <Alert tone="warning" data-testid="ceiling-warning">
                {t('vehicles.ceilingWarning', {
                  projected: format.money(warning.projected ?? '0'), ceiling: format.money(warning.ceiling ?? '0'), excess: format.money(warning.excess ?? '0'),
                })}
              </Alert>
            ) : issue.error ? <Alert>{errorText(issue.error)}</Alert> : null}
            <div className="flex gap-2">
              {warning
                ? <Button variant="danger" onClick={() => issue.run({ acknowledgeCeiling: true })} disabled={issue.isPending}>{t('vehicles.issueAnyway')}</Button>
                : <Button onClick={() => issue.run({ acknowledgeCeiling: false })} disabled={issue.isPending}>{issue.isPending ? t('common.saving') : t('vehicles.issueLoad')}</Button>}
              <Button variant="ghost" onClick={() => onDone(null)}>{t('common.cancel')}</Button>
            </div>
          </div>
        </div>
      ) : null}
    </Section>
  );
}
