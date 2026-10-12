'use client';

import { dec, toMoney, type Money } from '@gsa/core';
import { useTranslations } from 'next-intl';
import type { Dispatch, SetStateAction } from 'react';
import { cn, Field, Input, Select } from '@gsa/ui';
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
 *
 * `fullAmount` (ADR-0052): an open sale is paid exactly in full, so there is
 * no amount to type — the caller builds the body with that sum.
 */
export function PaymentFields({ id, owed, value, onChange, fullAmount, amountHint, amountError }: {
  id: string; owed: Money; value: PaymentDraft; onChange: Dispatch<SetStateAction<PaymentDraft>>; fullAmount?: Money | undefined;
  /** What the amount is held to, when the caller says more than what is owed (ADR-0055). */ amountHint?: string | undefined; amountError?: string | undefined;
}) {
  const t = useTranslations('stores');
  const format = useFormat();
  const set = (patch: Partial<PaymentDraft>) => onChange((previous) => ({ ...previous, ...patch }));
  const typed = decimalText(value.amount);
  const tooMuch = MONEY.test(typed) && dec(typed).gt(dec(owed));
  return (
    <div className="space-y-3" data-testid={`${id}-payment`}>
      {fullAmount ? <p className="text-sm font-medium" data-testid={`${id}-full-amount`}>{t('paidInFullAmount', { amount: format.money(fullAmount) })}</p> : (
        <Field
          id={`${id}-amount`} label={t('amount')} hint={amountHint ?? t('owedHint', { amount: format.money(owed) })}
          error={tooMuch ? t('moreThanOwed', { amount: format.money(owed) }) : amountError}
        >
          <Input id={`${id}-amount`} inputMode="decimal" dir="ltr" value={value.amount} onChange={(e) => set({ amount: e.target.value })} />
        </Field>
      )}
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

/** ADR-0055: how a store pays for a sale or a delivery — named as the choice it is, credit first. */
export const PAYMENT_WAYS = ['CREDIT', 'PART', 'FULL'] as const;
export type PaymentWay = (typeof PAYMENT_WAYS)[number];

/**
 * The payment a choice comes to: none on credit; part of the total; or all of
 * it — more settles older bills too, up to all that is owed (ADR-0047). Null
 * while the choice is not complete.
 */
export function choiceBody(way: PaymentWay, draft: PaymentDraft, total: Money, owed: Money): PaymentBody | null {
  if (way === 'CREDIT') return null;
  const body = paymentBody(draft, owed);
  if (!body) return null;
  if (way === 'PART' && !dec(body.amount).lt(dec(total))) return null;
  if (way === 'FULL' && dec(body.amount).lt(dec(total))) return null;
  return body;
}

/** On credit is ready as it is; paying now, once the payment is complete. */
export const choiceReady = (way: PaymentWay, body: PaymentBody | null): boolean => way === 'CREDIT' || body !== null;

/**
 * ADR-0055 (SAL-006, CRD-001): how the store pays — on credit, part now and
 * the rest on credit, or in full now — with what goes on its account and when
 * it falls due by the store's cycle; for bill to bill, before its next bill.
 * Money taken now is cash or a bank transfer, with its voucher (ADR-0047).
 */
export function PaymentChoice({ id, total, owed, dueIfOnCredit, billToBill, way, onWay, value, onChange }: {
  id: string; total: Money; owed: Money; dueIfOnCredit: string; billToBill: boolean;
  way: PaymentWay; onWay: (way: PaymentWay) => void; value: PaymentDraft; onChange: Dispatch<SetStateAction<PaymentDraft>>;
}) {
  const t = useTranslations('stores.pay');
  const format = useFormat();
  const typed = decimalText(value.amount);
  const amount = MONEY.test(typed) ? dec(typed) : null;
  const choose = (next: PaymentWay) => {
    onWay(next);
    // In full starts at the total; part starts empty.
    if (next === 'FULL') onChange((previous) => ({ ...previous, amount: total }));
    if (next === 'PART') onChange((previous) => ({ ...previous, amount: '' }));
  };
  const totalText = format.money(total);
  const date = format.date(dueIfOnCredit);
  let summary: string | null = null;
  let amountError: string | undefined;
  if (way === 'CREDIT') {
    summary = billToBill ? t('onCreditBill', { amount: totalText }) : t('onCredit', { amount: totalText, date });
  } else if (way === 'PART') {
    if (amount && amount.gt(0) && amount.lt(dec(total))) {
      const paid = format.money(toMoney(amount));
      const rest = format.money(toMoney(dec(total).minus(amount)));
      summary = billToBill ? t('partBill', { paid, rest }) : t('part', { paid, rest, date });
    } else if (amount && amount.gte(dec(total))) amountError = t('partTooMuch', { total: totalText });
  } else if (amount && amount.gte(dec(total))) {
    const older = amount.minus(dec(total));
    summary = older.gt(0) ? t('fullOlder', { older: format.money(toMoney(older)) }) : t('full');
  } else if (amount) amountError = t('fullTooLittle', { total: totalText });

  return (
    <fieldset className="space-y-3" data-testid={`${id}-choice`}>
      <legend className="text-sm font-medium text-stone-900">{t('title')}</legend>
      <div className="grid gap-2 sm:grid-cols-3">
        {PAYMENT_WAYS.map((w) => (
          <label key={w} className={cn('flex cursor-pointer items-start gap-2 rounded-md border p-3 text-sm', way === w ? 'border-brand-600 bg-brand-50' : 'border-stone-200 bg-white')}>
            {/* Named by its own words, the hint read after them: "on credit" is in the others' hints too. */}
            <input type="radio" name={`${id}-way`} value={w} checked={way === w} onChange={() => choose(w)} className="mt-0.5 accent-brand-700"
              aria-labelledby={`${id}-way-${w}-name`} aria-describedby={`${id}-way-${w}-hint`} data-testid={`${id}-way-${w}`} />
            <span>
              <span id={`${id}-way-${w}-name`} className="block font-medium text-stone-900">{t(`ways.${w}`)}</span>
              <span id={`${id}-way-${w}-hint`} className="block text-xs text-stone-500">{t(`hints.${w}`)}</span>
            </span>
          </label>
        ))}
      </div>
      {summary ? <p className="text-sm text-stone-700" data-testid={`${id}-payment-summary`}>{summary}</p> : null}
      {way !== 'CREDIT' ? (
        <PaymentFields
          id={id} owed={owed} value={value} onChange={onChange} amountError={amountError}
          amountHint={way === 'PART' ? t('partHint', { total: totalText })
            // More than the total only settles older bills — when there are any.
            : dec(owed).gt(dec(total)) ? t('fullHint', { total: totalText, owed: format.money(owed) }) : t('fullHintExact', { total: totalText })}
        />
      ) : null}
    </fieldset>
  );
}
