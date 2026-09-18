'use client';

import { LogOut } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { Button } from '@gsa/ui';
import { api } from '@/lib/api';

export function SignOutButton({ block = false, iconOnly = false }: { block?: boolean; iconOnly?: boolean }) {
  const t = useTranslations('common');
  const router = useRouter();
  const signOut = async () => {
    await api('/auth/sign-out', { method: 'POST' }).catch(() => undefined);
    router.replace('/login');
    router.refresh();
  };
  return (
    <Button variant="ghost" size="sm" block={block} className={block ? 'justify-start' : undefined}
      onClick={() => void signOut()} aria-label={iconOnly ? t('signOut') : undefined}>
      <LogOut className="size-4 rtl:rotate-180" aria-hidden />
      {iconOnly ? null : t('signOut')}
    </Button>
  );
}
