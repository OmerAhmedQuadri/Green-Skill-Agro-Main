'use client';

import { NOTIFICATION_POLL_MS, type NotificationKind } from '@gsa/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useLayoutEffect, useRef, useState } from 'react';
import { cn } from '@gsa/ui';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { keys } from '@/lib/query-keys';

type Item = { id: string; kind: NotificationKind; params: Record<string, string | number | null>; link: string | null; createdAt: string; read: boolean };
type Inbox = { items: Item[]; unread: number };

const PANEL_WIDTH = 320;
const PANEL_MARGIN = 16;

/**
 * Where the panel can sit without leaving the screen.
 *
 * It is 320px wide and the bell turns up in a 256px console sidebar, in a
 * mobile header, and in the field app between two other buttons — so opening a
 * fixed direction from the bell put it off the edge in two of the three. The
 * panel measures instead of the caller declaring, which is also what makes it
 * right in Arabic without a second rule: this is geometry, not direction.
 *
 * Returned relative to the bell, which is what an absolutely positioned child
 * of its wrapper needs.
 */
function panelOffset(bell: DOMRect): number {
  const width = Math.min(PANEL_WIDTH, window.innerWidth - PANEL_MARGIN * 2);
  const opensTowardsStart = bell.right - width;
  const furthestStart = window.innerWidth - width - PANEL_MARGIN;
  return Math.min(Math.max(opensTowardsStart, PANEL_MARGIN), furthestStart) - bell.left;
}

/**
 * In-app notifications (ARCHITECTURE §6.6, ADR-0034): polled every 30 s, no
 * websockets. Each is a kind and parameters, worded here in the reader's language.
 */
export function NotificationBell({ inverse = false }: { inverse?: boolean }) {
  const t = useTranslations('notifications');
  const format = useFormat();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0);

  // Measured as it opens, and again if the window changes under it.
  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = () => { if (anchor.current) setOffset(panelOffset(anchor.current.getBoundingClientRect())); };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open]);
  const inbox = useQuery({ queryKey: keys.notifications, queryFn: () => api<Inbox>('/notifications?limit=20'), refetchInterval: NOTIFICATION_POLL_MS });
  const markRead = async (ids?: string[]) => {
    await api('/notifications/read', { method: 'POST', body: ids ? { ids } : {}, idempotencyKey: crypto.randomUUID() }).catch(() => undefined);
    await queryClient.invalidateQueries({ queryKey: keys.notifications });
  };
  const unread = inbox.data?.unread ?? 0;
  const text = (n: Item) => t(`kinds.${n.kind}`, Object.fromEntries(Object.entries(n.params).map(([k, v]) => [k, v ?? ''])));

  return (
    <div className="relative" ref={anchor}>
      <button type="button" data-testid="notification-bell" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={t('open', { count: unread })}
        className={cn('relative inline-flex size-10 items-center justify-center rounded-md', inverse ? 'text-white hover:bg-white/10' : 'text-stone-700 hover:bg-stone-100')}>
        <Bell className="size-5" aria-hidden />
        {unread > 0 ? (
          <span className="absolute end-1 top-1 min-w-4 rounded-full bg-red-600 px-1 text-center text-[10px] font-semibold leading-4 text-white" data-testid="unread-count">
            {format.number(unread)}
          </span>
        ) : null}
      </button>
      {open ? (
        <div data-testid="notification-panel" role="dialog" aria-label={t('title')} style={{ left: offset }}
          className="absolute z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-stone-200 bg-white text-stone-900 shadow-lg">
          <div className="flex items-center justify-between border-b border-stone-200 px-4 py-2.5">
            <span className="text-sm font-semibold">{t('title')}</span>
            {unread > 0 ? <button type="button" className="text-xs font-medium text-brand-800 hover:underline" onClick={() => void markRead()}>{t('markAll')}</button> : null}
          </div>
          <ul className="max-h-96 divide-y divide-stone-100 overflow-y-auto">
            {(inbox.data?.items ?? []).length === 0 ? <li className="px-4 py-6 text-center text-sm text-stone-500">{t('empty')}</li> : null}
            {(inbox.data?.items ?? []).map((n) => (
              <li key={n.id}>
                <button type="button" className={cn('block w-full px-4 py-3 text-start text-sm hover:bg-stone-50', n.read ? 'text-stone-600' : 'font-medium')}
                  onClick={() => { setOpen(false); void markRead([n.id]); if (n.link) router.push(n.link); }}>
                  <span className="flex items-start gap-2">
                    {n.read ? null : <span className="mt-1.5 size-2 shrink-0 rounded-full bg-brand-600" aria-hidden />}
                    <span>{text(n)}<span className="mt-0.5 block text-xs font-normal text-stone-500">{format.dateTime(n.createdAt)}</span></span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
