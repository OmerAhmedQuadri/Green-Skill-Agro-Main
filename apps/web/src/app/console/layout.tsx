import { identity } from '@gsa/services';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { ConsoleShell } from '@/components/shell/ConsoleShell';
import { CONSOLE_NAV } from '@/lib/navigation';
import { requireSession } from '@/server/session';

export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const ctx = await requireSession();
  // Sellers work in the field app; the console does not exist for them (404, not 403).
  if (ctx.user.role === 'SELLER') notFound();
  const me = await identity.getMe(ctx);
  const [tNav, tRoles] = await Promise.all([getTranslations('nav'), getTranslations('roles')]);
  const items = CONSOLE_NAV.filter((item) => item.visible(ctx.permissions))
    .map(({ href, key, icon }) => ({ href, icon, label: tNav(key) }));
  return <ConsoleShell items={items} user={{ name: me.name, role: tRoles(me.role) }}>{children}</ConsoleShell>;
}
