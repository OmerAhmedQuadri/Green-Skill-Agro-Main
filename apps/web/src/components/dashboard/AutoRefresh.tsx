'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * ADR-0054: the page's server-rendered parts — what waits for a decision and
 * the warnings — read again every so often, as the open tab's figures are.
 */
export function AutoRefresh({ everyMs }: { everyMs: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), everyMs);
    return () => clearInterval(timer);
  }, [router, everyMs]);
  return null;
}
