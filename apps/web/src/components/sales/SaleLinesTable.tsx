'use client';

import { useTranslations } from 'next-intl';
import { Cell, Table } from '@/components/common/Table';
import { useFormat } from '@/lib/format';
import type { Sale } from './types';

/** '12.500' → '12.5', '10' → '10'. */
export const trimPercent = (v: string) => (v.includes('.') ? v.replace(/\.?0+$/, '') : v);
const pct = (v: string) => `${trimPercent(v)}%`;

/** SAL-008, PRC-017: each line — price, the discount asked and given, the batches it came from. */
export function SaleLinesTable({ sale, showBatches = false }: { sale: Sale; showBatches?: boolean }) {
  const t = useTranslations('sales');
  const format = useFormat();
  const asked = sale.approval !== null;
  return (
    <Table head={[t('item'), t('packs'), t('unitPrice'), ...(asked ? [t('asked')] : []), t('discount'), t('amount')]}>
      {sale.lines.map((l) => (
        <tr key={l.id} data-testid={`line-${l.code}`}>
          <Cell>
            <div className="font-medium">{format.name(l.product)}{l.variety ? ` — ${format.name(l.variety)}` : ''}</div>
            <div className="text-xs text-stone-500"><bdi dir="ltr">{l.code}</bdi>{` · ${format.size(l.size, l.countUnit)}`}</div>
            {showBatches ? l.batches.map((b) => (
              <div key={b.batchId} className="text-xs text-stone-500">{t('batchLine', { lot: b.lotNumber ?? '—', expiry: b.expiresOn ? format.date(b.expiresOn) : '—', packs: b.packs })}</div>
            )) : null}
          </Cell>
          <Cell>{format.number(l.packs)}</Cell>
          <Cell>{format.money(l.unitPrice)}</Cell>
          {asked ? <Cell>{pct(l.requestedDiscount)}<div className="text-xs text-stone-500">{t('ceilingNote', { ceiling: trimPercent(l.ceiling) })}</div></Cell> : null}
          <Cell>{l.discountAmount === '0.00' ? '—' : <>{pct(l.discount)}<div className="text-xs text-stone-500">{`−${format.money(l.discountAmount)}`}</div></>}</Cell>
          <Cell className="font-medium">{format.money(l.total)}</Cell>
        </tr>
      ))}
      <tr>
        <Cell>{t('total')}</Cell><Cell>{''}</Cell><Cell>{''}</Cell>{asked ? <Cell>{''}</Cell> : null}
        <Cell>{sale.discount === '0.00' ? '—' : `−${format.money(sale.discount)}`}</Cell>
        <Cell className="font-semibold"><span data-testid="sale-total">{format.money(sale.total)}</span></Cell>
      </tr>
    </Table>
  );
}
