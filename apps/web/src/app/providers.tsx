'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

export function Providers({ children }: { children: ReactNode }) {
  // Operational data is never served stale (ARCHITECTURE §6.8).
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 0, refetchOnWindowFocus: true } } }));
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
