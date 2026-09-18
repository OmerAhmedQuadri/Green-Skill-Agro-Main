import { getTranslations } from 'next-intl/server';
import { LanguageSwitch } from '@/components/LanguageSwitch';

export default async function Home() {
  const t = await getTranslations('app');
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-4 p-8">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">{t('name')}</h1>
        <LanguageSwitch />
      </div>
      <p className="text-stone-600">{t('tagline')}</p>
      <p className="rounded-md border-s-4 border-emerald-700 bg-white ps-3 py-2 text-sm">{t('skeleton')}</p>
    </main>
  );
}
