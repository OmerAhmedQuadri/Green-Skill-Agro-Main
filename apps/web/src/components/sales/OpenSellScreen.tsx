'use client';

import { openSaleGrounds } from '@gsa/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MapPin } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, Field, Input } from '@gsa/ui';
import { PageHeader } from '@/components/common/PageHeader';
import { NO_PAYMENT, PaymentFields, paymentBody, type PaymentDraft } from '@/components/stores/PaymentFields';
import { api, ApiError } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { currentPosition, type Position } from '@/lib/geo';
import { useErrorText, useOnceCommand } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import { ItemsCard, typedLines } from './SellScreen';
import type { OpenSaleOptions, Sale } from './types';

/**
 * ADR-0052 (SAL-012..017) on the phone: a sale to a buyer who is not one of
 * the seller's stores. The buyer's name and phone if they give them, where it
 * happens, what is on the vehicle at base prices within the ceilings — paid in
 * full now. Switched off, or above the Admin's limit, it asks for approval
 * with a reason instead, and waits.
 */
export function OpenSellScreen() {
  const t = useTranslations('sales');
  const errorText = useErrorText();
  const options = useQuery({ queryKey: keys.openSaleOptions, queryFn: () => api<OpenSaleOptions>('/sales/open/options') });
  if (options.isPending) return <p className="text-sm text-stone-500">{t('loading')}</p>;
  if (options.error) return <Alert>{errorText(options.error)}</Alert>;
  const o = options.data;
  const back = { href: '/field/sales', label: t('mySales') };
  if (o.notWorking) {
    return (
      <div className="space-y-4">
        <PageHeader title={t('open.title')} back={back} />
        <Alert data-testid="not-working">
          <div className="font-semibold">{t('notWorking')}</div><div>{errorText(new ApiError(409, o.notWorking))}</div>
          <Link href="/field/today" className="mt-2 inline-block font-medium underline">{t('goToToday')}</Link>
        </Alert>
      </div>
    );
  }
  return <OpenSellForm options={o} back={back} />;
}

