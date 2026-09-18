import { identity } from '@gsa/services';
import { getTranslations } from 'next-intl/server';
import { Card } from '@gsa/ui';
import { requireSession } from '@/server/session';

export default async function TodayPage() {
  const ctx = await requireSession();
  const me = await identity.getMe(ctx);
  const t = await getTranslations('field');
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">{t('welcome', { name: me.name })}</h1>
      <Card className="p-4 text-sm text-stone-600">{t('todayIntro')}</Card>
    </div>
  );
}
