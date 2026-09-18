import { notFound } from 'next/navigation';
import { SettingsPage } from '@/components/settings/SettingsPage';
import { canSeeSettings } from '@/lib/navigation';
import { requireSession } from '@/server/session';

export default async function Page() {
  const ctx = await requireSession();
  if (!canSeeSettings(ctx.permissions)) notFound();
  const p = ctx.permissions;
  return (
    <SettingsPage can={{
      configure: p.has('system.configure'), templates: p.has('system.manage_templates'), limits: p.has('system.set_limits'),
      returns: p.has('returns.set_rules'), commission: p.has('targets.manage'),
    }} />
  );
}
