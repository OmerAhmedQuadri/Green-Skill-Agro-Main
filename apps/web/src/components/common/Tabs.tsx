'use client';

import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@gsa/ui';

/**
 * Tabs that switch one panel in place (the WAI-ARIA tabs pattern). Only the
 * chosen tab is in the Tab order; the arrow keys move between tabs — the other
 * way round in Arabic, where the row runs right to left — and Home and End go
 * to either end.
 */
export function Tabs<T extends string>({ id, label, tabs, active, onChange, children }: {
  id: string; label: string; tabs: readonly { key: T; label: ReactNode }[]; active: T; onChange: (key: T) => void; children: ReactNode;
}) {
  const buttons = useRef(new Map<T, HTMLButtonElement>());

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const forward = getComputedStyle(event.currentTarget).direction === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
    const backward = forward === 'ArrowLeft' ? 'ArrowRight' : 'ArrowLeft';
    const target = event.key === 'Home' ? 0
      : event.key === 'End' ? tabs.length - 1
        : event.key === forward ? (index + 1) % tabs.length
          : event.key === backward ? (index - 1 + tabs.length) % tabs.length
            : null;
    const next = target === null ? undefined : tabs[target];
    if (!next) return;
    event.preventDefault();
    onChange(next.key);
    buttons.current.get(next.key)?.focus();
  };

  return (
    <div>
      <div role="tablist" aria-label={label} className="flex gap-1 overflow-x-auto border-b border-stone-200">
        {tabs.map((tab, i) => (
          <button
            key={tab.key} type="button" role="tab" id={`${id}-tab-${tab.key}`} aria-selected={tab.key === active} aria-controls={`${id}-panel`}
            tabIndex={tab.key === active ? 0 : -1}
            ref={(element) => { if (element) buttons.current.set(tab.key, element); else buttons.current.delete(tab.key); }}
            onClick={() => onChange(tab.key)} onKeyDown={(event) => onKeyDown(event, i)}
            className={cn(
              '-mb-px whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium',
              tab.key === active ? 'border-brand-800 text-brand-900' : 'border-transparent text-stone-600 hover:text-stone-900',
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${active}`} className="pt-4">{children}</div>
    </div>
  );
}
