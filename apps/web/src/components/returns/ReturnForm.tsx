'use client';

import { creditFor, splitCredit, sumMoney, type Money, type ReturnCondition, type ReturnKind } from '@gsa/core';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, Button, Card, Checkbox, Field, Input, Select } from '@gsa/ui';
import { api, ApiError } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { wholeNumber } from '@/lib/forms';
import { useErrorText, useOnceCommand } from '@/lib/hooks';
import type { Returnable, ReturnRecord } from './types';

const keyOf = (saleLineId: string, batchId: string) => `${saleLineId}|${batchId}`;

/**
 * Workflow L (RET-001..012, OQ-020): goods back from a sale. The seller picks
 * the condition that applies — each shows its window — then the packs, batch
 * by batch. Defective goods are replaced from the vehicle or credited; a
 * credit settles this sale, then the store's other debts, and anything left
 * is cash back. The figures are core's own, so what shows is what posts.
 */
export function ReturnForm({ returnable: r, onDone }: { returnable: Returnable; onDone: (created: ReturnRecord) => void }) {
  const t = useTranslations('returns');
  const format = useFormat();
  const errorText = useErrorText();
  const open = r.conditions.filter((c) => !c.blockedBy);
  const onVehicle = r.place.kind === 'VEHICLE';
  const [condition, setCondition] = useState<ReturnCondition | null>(open[0]?.condition ?? null);
  const [kind, setKind] = useState<ReturnKind>('CREDIT_NOTE');
  const [packs, setPacks] = useState<Record<string, string>>({});
  const [unsaleable, setUnsaleable] = useState<Record<string, boolean>>({});
  const [warehouseId, setWarehouseId] = useState(r.place.kind === 'WAREHOUSE' ? (r.place.warehouses[0]?.id ?? '') : '');
  const [note, setNote] = useState('');
  const save = useOnceCommand((body: unknown, key) => api<ReturnRecord>('/returns', { method: 'POST', body, idempotencyKey: key }), { onSuccess: onDone });

  const replacing = condition === 'DEFECTIVE' && kind === 'REPLACEMENT';
  const lines = r.lines.flatMap((l) => l.batches.map((b) => ({ line: l, batch: b, packs: wholeNumber(packs[keyOf(l.saleLineId, b.batchId)]) ?? 0 })))
    .filter((x) => x.packs > 0);
  const tooMany = lines.some((x) => x.packs > x.batch.packs);

  // The credit, as core prices it (ADR-0039), and where the money goes (OQ-020).
  let amount: Money | null = null;
  let split: ReturnType<typeof splitCredit> | null = null;
  let problem: string | null = null;
  if (condition && !replacing && lines.length > 0 && !tooMany) {
    const credited = new Map(r.lines.map((l) => [l.saleLineId, l.credited]));
    try {
      amount = sumMoney(lines.map((x) => {
        const before = credited.get(x.line.saleLineId) ?? 0;
        credited.set(x.line.saleLineId, before + x.packs);
        return creditFor({ total: x.line.total, packs: x.line.packs }, before, x.packs);
      }));
      split = splitCredit(amount, condition, r.unpaid, r.otherDebts);
    } catch (e) {
      problem = e instanceof Error && 'code' in e ? String((e as { code: unknown }).code) : 'INTERNAL_ERROR';
    }
  }
  const refundTooBig = split && r.place.kind === 'VEHICLE' && Number(split.refund) > Number(r.place.cashInHand);
  const refundFromConsole = split && !onVehicle && Number(split.refund) > 0;
  const ready = condition && lines.length > 0 && !tooMany && !problem && !refundTooBig && !refundFromConsole && (onVehicle || warehouseId);

  if (r.place.kind === 'VEHICLE' && r.place.notWorking) {
    return <Alert data-testid="not-working">{errorText(new ApiError(409, r.place.notWorking))}</Alert>;
  }
  return (
    <div className="space-y-4">
      <Card className="space-y-3 p-4">
        <p className="font-semibold">{t('why')}</p>
        <div className="grid gap-2" role="radiogroup" aria-label={t('why')}>
          {r.conditions.map((c) => (
            <label key={c.condition} className="flex items-start gap-3 rounded-md border border-stone-200 p-3 text-sm" data-testid={`condition-${c.condition}`}>
              <input type="radio" name="condition" className="mt-1 accent-brand-700" disabled={Boolean(c.blockedBy)} checked={condition === c.condition}
                onChange={() => { setCondition(c.condition); if (c.condition !== 'DEFECTIVE') setKind('CREDIT_NOTE'); }} />
              <span>
                <span className="block font-medium">{t(`conditions.${c.condition}`)}</span>
                <span className="block text-stone-600">
                  {c.blockedBy ? t(`blocked.${c.blockedBy}`) : t('daysLeft', { days: c.daysLeft })}
                </span>
              </span>
            </label>
          ))}
        </div>
        {condition === 'UNCLEARED_PAYMENT' ? <p className="text-sm text-stone-600">{t('unpaidNote', { unpaid: format.money(r.unpaid) })}</p> : null}
        {condition === 'DEFECTIVE' && onVehicle ? (
          <Field id="outcome" label={t('outcome')}>
            <Select id="outcome" value={kind} onChange={(e) => setKind(e.target.value === 'REPLACEMENT' ? 'REPLACEMENT' : 'CREDIT_NOTE')}>
              <option value="REPLACEMENT">{t('outcomeOptions.REPLACEMENT')}</option>
              <option value="CREDIT_NOTE">{t('outcomeOptions.CREDIT_NOTE')}</option>
            </Select>
          </Field>
        ) : null}
        {!open.length ? <Alert tone="warning" data-testid="no-condition">{t('nothingOpen')}</Alert> : null}
      </Card>

      <Card className="space-y-4 p-4">
        <p className="font-semibold">{t('whatComesBack')}</p>
        {r.lines.every((l) => l.batches.length === 0) ? <p className="text-sm text-stone-500">{t('nothingHeld')}</p> : null}
        {r.lines.flatMap((l) => l.batches.map((b) => {
          const k = keyOf(l.saleLineId, b.batchId);
          const lot = b.lotNumber ?? '—';
          return (
            <fieldset key={k} className="space-y-2 border-b border-stone-100 pb-3 last:border-0" data-testid={`return-${l.code}-${lot}`}>
              <legend className="text-sm">
                <span className="font-medium">{format.name(l.product)}{l.variety ? ` — ${format.name(l.variety)}` : ''}</span>
                {' · '}<bdi dir="ltr">{l.code}</bdi>
              </legend>
              <p className="text-xs text-stone-500">
                {t('batchHeld', { lot, expiry: b.expiresOn ? format.date(b.expiresOn) : '—', packs: b.packs })}
                {b.expired ? ` · ${t('expired')}` : ''}
              </p>
              <Field id={`rt-${k}`} label={t('packsFor', { code: l.code, lot })}>
                <Input id={`rt-${k}`} inputMode="numeric" dir="ltr" value={packs[k] ?? ''} onChange={(e) => setPacks({ ...packs, [k]: e.target.value })} />
              </Field>
              {condition === 'UNCLEARED_PAYMENT' && !b.expired ? (
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={unsaleable[k] ?? false} onChange={(e) => setUnsaleable({ ...unsaleable, [k]: e.target.checked })} aria-label={t('unsaleableFor', { code: l.code, lot })} />
                  {t('unsaleable')}
                </label>
              ) : null}
            </fieldset>
          );
        }))}
        {tooMany ? <Alert>{t('tooMany')}</Alert> : null}
      </Card>

      {amount && split ? (
        <Card className="space-y-1 p-4 text-sm" data-testid="credit-preview">
          <div className="flex justify-between font-semibold"><span>{t('creditTotal')}</span><span data-testid="credit-amount">{format.money(amount)}</span></div>
          <div className="flex justify-between"><span>{t('toSale')}</span><span>{format.money(split.toSale)}</span></div>
          <div className="flex justify-between"><span>{t('toOtherDebts')}</span><span>{format.money(split.toOtherDebts)}</span></div>
          <div className="flex justify-between"><span>{t('refund')}</span><span data-testid="refund">{format.money(split.refund)}</span></div>
          {Number(split.refund) > 0 && onVehicle ? <p className="pt-1 text-stone-600">{t('refundHint')}</p> : null}
        </Card>
      ) : null}
      {replacing && lines.length > 0 ? <Alert tone="info" data-testid="replace-preview">{t('replaceHint', { packs: lines.reduce((n, x) => n + x.packs, 0) })}</Alert> : null}
      {problem ? <Alert>{errorText(new ApiError(409, problem))}</Alert> : null}
      {refundTooBig && r.place.kind === 'VEHICLE' ? <Alert data-testid="refund-too-big">{t('refundTooBig', { cash: format.money(r.place.cashInHand) })}</Alert> : null}
      {refundFromConsole ? <Alert>{errorText(new ApiError(409, 'REFUND_NEEDS_SELLER'))}</Alert> : null}

      <Card className="space-y-3 p-4">
        {r.place.kind === 'WAREHOUSE' ? (
          <Field id="warehouse" label={t('toWarehouse')}>
            <Select id="warehouse" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
              {r.place.warehouses.map((w) => <option key={w.id} value={w.id}>{format.name(w.name)}</option>)}
            </Select>
          </Field>
        ) : null}
        <Field id="note" label={t('note')}><Input id="note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} /></Field>
        {save.error ? <Alert>{errorText(save.error)}</Alert> : null}
        <Button block disabled={!ready || save.isPending} onClick={() => condition && save.run({
          saleId: r.sale.id, kind: condition === 'DEFECTIVE' ? kind : 'CREDIT_NOTE', condition, note: note.trim() || null,
          warehouseId: r.place.kind === 'WAREHOUSE' ? warehouseId : null,
          lines: lines.map((x) => ({
            saleLineId: x.line.saleLineId, batchId: x.batch.batchId, packs: x.packs,
            saleable: condition === 'UNCLEARED_PAYMENT' ? !(unsaleable[keyOf(x.line.saleLineId, x.batch.batchId)] ?? false) : false,
          })),
        })}>{save.isPending ? t('saving') : replacing ? t('recordReplacement') : t('recordCredit')}</Button>
      </Card>
    </div>
  );
}
