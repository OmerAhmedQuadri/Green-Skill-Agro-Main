'use client';

import { ClipboardList, LayoutDashboard, Menu, Package, Settings, Ship, Tag, Truck, Users, Warehouse, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';
import { Button, cn } from '@gsa/ui';
import type { NavIcon } from '@/lib/navigation';
import { BrandMark } from './BrandMark';
import { LocaleSwitch } from './LocaleSwitch';
import { SignOutButton } from './SignOutButton';

const ICONS = {
  dashboard: LayoutDashboard, users: Users, catalogue: Package, vendors: Truck, pricing: Tag, settings: Settings,
  purchaseOrders: ClipboardList, incoming: Ship, stock: Warehouse,
} satisfies Record<NavIcon, unknown>;

type Props = { items: { href: string; label: string; icon: NavIcon }[]; user: { name: string; role: string }; children: ReactNode };

export function ConsoleShell({ items, user, children }: Props) {
  const t = useTranslations('nav');
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const nav = (
    <nav className="flex flex-1 flex-col gap-1">
      {items.map(({ href, label, icon }) => {
        const Icon = ICONS[icon];
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link key={href} href={href} onClick={() => setOpen(false)} aria-current={active ? 'page' : undefined}
            className={cn('flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium',
              active ? 'bg-white/15 text-white' : 'text-brand-100 hover:bg-white/10 hover:text-white')}>
            <Icon className="size-4" aria-hidden />
            {label}
          </Link>
        );
      })}
    </nav>
  );

  const footer = (
    <div className="space-y-2 border-t border-white/10 pt-4">
      <div className="px-3 text-sm">
        <div className="font-medium text-white">{user.name}</div>
        <div className="text-xs text-brand-200">{user.role}</div>
      </div>
      <div className="flex flex-wrap gap-1 [&_button]:text-brand-100 [&_button:hover]:bg-white/10 [&_button:hover]:text-white">
        <LocaleSwitch persist />
        <SignOutButton />
      </div>
    </div>
  );

  return (
    <div className="min-h-dvh lg:flex">
      <aside className="hidden w-64 shrink-0 flex-col gap-6 bg-brand-900 p-4 lg:flex">
        <BrandMark inverse />
        {nav}
        {footer}
      </aside>

      <header className="flex items-center justify-between bg-brand-900 px-4 py-3 lg:hidden">
        <BrandMark inverse />
        <Button variant="ghost" size="sm" className="text-white hover:bg-white/10" onClick={() => setOpen(true)} aria-label={t('menu')}>
          <Menu className="size-5" aria-hidden />
        </Button>
      </header>
      {open ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button type="button" className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} aria-label={t('close')} />
          <aside className="absolute inset-y-0 start-0 flex w-72 flex-col gap-6 bg-brand-900 p-4">
            <div className="flex items-center justify-between">
              <BrandMark inverse />
              <Button variant="ghost" size="sm" className="text-white hover:bg-white/10" onClick={() => setOpen(false)} aria-label={t('close')}>
                <X className="size-5" aria-hidden />
              </Button>
            </div>
            {nav}
            {footer}
          </aside>
        </div>
      ) : null}

      <main className="min-w-0 flex-1 p-4 sm:p-6 lg:p-8">{children}</main>
    </div>
  );
}
