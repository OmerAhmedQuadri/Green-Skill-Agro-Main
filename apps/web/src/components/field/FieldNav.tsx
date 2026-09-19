'use client';

import { CalendarCheck, Truck } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { cn } from '@gsa/ui';

const ITEMS = [
  { href: '/field/today', key: 'today', icon: CalendarCheck },
  { href: '/field/vehicle', key: 'myVehicle', icon: Truck },
] as const;

/** The seller's bottom bar: thumb-reachable, two destinations (NFR-002). */
export function FieldNav() {
  const t = useTranslations('nav');
  const pathname = usePathname();
  return (
    <nav className="sticky bottom-0 grid grid-cols-2 border-t border-stone-200 bg-white">
      {ITEMS.map(({ href, key, icon: Icon }) => {
        const active = pathname.startsWith(href);
        return (
          <Link key={href} href={href} aria-current={active ? 'page' : undefined}
            className={cn('flex min-h-14 flex-col items-center justify-center gap-0.5 text-xs font-medium', active ? 'text-brand-800' : 'text-stone-500')}>
            <Icon className="size-5" aria-hidden />
            {t(key)}
          </Link>
        );
      })}
    </nav>
  );
}
