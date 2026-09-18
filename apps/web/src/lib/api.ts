/**
 * Browser-side API client. Errors arrive as problem+json with a stable `code`
 * the interface translates (ARCHITECTURE §6.9).
 */
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, readonly details?: Record<string, unknown>) {
    super(code);
  }
}

type Init = { method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'; body?: unknown; idempotencyKey?: string };

export async function api<T>(path: string, init: Init = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (init.idempotencyKey) headers['idempotency-key'] = init.idempotencyKey;
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      method: init.method ?? 'GET',
      headers,
      credentials: 'same-origin',
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR');
  }
  if (response.status === 204) return undefined as T;
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const problem = data as { code?: string; details?: Record<string, unknown> } | null;
    throw new ApiError(response.status, problem?.code ?? 'INTERNAL_ERROR', problem?.details);
  }
  return data as T;
}
