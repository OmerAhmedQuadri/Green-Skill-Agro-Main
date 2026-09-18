'use client';

import { useMutation, type UseMutationOptions } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { isErrorKey } from '@/i18n/messages';
import { ApiError } from './api';

/**
 * A mutation that runs at most once per user intent (ADR-0009): the
 * Idempotency-Key is created when the user acts and reused by every automatic
 * retry. Only network failures are retried.
 */
export function useCommand<V, R>(
  send: (vars: V, idempotencyKey: string) => Promise<R>,
  options: Omit<UseMutationOptions<R, ApiError, { vars: V; key: string }>, 'mutationFn' | 'retry'> = {},
) {
  const mutation = useMutation<R, ApiError, { vars: V; key: string }>({
    ...options,
    mutationFn: ({ vars, key }) => send(vars, key),
    retry: (failures, error) => error.code === 'NETWORK_ERROR' && failures < 3,
  });
  return {
    ...mutation,
    run: (vars: V) => mutation.mutate({ vars, key: crypto.randomUUID() }),
    runAsync: (vars: V) => mutation.mutateAsync({ vars, key: crypto.randomUUID() }),
  };
}

/** Turns any error into translated text; the server never builds messages. */
export function useErrorText() {
  const t = useTranslations('errors');
  return (error: unknown): string => {
    const code = error instanceof ApiError ? error.code : 'INTERNAL_ERROR';
    return t(isErrorKey(code) ? code : 'INTERNAL_ERROR');
  };
}
