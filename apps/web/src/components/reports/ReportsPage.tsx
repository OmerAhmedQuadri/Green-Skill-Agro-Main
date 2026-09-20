'use client';

import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Card } from '@gsa/ui';
import { PageHeader } from '@/components/common/PageHeader';

type EntryKey = 'trends' | 'seasonal' | 'reorder' | 'stock' | 'expiry' | 'collections' | 'dispatch' | 'performance';
type Entry = { key: EntryKey; href: string; own: boolean };

/**
 * §11's eight outputs in one place. Three are reports in their own right and
 * have a screen here. The other five are readings of data an operational screen
 * already shows properly, so they link to it rather than restate it — one set of
 * figures, one place to change them.
 */
const ENTRIES: readonly Entry[] = [
  { key: 'trends', href: '/console/reports/trends', own: true },
  { key: 'seasonal', href: '/console/reports/trends?compare=YEAR_AGO', own: true },
  { key: 'reorder', href: '/console/reports/reorder', own: true },
  { key: 'stock', href: '/console/stock', own: false },
  { key: 'expiry', href: '/console/expiry', own: false },
  { key: 'collections', href: '/console/stores', own: false },
  { key: 'dispatch', href: '/console/dispatch', own: false },
  { key: 'performance', href: '/console/targets', own: false },
];

export function ReportsPage({ canForecast }: { canForecast: boolean }) {
  const t = useTranslations('reports');
  const visible = ENTRIES.filter((e) => e.key !== 'reorder' || canForecast);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <div className="grid gap-3 sm:grid-cols-2">
        {visible.map((entry) => (
          <Card key={entry.key} className="p-0">
            <Link href={entry.href} className="flex items-start gap-3 p-4 hover:bg-stone-50" data-testid={`report-${entry.key}`}>
              <div className="min-w-0 flex-1">
                <div className="font-medium text-stone-900">{t(`entries.${entry.key}.title`)}</div>
                <p className="mt-0.5 text-sm text-stone-600">{t(`entries.${entry.key}.hint`)}</p>
              </div>
              <ArrowRight className="mt-0.5 size-4 shrink-0 text-stone-400 rtl:-scale-x-100" aria-hidden />
            </Link>
          </Card>
        ))}
      </div>
      {/* Said once, so nobody wonders why five of these are somewhere else. */}
      <p className="text-sm text-stone-500">{t('linksHint')}</p>
    </div>
  );
}