function OpenSellForm({ options: o, back }: { options: OpenSaleOptions; back: { href: string; label: string } }) {
  const t = useTranslations('sales');
  const ts = useTranslations('stores');
  const format = useFormat();
  const errorText = useErrorText();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [packs, setPacks] = useState<Record<string, string>>({});
  const [discounts, setDiscounts] = useState<Record<string, string>>({});
  const [buyerName, setBuyerName] = useState('');
  const [buyerPhone, setBuyerPhone] = useState('');
  const [reason, setReason] = useState('');
  const [draft, setDraft] = useState<PaymentDraft>(NO_PAYMENT);
  // SAL-012: where the sale is made, as at check-in — asked for once, never watched.
  const [position, setPosition] = useState<Position | null>(null);
  const [locating, setLocating] = useState(true);
  const [locationError, setLocationError] = useState<unknown>(null);
  const request = useCallback(() => currentPosition().then(setPosition, setLocationError).finally(() => setLocating(false)), []);
  useEffect(() => { void request(); }, [request]);
  const locate = () => { setLocating(true); setLocationError(null); void request(); };

  const record = useOnceCommand((body: unknown, key) => api<Sale>('/sales/open', { method: 'POST', body, idempotencyKey: key }), {
    onSuccess: (sale) => {
      for (const k of [keys.sales(), keys.openSaleOptions, keys.myVehicle, keys.cashInHand]) void queryClient.invalidateQueries({ queryKey: k });
      router.push(`/field/sales/${sale.id}`);
    },
  });

  const { lines, chosen, total, gross, discount, invalid } = typedLines(o, packs, discounts);
  // SAL-014: within the ceilings — an open sale cannot ask for more.
  const aboveCeiling = chosen.some((l) => l.above);
  // SAL-015, SAL-016: as the server will judge it.
  const grounds = openSaleGrounds(total, o.openSales);
  const needsApproval = grounds.length > 0;
  // SAL-013: the whole total, now — what waits is paid when it completes.
  const payment = needsApproval ? null : paymentBody({ ...draft, amount: total }, total);
  const ready = !invalid && !aboveCeiling && position !== null && (needsApproval ? reason.trim() !== '' : payment !== null);

  const submit = () => {
    if (!position) return;
    record.run({
      lines: chosen.map((l) => ({ skuId: l.item.skuId, packs: l.packs, discount: l.discount ?? '0' })),
      buyer: { name: buyerName.trim() || null, phone: buyerPhone.trim() || null },
      location: position, payment, approvalReason: needsApproval ? reason.trim() : null,
    });
  };

  return (
    <div className="space-y-4 pb-6">
      <PageHeader title={t('open.title')} back={back} />
      <Card className="space-y-2 p-4 text-sm">
        <p>{t('open.intro')}</p>
        {o.openSales.switchedOn ? null : <Alert tone="warning" data-testid="open-switched-off">{t('open.switchedOff')}</Alert>}
        <p className="text-stone-600">{t('open.limitNote', { limit: format.money(o.openSales.limit) })}</p>
      </Card>

      <Card className="space-y-3 p-4">
        <h2 className="font-semibold">{t('open.buyerTitle')}</h2>
        <div className="grid grid-cols-2 gap-3">
          <Field id="buyer-name" label={t('open.buyerName')}>
            <Input id="buyer-name" value={buyerName} maxLength={100} onChange={(e) => setBuyerName(e.target.value)} />
          </Field>
          <Field id="buyer-phone" label={t('open.buyerPhone')}>
            <Input id="buyer-phone" dir="ltr" inputMode="tel" value={buyerPhone} maxLength={30} onChange={(e) => setBuyerPhone(e.target.value)} />
          </Field>
        </div>
        <div className="flex items-start gap-2 rounded-md bg-stone-50 p-3 text-sm" data-testid="location">
          <MapPin className="mt-0.5 size-4 shrink-0 text-brand-800" aria-hidden />
          {locating ? <span>{ts('locating')}</span> : position
            ? <span>{ts('locationFound', { accuracy: format.number(position.accuracyM) })}</span>
            : (
              <div className="space-y-2">
                <span className="text-red-800">{errorText(locationError)}</span>
                <Button size="sm" variant="secondary" onClick={locate}>{ts('locateAgain')}</Button>
              </div>
            )}
        </div>
      </Card>

      <ItemsCard o={o} lines={lines} packs={packs} setPacks={setPacks} discounts={discounts} setDiscounts={setDiscounts} above="refused" />

      {chosen.length > 0 ? (
        <Card className="space-y-3 p-4" data-testid="sale-summary">
          <div className="flex justify-between text-sm"><span>{t('subtotal')}</span><span>{format.money(gross)}</span></div>
          <div className="flex justify-between text-sm"><span>{t('discount')}</span><span>{discount === '0.00' ? '—' : `−${format.money(discount)}`}</span></div>
          <div className="flex justify-between text-lg font-semibold"><span>{t('total')}</span><span data-testid="total">{format.money(total)}</span></div>

          {needsApproval ? (
            <div className="space-y-3 rounded-md border border-amber-200 bg-amber-50 p-3" data-testid="open-request">
              <p className="font-semibold text-amber-900">{t('open.requestTitle')}</p>
              <ul className="list-inside list-disc text-sm text-amber-900">{grounds.map((g) => <li key={g}>{t(`open.grounds.${g}`)}</li>)}</ul>
              <p className="text-sm text-amber-900">{t('requestHint')}</p>
              <Field id="reason" label={t('open.requestReason')}><Input id="reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} /></Field>
            </div>
          ) : (
            <PaymentFields id="open" owed={total} value={draft} onChange={setDraft} fullAmount={total} />
          )}

          {record.error ? <Alert>{errorText(record.error)}</Alert> : null}
          <Button block onClick={submit} disabled={!ready || record.isPending}>
            {record.isPending ? t('saving') : needsApproval ? t('requestApproval') : t('complete')}
          </Button>
        </Card>
      ) : null}
    </div>
  );
}
