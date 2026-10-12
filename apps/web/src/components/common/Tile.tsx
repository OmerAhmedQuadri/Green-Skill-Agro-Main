import type { ReactNode } from 'react';
import { Card, cn } from '@gsa/ui';

/** A headline figure: what it is, the figure, and a line under it (ADR-0048, ADR-0054). */
export function Tile({ label, value, hint, testId, lead = false }: { label: string; value: string; hint?: ReactNode; testId: string; lead?: boolean }) {
  return (
    <Card className="p-4">
      <div className="text-sm text-stone-600">{label}</div>
      <div className={cn('mt-1 font-semibold text-stone-900', lead ? 'text-3xl' : 'text-xl')} data-testid={testId}>{value}</div>
      {hint ? <div className="mt-1 text-xs text-stone-500">{hint}</div> : null}
    </Card>
  );
}
