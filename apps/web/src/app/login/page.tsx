import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { Card } from '@gsa/ui';
import { LoginForm } from '@/components/auth/LoginForm';
import { BrandMark } from '@/components/shell/BrandMark';
import { LocaleSwitch } from '@/components/shell/LocaleSwitch';
import { getSession } from '@/server/session';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('auth'))('signInTitle') };
}

export default async function LoginPage() {
  if (await getSession()) redirect('/');
  const t = await getTranslations('auth');
  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex items-center justify-between">
          <BrandMark />
          <LocaleSwitch persist={false} />
        </div>
        <Card className="p-6">
          <h1 className="text-xl font-semibold">{t('signInTitle')}</h1>
          <p className="mb-5 mt-1 text-sm text-stone-500">{t('signInSubtitle')}</p>
          <Suspense>
            <LoginForm />
          </Suspense>
        </Card>
      </div>
    </main>
  );
}
