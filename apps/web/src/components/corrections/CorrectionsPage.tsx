'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { Alert, Badge, Button, Card } from '@gsa/ui';
import { PageHeader } from '@/components/common/PageHeader';
import { Cell, Table } from '@/components/common/Table';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import type { CorrectionSession } from './status';

type Values = { amount: string; date: string; storeId: string; voucherNumber: string | null };
type StoreCorrection = {
  id: string; number: number; session: { id: string; number: number }; kind: 'BILL' | 'PAYMENT';
  store: { id: string; name: string }; toStore: { id: string; name: string } | null;
  before: Values; after: Values | null; reason: string; cashInHand: boolean; by: string; at: string;
};

type Page = { items: CorrectionSession[]; nextCursor: string | null };
const STATE_TONE = { OPEN: 'warning', ENDED: 'warning', CLOSED: 'neutral' } as const;

/** ADR-0059: every correction session — who opened it, when, why, and how its reason was settled. */
export function CorrectionsPage() {
  const t = useTranslations('corrections');
  const format = useFormat();
  const errorText = useErrorText();
  const list = useInfiniteQuery({
    queryKey: keys.correctionSessions,
    initialPageParam: '',
    queryFn: ({ pageParam }) => api<Page>(`/corrections/sessions?${new URLSearchParams({ limit: '50', ...(pageParam ? { cursor: pageParam } : {}) }).toString()}`),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const sessions = list.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <Changes />
      <h2 className="text-base font-semibold text-stone-900">{t('changes.sessions')}</h2>
      <Card>
        {list.error ? <div className="p-4"><Alert>{errorText(list.error)}</Alert></div> : null}
        {list.data && sessions.length === 0 ? <p className="p-5 text-sm text-stone-500">{t('list.empty')}</p> : null}
        {sessions.length > 0 ? (
          <Table head={[t('list.number'), t('list.by'), t('list.opened'), t('list.ended'), t('list.reason'), t('list.state')]}>
            {sessions.map((s) => (
              <tr key={s.id} data-testid={`correction-session-${s.number}`}>
                <Cell className="tabular-nums">{s.number}</Cell>
                <Cell>{s.by.name}</Cell>
                <Cell className="whitespace-nowrap">{format.dateTime(s.openedAt)}</Cell>
                <Cell className="whitespace-nowrap">
                  {s.endedAt && s.endedBy ? <>{format.dateTime(s.endedAt)}<div className="text-xs text-stone-500">{t(`list.endedBy.${s.endedBy}`)}</div></> : '—'}
                </Cell>
                <Cell className="min-w-64"><Reason session={s} /></Cell>
                <Cell><Badge tone={STATE_TONE[s.state]}>{t(`list.states.${s.state}`)}</Badge></Cell>
              </tr>
            ))}
          </Table>
        ) : null}
        {list.hasNextPage ? (
          <div className="border-t border-stone-200 p-4">
            <Button variant="secondary" onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>{t('list.more')}</Button>
          </div>
        ) : null}
      </Card>
    </div>
  );
}

/** COR-003: an edited reason shows the original struck through beside the new one; an addition follows it. */
function Reason({ session: s }: { session: CorrectionSession }) {
  const t = useTranslations('corrections.list');
  if (s.closing === 'EDITED') {
    return (
      <div className="space-y-1">
        <del className="block whitespace-pre-wrap text-stone-500" data-testid="correction-reason-original">{s.reason}</del>
        <div className="text-xs font-medium text-stone-500">{t('edited')}</div>
        <p className="whitespace-pre-wrap">{s.closingText}</p>
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <p className="whitespace-pre-wrap">{s.reason}</p>
      {s.closing === 'ADDED' ? <><div className="text-xs font-medium text-stone-500">{t('added')}</div><p className="whitespace-pre-wrap">{s.closingText}</p></> : null}
    </div>
  );
}

/** COR-002, COR-005: every change to a store's account, with its session, what it was and became, and why. */
function Changes() {
  const t = useTranslations('corrections.changes');
  const format = useFormat();
  const errorText = useErrorText();
  const list = useInfiniteQuery({
    queryKey: keys.storeCorrections,
    initialPageParam: '',
    queryFn: ({ pageParam }) => api<{ items: StoreCorrection[]; nextCursor: string | null }>(
      `/corrections/store-corrections?${new URLSearchParams({ limit: '50', ...(pageParam ? { cursor: pageParam } : {}) }).toString()}`,
    ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const changes = list.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <>
      <h2 className="text-base font-semibold text-stone-900">{t('title')}</h2>
      <Card>
        {list.error ? <div className="p-4"><Alert>{errorText(list.error)}</Alert></div> : null}
        {list.data && changes.length === 0 ? <p className="p-5 text-sm text-stone-500">{t('empty')}</p> : null}
        {changes.length > 0 ? (
          <Table head={[t('number'), t('session'), t('store'), t('what'), t('change'), t('reason'), t('by'), t('when')]}>
            {changes.map((c) => (
              <tr key={c.id} data-testid={`store-correction-${c.number}`}>
                <Cell className="tabular-nums">{c.number}</Cell>
                <Cell className="tabular-nums">{c.session.number}</Cell>
                <Cell>{c.store.name}</Cell>
                <Cell>{t(`kinds.${c.kind}`)}</Cell>
                <Cell className="min-w-56 space-y-0.5 text-xs">
                  {c.after === null ? <div className="font-medium text-red-800">{t('removed')}</div> : null}
                  {c.toStore ? <div>{t('moved', { store: c.toStore.name })}</div> : null}
                  {c.after && c.after.amount !== c.before.amount ? <div>{t('amount')} <del>{format.money(c.before.amount)}</del> {format.money(c.after.amount)}</div> : null}
                  {c.after && c.after.date !== c.before.date ? <div>{t('date')} <del>{format.date(c.before.date)}</del> {format.date(c.after.date)}</div> : null}
                  {c.after && c.after.voucherNumber !== c.before.voucherNumber ? <div>{t('voucher')} <del>{c.before.voucherNumber}</del> {c.after.voucherNumber}</div> : null}
                  {c.cashInHand ? <div className="text-stone-500">{t('cashInHand')}</div> : null}
                </Cell>
                <Cell className="min-w-56 whitespace-pre-wrap">{c.reason}</Cell>
                <Cell>{c.by}</Cell>
                <Cell className="whitespace-nowrap">{format.dateTime(c.at)}</Cell>
              </tr>
            ))}
          </Table>
        ) : null}
        {list.hasNextPage ? (
          <div className="border-t border-stone-200 p-4">
            <Button variant="secondary" onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>{t('more')}</Button>
          </div>
        ) : null}
      </Card>
    </>
  );
}
