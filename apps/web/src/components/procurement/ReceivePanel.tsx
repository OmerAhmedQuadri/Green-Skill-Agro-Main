'use client';

import { Copy, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, Button, Input } from '@gsa/ui';
import { Section } from '@/components/common/Section';
import { Cell, Table } from '@/components/common/Table';
import { api, ApiError } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { wholeNumber } from '@/lib/forms';
import { useCommand, useErrorText } from '@/lib/hooks';
import type { PoDetail, PoLine } from './types';

type Row = { key: number; line: PoLine; packs: string; lotNumber: string; manufacturedOn: string; expiresOn: string; shelfLifeMonths: string; unitCost: string };
let next = 0;
const rowFor = (line: PoLine, packs: number): Row => ({
  key: (next += 1), line, packs: packs > 0 ? String(packs) : '', lotNumber: '', manufacturedOn: '', expiresOn: '', shelfLifeMonths: '', unitCost: line.expectedUnitCost,
});

/**
 * Workflow C step 5, line by line (RCV-003..006). Each row is one batch; a
 * line that arrived as several LOTs is split into rows (RCV-004). Expiry is a
 * date, or a shelf life applied to the manufacturing date — left blank, the
 * product's default shelf life applies (CAT-017).
 */
export function ReceivePanel({ order, onDone }: { order: PoDetail; onDone: (next: PoDetail | null) => void }) {
  const t = useTranslations();
  const format = useFormat();
  const errorText = useErrorText();
  const [rows, setRows] = useState<Row[]>(() => order.lines.filter((l) => l.outstandingPacks > 0).map((l) => rowFor(l, l.outstandingPacks)));
  const receive = useCommand((body: unknown, key) => api<PoDetail>(`/purchase-orders/${order.id}/receipts`, { method: 'POST', body, idempotencyKey: key }), { onSuccess: onDone });
  const failedRow = receive.error instanceof ApiError && typeof receive.error.details?.line === 'number' ? receive.error.details.line : null;
  const set = (key: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const submit = () => {
    const lines = rows.filter((r) => r.packs.trim() !== '').map((r) => ({
      purchaseOrderLineId: r.line.id,
      packs: wholeNumber(r.packs) ?? 0,
      lotNumber: r.lotNumber.trim() || null,
      manufacturedOn: r.manufacturedOn || null,
      expiresOn: r.expiresOn || null,
      shelfLife: wholeNumber(r.shelfLifeMonths) === null ? null : { months: wholeNumber(r.shelfLifeMonths) ?? 0 },
      unitCost: r.unitCost.trim() || null,
    }));
    receive.run({ version: order.version, lines });
  };

  return (
    <Section title={t('receiving.receive')} description={t('receiving.receiveHint')}>
      {receive.error ? (
        <div className="px-5 pt-4">
          <Alert>{failedRow !== null ? t('receiving.onRow', { row: failedRow + 1, message: errorText(receive.error) }) : errorText(receive.error)}</Alert>
        </div>
      ) : null}
      <Table head={[t('catalogue.skuCode'), t('receiving.packs'), t('receiving.lotNumber'), t('receiving.manufacturedOn'), t('receiving.expiresOn'), t('receiving.shelfLifeMonths'), t('receiving.unitCost'), '']}>
        {rows.map((r, i) => {
          const tracks = r.line.receiving;
          return (
            <tr key={r.key} className={failedRow === i ? 'bg-red-50' : ''}>
              <Cell>
                <bdi dir="ltr" className="font-mono">{r.line.code}</bdi>
                <div className="text-xs text-stone-500">{format.name(r.line.product)}</div>
              </Cell>
              <Cell><Input value={r.packs} onChange={(e) => set(r.key, { packs: e.target.value })} inputMode="numeric" dir="ltr" className="w-20" aria-label={t('receiving.packsFor', { code: r.line.code, row: i + 1 })} /></Cell>
              <Cell>{tracks.lotNumber !== 'HIDDEN'
                ? <Input value={r.lotNumber} onChange={(e) => set(r.key, { lotNumber: e.target.value })} dir="ltr" className="w-28" aria-label={t('receiving.lotFor', { row: i + 1 })} /> : '—'}</Cell>
              <Cell>{tracks.manufacturedOn !== 'HIDDEN'
                ? <Input type="date" value={r.manufacturedOn} onChange={(e) => set(r.key, { manufacturedOn: e.target.value })} dir="ltr" className="w-40" aria-label={t('receiving.mfdFor', { row: i + 1 })} /> : '—'}</Cell>
              <Cell>{tracks.expiry !== 'HIDDEN'
                ? <Input type="date" value={r.expiresOn} onChange={(e) => set(r.key, { expiresOn: e.target.value })} dir="ltr" className="w-40" aria-label={t('receiving.expiryFor', { row: i + 1 })} /> : '—'}</Cell>
              <Cell>{tracks.expiry !== 'HIDDEN'
                ? <Input value={r.shelfLifeMonths} onChange={(e) => set(r.key, { shelfLifeMonths: e.target.value })} inputMode="numeric" dir="ltr" className="w-20"
                  placeholder={tracks.shelfLifeMonths ? String(tracks.shelfLifeMonths) : undefined} aria-label={t('receiving.shelfLifeFor', { row: i + 1 })} /> : '—'}</Cell>
              <Cell><Input value={r.unitCost} onChange={(e) => set(r.key, { unitCost: e.target.value })} inputMode="decimal" dir="ltr" className="w-24" aria-label={t('receiving.costFor', { row: i + 1 })} /></Cell>
              <Cell className="text-end">
                <span className="inline-flex">
                  <Button variant="ghost" size="sm" title={t('receiving.split')} aria-label={t('receiving.splitRow', { row: i + 1 })}
                    onClick={() => setRows((rs) => [...rs.slice(0, i + 1), rowFor(r.line, 0), ...rs.slice(i + 1)])}><Copy className="size-4" aria-hidden /></Button>
                  <Button variant="ghost" size="sm" aria-label={t('receiving.removeRow', { row: i + 1 })}
                    onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}><Trash2 className="size-4" aria-hidden /></Button>
                </span>
              </Cell>
            </tr>
          );
        })}
      </Table>
      <div className="flex gap-2 border-t border-stone-200 p-4">
        <Button onClick={submit} disabled={receive.isPending || rows.length === 0}>{receive.isPending ? t('common.saving') : t('receiving.confirmReceipt')}</Button>
        <Button variant="ghost" onClick={() => onDone(null)}>{t('common.cancel')}</Button>
      </div>
    </Section>
  );
}
