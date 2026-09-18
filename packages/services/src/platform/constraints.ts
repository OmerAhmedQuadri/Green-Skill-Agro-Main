import { type DomainError } from '@gsa/core';

/**
 * Unique indexes are the real guarantee against duplicates; this turns a clash
 * into a clear domain error instead of a 500. Drizzle wraps the driver error,
 * so the Postgres fields sit on `cause`.
 */
export function violatedConstraint(error: unknown): string | null {
  const cause = (error as { cause?: { code?: string; constraint?: string } } | null)?.cause;
  return cause?.code === '23505' ? (cause.constraint ?? null) : null;
}

export async function mapUniqueViolations<T>(work: Promise<T>, map: Readonly<Record<string, DomainError>>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    const constraint = violatedConstraint(error);
    const mapped = constraint ? map[constraint] : undefined;
    throw mapped ?? error;
  }
}
