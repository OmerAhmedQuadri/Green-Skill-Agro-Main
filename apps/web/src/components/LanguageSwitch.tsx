'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';

export function LanguageSwitch() {
  const t = useTranslations('app');
  const locale = useLocale();
  const router = useRouter();
  const next = locale === 'ar' ? 'en' : 'ar';
  return (
    <button
      type="button"
      className="rounded-md border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-100"
      onClick={() => {
        document.cookie = `NEXT_LOCALE=${next}; path=/; max-age=31536000; samesite=lax`;
        router.refresh();
      }}
    >
      {t('switchLanguage')}
    </button>
  );
}
