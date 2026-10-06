'use client';

import { NOTIFICATION_POLL_MS, type NotificationKind, type RequestOutcome } from '@gsa/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Badge, cn } from '@gsa/ui';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { keys } from '@/lib/query-keys';

type Resolution = { outcome: RequestOutcome; at: string; by: { id: string; name: string } | null; byYou: boolean };
type Item = {
  id: string; kind: NotificationKind; params: Record<string, string | number | null>; link: string | null; createdAt: string; read: boolean;
  /** ADR-0051: a request that has ended, however — it no longer counts. */
  resolution: Resolution | null;
};
type Inbox = { items: Item[]; unread: number };

/** ADR-0051: how a request ended, at a glance — done, refused, in hand, or lapsed. */
const OUTCOME_TONE = {
  APPROVED: 'success', REDUCED: 'success', CONFIRMED: 'success', REVIEWED: 'success', AUTHORISED: 'success', RELEASED: 'success',
  REJECTED: 'danger', NOT_RECEIVED: 'danger', CANCELLED: 'danger',
  TAKEN: 'warning',
  EXPIRED: 'neutral', WITHDRAWN: 'neutral',
} as const satisfies Record<RequestOutcome, 'success' | 'danger' | 'warning' | 'neutral'>;

/**
 * A name or a date set inside a sentence keeps its own direction, as `<bdi>`
 * does in markup (Unicode first-strong isolate). Without it, an English name
 * beside an Arabic date pulled the date's parts apart.
 */
const isolate = (text: string) => `\u2068${text}\u2069`;

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
  const pathname = usePathname();
  // Open on one page only. The shell outlives navigation, so a plain boolean
  // left the panel open over the next page after the browser's back button;
  // remembering where it was opened closes it without an effect to reset it.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === pathname;
  const close = () => setOpenOn(null);
  const anchor = useRef<HTMLDivElement>(null);
  const bell = useRef<HTMLButtonElement>(null);
  const [offset, setOffset] = useState(0);

  /**
   * Dismissed the way a popover is expected to be: a press anywhere outside it,
   * Escape, or focus moving elsewhere. It used to close only from the bell or by
   * choosing a notification, so it stayed open over whatever came next.
   *
   * `pointerdown`, not `click`, so a tap on a phone counts and the panel has
   * gone before whatever was pressed acts. The bell sits inside the wrapper, so
   * pressing it is not "outside" and its own click still toggles.
   */
  useEffect(() => {
    if (!open) return undefined;
    const outside = (target: EventTarget | null) => target instanceof Node && !anchor.current?.contains(target);
    const onPointer = (e: PointerEvent) => { if (outside(e.target)) setOpenOn(null); };
    const onFocus = (e: FocusEvent) => { if (outside(e.target)) setOpenOn(null); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpenOn(null);
      bell.current?.focus(); // back to where the keyboard was
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('focusin', onFocus);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

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
  const ended = ({ outcome, by, byYou }: Resolution) => t(`resolved.${outcome}`, { who: byYou ? 'me' : by ? 'other' : 'nobody', name: isolate(by?.name ?? '') });

  return (
    <div className="relative" ref={anchor}>
      <button type="button" ref={bell} data-testid="notification-bell" onClick={() => setOpenOn(open ? null : pathname)} aria-expanded={open} aria-label={t('open', { count: unread })}
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
            {(inbox.data?.items ?? []).map((n) => {
              // ADR-0051: an ended request reads as done, whoever ended it.
              const waiting = !n.read && !n.resolution;
              return (
                <li key={n.id} data-testid="notification-item">
                  <button type="button" className={cn('block w-full px-4 py-3 text-start text-sm hover:bg-stone-50', waiting ? 'font-medium' : 'text-stone-600')}
                    onClick={() => { close(); void markRead([n.id]); if (n.link) router.push(n.link); }}>
                    <span className="flex items-start gap-2">
                      {waiting ? <span className="mt-1.5 size-2 shrink-0 rounded-full bg-brand-600" aria-hidden /> : null}
                      <span className="min-w-0">
                        {text(n)}
                        <span className="mt-0.5 block text-xs font-normal text-stone-500">{format.dateTime(n.createdAt)}</span>
                        {n.resolution ? (
                          <Badge tone={OUTCOME_TONE[n.resolution.outcome]} className="mt-1.5 max-w-full rounded-md font-normal" data-testid="notification-resolution">
                            {t('resolvedLine', { outcome: ended(n.resolution), time: isolate(format.dateTime(n.resolution.at)) })}
                          </Badge>
                        ) : null}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
