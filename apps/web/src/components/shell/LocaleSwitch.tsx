'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { Languages } from 'lucide-react';
import { Button } from '@gsa/ui';
import { api } from '@/lib/api';

/** Signed in: the choice is saved to the profile. Signed out: a cookie only. */
export function LocaleSwitch({ persist }: { persist: boolean }) {
  const t = useTranslations('app');
  const locale = useLocale();
  const router = useRouter();
  const next = locale === 'ar' ? 'en' : 'ar';
  const change = async () => {
    if (persist) await api('/me', { method: 'PATCH', body: { locale: next }, idempotencyKey: crypto.randomUUID() }).catch(() => undefined);
    document.cookie = `NEXT_LOCALE=${next}; path=/; max-age=31536000; samesite=lax`;
    router.refresh();
  };
  return (
    <Button variant="ghost" size="sm" onClick={() => void change()} lang={next}>
      <Languages className="size-4" aria-hidden />
      {t('switchLanguage')}
    </Button>
  );
}
