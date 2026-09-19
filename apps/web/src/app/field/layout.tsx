import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { FieldNav } from '@/components/field/FieldNav';
import { BrandMark } from '@/components/shell/BrandMark';
import { LocaleSwitch } from '@/components/shell/LocaleSwitch';
import { NotificationBell } from '@/components/shell/NotificationBell';
import { SignOutButton } from '@/components/shell/SignOutButton';
import { requireSession } from '@/server/session';

/** The seller's phone app (mobile-first, NFR-002). Only Seller accounts have a field day. */
export default async function FieldLayout({ children }: { children: ReactNode }) {
  const ctx = await requireSession();
  if (ctx.user.role !== 'SELLER') notFound();
  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col bg-white shadow-sm">
      <header className="flex items-center justify-between border-b border-stone-200 px-4 py-3">
        <BrandMark compact />
        <div className="flex items-center gap-1">
          <NotificationBell />
          <LocaleSwitch persist />
          <SignOutButton iconOnly />
        </div>
      </header>
      <main className="flex-1 p-4">{children}</main>
      <FieldNav />
    </div>
  );
}
