'use client';

import { FileText, Mail, Share2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Field, Input } from '@gsa/ui';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useCommand, useErrorText } from '@/lib/hooks';
import type { Sale } from './types';

type Props = { sale: Sale; canSend: boolean; onChanged: (sale: Sale) => void };

/**
 * DOC-001..005, OQ-007: the delivery document once the worker has printed it.
 * The seller shares the PDF through the phone's own share sheet (WhatsApp,
 * SMS, email) or has the server email it; either is recorded. A copy is kept
 * whatever the sending setting.
 */
export function DeliveryDocumentPanel({ sale, canSend, onChanged }: Props) {
  const t = useTranslations('sales');
  const format = useFormat();
  const errorText = useErrorText();
  const [shareProblem, setShareProblem] = useState<string | null>(null);
  const [emailing, setEmailing] = useState(false);
  const doc = sale.document;
  const shared = useCommand((_: null, key) => api<Sale>(`/sales/${sale.id}/delivery-document/shared`, { method: 'POST', body: {}, idempotencyKey: key }), { onSuccess: onChanged });
  const email = useCommand((to: string, key) => api<Sale>(`/sales/${sale.id}/delivery-document/email`, { method: 'POST', body: { to }, idempotencyKey: key }), {
    onSuccess: (s) => { setEmailing(false); onChanged(s); },
  });
  if (!doc) return null;
  const pdfUrl = `/api/v1/sales/${sale.id}/delivery-document`;

  const share = async () => {
    setShareProblem(null);
    try {
      const blob = await (await fetch(pdfUrl, { credentials: 'same-origin' })).blob();
      const file = new File([blob], `${doc.number}.pdf`, { type: 'application/pdf' });
      if (!navigator.canShare?.({ files: [file] })) { setShareProblem(t('shareUnavailable')); return; }
      await navigator.share({ files: [file], title: doc.number });
      shared.run(null);
    } catch (error) {
      // The seller closed the share sheet: nothing was sent, nothing to record.
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setShareProblem(t('shareUnavailable'));
    }
  };
  const submitEmail = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const to = new FormData(e.currentTarget).get('to');
    email.run(typeof to === 'string' ? to.trim() : '');
  };

  return (
    <div className="space-y-3" data-testid="delivery-document">
      <div className="flex flex-wrap items-center gap-2">
        <FileText className="size-5 text-stone-500" aria-hidden />
        <span className="font-semibold">{t('documentTitle')}</span>
        <bdi dir="ltr" className="text-sm" data-testid="document-number">{doc.number}</bdi>
        <Badge tone="danger">{t('notTaxInvoice')}</Badge>
      </div>
      {doc.status === 'PENDING' ? <p className="text-sm text-stone-600" data-testid="document-preparing">{t('documentPreparing')}</p> : null}
      {doc.status === 'FAILED' ? <Alert>{t('documentFailed')}</Alert> : null}
      {doc.status === 'READY' ? (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <a href={pdfUrl} target="_blank" rel="noreferrer" className="inline-flex h-11 items-center gap-2 rounded-md border border-stone-300 px-4 text-sm font-medium hover:bg-stone-50">
              <FileText className="size-4" aria-hidden />{t('openPdf')}
            </a>
            {canSend && sale.sendingMode !== 'DISABLED' ? (
              <>
                <Button onClick={() => void share()} disabled={shared.isPending}><Share2 className="size-4" aria-hidden />{t('share')}</Button>
                <Button variant="secondary" onClick={() => setEmailing(true)}><Mail className="size-4" aria-hidden />{t('email')}</Button>
              </>
            ) : null}
          </div>
          {shareProblem ? <Alert tone="warning">{shareProblem}</Alert> : null}
          {shared.error ? <Alert>{errorText(shared.error)}</Alert> : null}
          {emailing ? (
            <form className="flex flex-wrap items-end gap-2" noValidate onSubmit={submitEmail} aria-label={t('email')}>
              <Field id="doc-email" label={t('emailTo')}><Input id="doc-email" name="to" type="email" dir="ltr" maxLength={254} /></Field>
              <Button type="submit" disabled={email.isPending}>{t('sendEmail')}</Button>
            </form>
          ) : null}
          {email.error ? <Alert>{errorText(email.error)}</Alert> : null}
          {sale.sendingMode === 'DISABLED' ? <p className="text-sm text-stone-600">{t('sendingDisabled')}</p> : null}
        </div>
      ) : null}
      {doc.sends.length > 0 ? (
        <ul className="space-y-1 text-sm text-stone-600" data-testid="document-sends">
          {doc.sends.map((s, i) => (
            <li key={i}>{s.channel === 'EMAIL' ? t('sentEmail', { to: s.toAddress ?? '', time: format.dateTime(s.sentAt) }) : t('sentShare', { time: format.dateTime(s.sentAt) })}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
