'use client';

import { useTranslations } from 'next-intl';
import { Button, Field, Select } from '@gsa/ui';

/** Calendar arithmetic on `YYYY-MM-DD` — dates, not instants, so no time zone moves them. */
export const shift = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
export const monthStart = (date: string) => `${date.slice(0, 7)}-01`;

/** Presets before a custom range: nobody fights a calendar for "this month" (ADR-0048, ADR-0054). */
export const PRESETS = {
  today: (today: string) => ({ from: today, to: today }),
  yesterday: (today: string) => ({ from: shift(today, -1), to: shift(today, -1) }),
  last7: (today: string) => ({ from: shift(today, -6), to: today }),
  thisMonth: (today: string) => ({ from: monthStart(today), to: today }),
  lastMonth: (today: string) => { const end = shift(monthStart(today), -1); return { from: monthStart(end), to: end }; },
  last30: (today: string) => ({ from: shift(today, -29), to: today }),
  last90: (today: string) => ({ from: shift(today, -89), to: today }),
  thisYear: (today: string) => ({ from: `${today.slice(0, 4)}-01-01`, to: today }),
} as const;
export type Preset = keyof typeof PRESETS;

/** The preset a range is, if it is one. */
export function presetOf(range: { from: string; to: string }, today: string): Preset | undefined {
  return (Object.keys(PRESETS) as Preset[]).find((k) => {
    const r = PRESETS[k](today);
    return r.from === range.from && r.to === range.to;
  });
}

/** The presets as a row of buttons, the one in force pressed. */
export function PresetButtons({ range, today, onPick, testIdPrefix = 'preset' }: {
  range: { from: string; to: string }; today: string; onPick: (range: { from: string; to: string }) => void; testIdPrefix?: string;
}) {
  const t = useTranslations('analytics');
  const active = presetOf(range, today);
  return (
    <div className="flex flex-wrap gap-2">
      {(Object.keys(PRESETS) as Preset[]).map((k) => (
        <Button key={k} size="sm" variant={active === k ? 'primary' : 'secondary'} onClick={() => onPick(PRESETS[k](today))} data-testid={`${testIdPrefix}-${k}`}>
          {t(`presets.${k}`)}
        </Button>
      ))}
    </div>
  );
}

/** A filter that picks one of a list, or all of them. */
export function Choice({ id, label, value, onChange, options, all }: {
  id: string; label: string; value: string; onChange: (value: string) => void; all: string;
  options: readonly { value: string; label: string }[];
}) {
  return (
    <Field id={id} label={label}>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{all}</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </Select>
    </Field>
  );
}
