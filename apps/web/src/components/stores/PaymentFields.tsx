'use client';

import { dec, type Money } from '@gsa/core';
import { useTranslations } from 'next-intl';
import type { Dispatch, SetStateAction } from 'react';
import { Field, Input, Select } from '@gsa/ui';
import { PhotoCapture } from '@/components/common/PhotoCapture';
import { useFormat } from '@/lib/format';
import { decimalText } from '@/lib/forms';

/** What the seller has filled in so far. */
export type PaymentDraft = {
  readonly amount: string; readonly method: 'CASH' | 'BANK_TRANSFER'; readonly reference: string;
  readonly voucherNumber: string; readonly voucherPhotoId: string | null;
};

export const NO_PAYMENT: PaymentDraft = { amount: '', method: 'CASH', reference: '', voucherNumber: '', voucherPhotoId: null };

export type PaymentBody = {
  readonly amount: string; readonly method: 'CASH' | 'BANK_TRANSFER'; readonly reference: string | null;
  readonly voucher: { readonly number: string; readonly photoId: string };
};

const MONEY = /^\d{1,12}(\.\d{1,2})?$/;

/**
 * The request body once the draft is complete — an amount above nothing and
 * within what is owed, a transfer's reference, the voucher's number and its
 * photo — or null while anything is missing.
 */
export function paymentBody(draft: PaymentDraft, owed: Money): PaymentBody | null {
  const amount = decimalText(draft.amount);
  if (!MONEY.test(amount) || !dec(amount).gt(0) || dec(amount).gt(dec(owed))) return null;
  const reference = draft.reference.trim();
  if (draft.method === 'BANK_TRANSFER' && !reference) return null;
  if (!draft.voucherNumber.trim() || !draft.voucherPhotoId) return null;
  return {
    amount, method: draft.method, reference: draft.method === 'BANK_TRANSFER' ? reference : null,
    voucher: { number: draft.voucherNumber.trim(), photoId: draft.voucherPhotoId },
  };
}

/**
 * CRD-003, ADR-0047: money taken from a store — any part of what it owes,
 * which the seller sees as they type — and the voucher handed over for it:
 * the number printed on the slip, and a photo of it from the live camera.
 * Takes the state setter itself, so a photo that finishes uploading after
 * more was typed never puts back what the form held before.
 */
export function PaymentFields({ id, owed, value, onChange }: {
  id: string; owed: Money; value: PaymentDraft; onChange: Dispatch<SetStateAction<PaymentDraft>>;
}) {
  const t = useTranslations('stores');
  const format = useFormat();
  const set = (patch: Partial<PaymentDraft>) => onChange((previous) => ({ ...previous, ...patch }));
  const typed = decimalText(value.amount);
  const tooMuch = MONEY.test(typed) && dec(typed).gt(dec(owed));
  return (
    <div className="space-y-3" data-testid={`${id}-payment`}>
      <Field
        id={`${id}-amount`} label={t('amount')} hint={t('owedHint', { amount: format.money(owed) })}
        error={tooMuch ? t('moreThanOwed', { amount: format.money(owed) }) : undefined}
      >
        <Input id={`${id}-amount`} inputMode="decimal" dir="ltr" value={value.amount} onChange={(e) => set({ amount: e.target.value })} />
      </Field>
      <Field id={`${id}-method`} label={t('method')}>
        <Select id={`${id}-method`} value={value.method} onChange={(e) => set({ method: e.target.value === 'BANK_TRANSFER' ? 'BANK_TRANSFER' : 'CASH' })}>
          <option value="CASH">{t('methods.CASH')}</option>
          <option value="BANK_TRANSFER">{t('methods.BANK_TRANSFER')}</option>
        </Select>
      </Field>
      {value.method === 'BANK_TRANSFER' ? (
        <Field id={`${id}-reference`} label={t('reference')}>
          <Input id={`${id}-reference`} dir="ltr" maxLength={100} value={value.reference} onChange={(e) => set({ reference: e.target.value })} />
        </Field>
      ) : null}
      <Field id={`${id}-voucher`} label={t('voucherNumber')} hint={t('voucherHint')}>
        <Input id={`${id}-voucher`} dir="ltr" maxLength={60} value={value.voucherNumber} onChange={(e) => set({ voucherNumber: e.target.value })} />
      </Field>
      <PhotoCapture id={`${id}-voucher-photo`} kind="PAYMENT_VOUCHER" label={t('voucherPhoto')} onChange={(photoId) => set({ voucherPhotoId: photoId })} />
    </div>
  );
}
