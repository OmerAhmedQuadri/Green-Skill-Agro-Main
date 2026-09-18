import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { Card } from '@gsa/ui';
import { ResetPasswordForm } from '@/components/auth/ResetPasswordForm';
import { BrandMark } from '@/components/shell/BrandMark';
import { LocaleSwitch } from '@/components/shell/LocaleSwitch';

export default async function Page() {
  const t = await getTranslations('auth');
  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex items-center justify-between">
          <BrandMark />
          <LocaleSwitch persist={false} />
        </div>
        <Card className="p-6">
          <h1 className="text-xl font-semibold">{t('resetTitle')}</h1>
          <div className="mb-5" />
          <Suspense>
            <ResetPasswordForm />
          </Suspense>
        </Card>
        <Link href="/login" className="block text-center text-sm text-stone-600 hover:text-stone-900">{t('backToSignIn')}</Link>
      </div>
    </main>
  );
}
