import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Sans_Arabic, Inter } from 'next/font/google';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { Providers } from './providers';
import './globals.css';

const latin = Inter({ subsets: ['latin'], variable: '--font-latin', display: 'swap' });
const arabic = IBM_Plex_Sans_Arabic({ subsets: ['arabic'], weight: ['400', '500', '600', '700'], variable: '--font-arabic', display: 'swap' });

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('app');
  return { title: { default: t('name'), template: `%s · ${t('name')}` }, description: t('tagline') };
}

export const viewport: Viewport = { themeColor: '#1b4332', width: 'device-width', initialScale: 1 };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  return (
    <html lang={locale} dir={locale === 'ar' ? 'rtl' : 'ltr'} className={`${latin.variable} ${arabic.variable}`}>
      <body className="min-h-dvh bg-stone-50 font-sans text-stone-900 antialiased">
        <NextIntlClientProvider>
          <Providers>{children}</Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
