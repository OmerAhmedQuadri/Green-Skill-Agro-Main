'use client';

import { useState, type ReactNode } from 'react';
import { cn } from '@gsa/ui';

/**
 * Charts drawn by the app (ADR-0048): plain elements, no charting library.
 * Built from boxes rather than SVG so logical CSS mirrors them for Arabic —
 * time runs from the reading start, bars grow from it. One series per chart,
 * so one colour (brand-500, checked against the card surface) and no legend:
 * the title names what is plotted. Numbers here are geometry only — every
 * figure a reader sees is the Money string it came as.
 */

/** A clean step for an axis: 1, 2 or 5 times a power of ten, at or above `raw`. */
export function niceStep(raw: number): number {
  if (raw <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(raw));
  return ([1, 2, 5, 10].find((step) => step * power >= raw) ?? 10) * power;
}

export type Column = {
  readonly key: string;
  /** Under the column; empty where a label would crowd its neighbours. */ readonly label: string;
  readonly value: string;
  /** What hovering or focusing the column shows — the value first. */ readonly tooltip: ReactNode;
  /** Read out for the column, in place of the tooltip. */ readonly description: string;
};

/**
 * Columns from a single baseline, below it for a negative value (a day when
 * more came back than was sold). Each column is its own hit target, the full
 * height of the plot, and shows its tooltip on hover and on keyboard focus.
 */
export function ColumnChart({ columns, axis, height = 220, testId }: {
  columns: readonly Column[]; axis: (value: number) => string; height?: number; testId?: string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const values = columns.map((c) => Number(c.value));
  const high = Math.max(0, ...values);
  const low = Math.max(0, ...values.map((v) => -v));
  // Clean ticks — 0, 200, 400 — about four of them, and at least one interval even with nothing to show.
  const step = niceStep((high + low) / 4);
  const top = Math.max(step, Math.ceil(high / step) * step);
  const bottom = -Math.ceil(low / step) * step;
  const span = top - bottom;
  const baseline = (-bottom / span) * 100;
  const ticks = Array.from({ length: Math.round(span / step) + 1 }, (_, i) => bottom + i * step);
  const n = columns.length;
  return (
    <div data-testid={testId}>
      <div className="relative" style={{ height }}>
        {ticks.map((tick) => (
          <div key={tick} className="pointer-events-none absolute inset-x-0 border-t border-stone-200" style={{ bottom: `${((tick - bottom) / span) * 100}%` }}>
            <span className="absolute start-0 -translate-y-1/2 bg-white pe-1 text-xs text-stone-500 tabular-nums">{axis(tick)}</span>
          </div>
        ))}
        <div className="absolute inset-y-0 end-0 start-14 flex gap-0.5" onMouseLeave={() => setActive(null)}>
          {columns.map((c, i) => {
            const v = Number(c.value);
            const size = (Math.abs(v) / span) * 100;
            // Beside the column, inside the plot, on whichever side has the room — never over the column it describes.
            const side = i < n * 0.6 ? 'start-full ms-1' : 'end-full me-1';
            return (
              <div
                key={c.key} tabIndex={0} aria-label={c.description} data-testid={testId ? `${testId}-${c.key}` : undefined}
                className="relative h-full min-w-0 flex-1 outline-none"
                onMouseEnter={() => setActive(i)} onFocus={() => setActive(i)} onBlur={() => setActive(null)}
              >
                <div
                  className={cn(
                    'absolute inset-x-0 mx-auto max-w-6',
                    v >= 0 ? 'rounded-t-[4px]' : 'rounded-b-[4px]',
                    active === i ? 'bg-brand-400' : 'bg-brand-500',
                  )}
                  style={v >= 0 ? { bottom: `${baseline}%`, height: `${size}%` } : { top: `${100 - baseline}%`, height: `${size}%` }}
                />
                {active === i ? (
                  <div role="tooltip" className={cn('pointer-events-none absolute top-0 z-10 whitespace-nowrap rounded-md border border-stone-200 bg-white px-3 py-2 text-sm shadow-md', side)}>
                    {c.tooltip}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
      <div className="flex gap-0.5 ps-14 pt-1" aria-hidden>
        {columns.map((c) => <div key={c.key} className="min-w-0 flex-1 overflow-visible whitespace-nowrap text-center text-xs text-stone-500">{c.label}</div>)}
      </div>
    </div>
  );
}

export type BarRow = {
  readonly key: string; readonly label: string; readonly value: string;
  /** The figure written at the bar's tip. */ readonly display: string;
};

/**
 * A ranked list of bars, longest first, each with its figure beside it in a
 * column of its own — aligned like a table, and never pushed off the card by a
 * full-length bar — so every value reads without hovering. Picking a row
 * narrows the view to it, where `onPick` is given.
 */
export function BarList({ rows, onPick, testId }: { rows: readonly BarRow[]; onPick?: ((key: string) => void) | undefined; testId?: string }) {
  const largest = Math.max(0, ...rows.map((r) => Number(r.value)));
  return (
    <ul className="space-y-2" data-testid={testId}>
      {rows.map((r) => {
        const width = largest > 0 ? (Math.max(0, Number(r.value)) / largest) * 100 : 0;
        const label = <span className="block truncate text-sm text-stone-700">{r.label}</span>;
        return (
          <li key={r.key} className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] items-center gap-3" data-testid={testId ? `${testId}-${r.key}` : undefined}>
            {onPick ? <button type="button" className="min-w-0 text-start hover:underline" onClick={() => onPick(r.key)}>{label}</button> : label}
            <div className="flex min-w-0 items-center gap-3">
              <div className="min-w-0 flex-1"><div className="h-3.5 rounded-e-[4px] bg-brand-500" style={{ width: `${width}%` }} /></div>
              <span className="w-28 shrink-0 text-end text-sm text-stone-900 tabular-nums">{r.display}</span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
