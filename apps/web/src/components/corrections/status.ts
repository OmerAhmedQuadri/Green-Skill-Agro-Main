'use client';

import type { CorrectionClosing, CorrectionSessionState } from '@gsa/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api } from '@/lib/api';
import { keys } from '@/lib/query-keys';

export type CorrectionSession = {
  id: string; number: number; version: number; by: { id: string; name: string };
  openedAt: string; endsAt: string; reason: string; state: CorrectionSessionState;
  endedBy: 'CLOSED' | 'HOUR' | null; endedAt: string | null; closedAt: string | null;
  closing: CorrectionClosing | null; closingText: string | null;
};
export type CorrectionStatus = { mine: CorrectionSession | null; others: { number: number; by: string; openedAt: string; endsAt: string }[] };

/** A name or a reason set inside a sentence keeps its own direction (Unicode first-strong isolate). */
export const isolate = (text: string) => `⁨${text}⁩`;

const POLL_MS = 60_000;

/**
 * COR-004: who is correcting history, shared by the banner and the Settings section. Polled each minute for other
 * Super Admins' sessions; asked again the moment a session's hour ends, so the banner switches off with it.
 */
export function useCorrectionStatus() {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: keys.correctionStatus, queryFn: () => api<CorrectionStatus>('/corrections/status'), refetchInterval: POLL_MS });
  const ends = [
    ...(status.data?.mine?.state === 'OPEN' ? [status.data.mine.endsAt] : []),
    ...(status.data?.others.map((o) => o.endsAt) ?? []),
  ].sort()[0];
  useEffect(() => {
    if (!ends) return undefined;
    const wait = Math.min(Math.max(new Date(ends).getTime() - Date.now() + 1000, 1000), POLL_MS * 60);
    const timer = setTimeout(() => void queryClient.invalidateQueries({ queryKey: keys.correctionStatus }), wait);
    return () => clearTimeout(timer);
  }, [ends, queryClient]);
  return status;
}
