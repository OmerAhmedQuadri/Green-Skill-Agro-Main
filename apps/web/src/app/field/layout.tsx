import { CalendarCheck } from 'lucide-react';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { BrandMark } from '@/components/shell/BrandMark';
import { LocaleSwitch } from '@/components/shell/LocaleSwitch';
import { SignOutButton } from '@/components/shell/SignOutButton';
import { requireSession } from '@/server/session';

/** The seller's phone app (mobile-first, NFR-002). Only Seller accounts have a field day. */
export default async function FieldLayout({ children }: { children: ReactNode }) {
  const ctx = await requireSession();
  if (ctx.user.role !== 'SELLER') notFound();
  const t = await getTranslations('nav');
  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col bg-white shadow-sm">
      <header className="flex items-center justify-between border-b border-stone-200 px-4 py-3">
        <BrandMark compact />
        <div className="flex items-center gap-1">
          <LocaleSwitch persist />
          <SignOutButton iconOnly />
        </div>
      </header>
      <main className="flex-1 p-4">{children}</main>
      <nav className="sticky bottom-0 grid grid-cols-1 border-t border-stone-200 bg-white">
        <Link href="/field/today" className="flex min-h-14 flex-col items-center justify-center gap-0.5 text-xs font-medium text-brand-800">
          <CalendarCheck className="size-5" aria-hidden />
          {t('today')}
        </Link>
      </nav>
    </div>
  );
}
