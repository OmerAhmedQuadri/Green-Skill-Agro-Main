import { getTranslations } from 'next-intl/server';
import { Alert, Card } from '@gsa/ui';
import { ChangePasswordForm } from '@/components/auth/ChangePasswordForm';
import { BrandMark } from '@/components/shell/BrandMark';
import { SignOutButton } from '@/components/shell/SignOutButton';
import { getSession, requireSession } from '@/server/session';

export default async function ChangePasswordPage() {
  await requireSession({ allowPendingPasswordChange: true });
  const forced = (await getSession())?.mustChangePassword ?? false;
  const t = await getTranslations('auth');
  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex items-center justify-between">
          <BrandMark />
          <SignOutButton />
        </div>
        <Card className="space-y-4 p-6">
          <h1 className="text-xl font-semibold">{t('changePasswordTitle')}</h1>
          {forced ? <Alert tone="warning">{t('changePasswordRequired')}</Alert> : null}
          <ChangePasswordForm />
        </Card>
      </div>
    </main>
  );
}
