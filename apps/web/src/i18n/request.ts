import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';

export const LOCALES = ['en', 'ar'] as const;
export type Locale = (typeof LOCALES)[number];

// Locale lives in a cookie (and later the user profile) — never the URL (ARCHITECTURE §6.7).
export default getRequestConfig(async () => {
  const locale: Locale = (await cookies()).get('NEXT_LOCALE')?.value === 'ar' ? 'ar' : 'en';
  return { locale, messages: (await import(`../messages/${locale}.json`)).default };
});
