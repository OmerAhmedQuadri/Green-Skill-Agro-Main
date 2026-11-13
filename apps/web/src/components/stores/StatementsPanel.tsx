'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Share2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, Button } from '@gsa/ui';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useCommand, useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import type { StoreStatement } from './types';

/**
 * IMP-010 (ADR-0059): the store's statement — its account as it stands when asked for, printed by the worker — to
 * open, or share from the phone as the delivery document is. The latest few are listed, each until the storage
 * policy deletes it.
 */
export function StatementsPanel({ storeId }: { storeId: string }) {
  const t = useTranslations('stores.statement');
  const format = useFormat();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const [shareProblem, setShareProblem] = useState<string | null>(null);
  const statements = useQuery({
    queryKey: keys.storeStatements(storeId), queryFn: () => api<StoreStatement[]>(`/stores/${storeId}/statements`),
    // Printing takes seconds: look again until it is ready.
    refetchInterval: (query) => (query.state.data?.some((s) => s.status === 'PENDING') ? 2_000 : false),
  });
  const request = useCommand((_: null, key) => api<StoreStatement>(`/stores/${storeId}/statements`, { method: 'POST', body: {}, idempotencyKey: key }), {
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: keys.storeStatements(storeId) }),
  });
  const pdfUrl = (s: StoreStatement) => `/api/v1/stores/${storeId}/statements/${s.id}/pdf`;

  const share = async (s: StoreStatement) => {
    setShareProblem(null);
    try {
      const blob = await (await fetch(pdfUrl(s), { credentials: 'same-origin' })).blob();
      const file = new File([blob], `${s.number}.pdf`, { type: 'application/pdf' });
      if (!navigator.canShare?.({ files: [file] })) { setShareProblem(t('shareUnavailable')); return; }
      await navigator.share({ files: [file], title: s.number });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setShareProblem(t('shareUnavailable'));
    }
  };

  return (
    <div className="space-y-3 p-4 text-sm" data-testid="statements">
      <p className="text-stone-600">{t('hint')}</p>
      <Button size="sm" onClick={() => request.run(null)} disabled={request.isPending}>
        <FileText className="size-4" aria-hidden />{t('request')}
      </Button>
      {request.error ? <Alert>{errorText(request.error)}</Alert> : null}
      {shareProblem ? <Alert tone="warning">{shareProblem}</Alert> : null}
      {statements.data && statements.data.length > 0 ? (
        <ul className="divide-y divide-stone-100">
          {statements.data.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2" data-testid="statement">
              <span>{t('line', { number: s.number, time: format.dateTime(s.asOf) })}</span>
              {s.status === 'PENDING' ? <span className="text-stone-500" data-testid="statement-preparing">{t('preparing')}</span> : null}
              {s.status === 'FAILED' ? <span className="text-red-700">{t('failed')}</span> : null}
              {s.status === 'READY' && s.deleted ? <span className="text-stone-500">{t('deleted')}</span> : null}
              {s.status === 'READY' && !s.deleted ? (
                <span className="flex gap-2">
                  <a href={pdfUrl(s)} target="_blank" rel="noreferrer" data-testid="statement-open"
                    className="inline-flex h-9 items-center gap-2 rounded-md border border-stone-300 px-3 font-medium hover:bg-stone-50">
                    <FileText className="size-4" aria-hidden />{t('open')}
                  </a>
                  <Button size="sm" variant="secondary" onClick={() => void share(s)}><Share2 className="size-4" aria-hidden />{t('share')}</Button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : statements.isSuccess ? <p className="text-stone-500">{t('none')}</p> : null}
    </div>
  );
}
