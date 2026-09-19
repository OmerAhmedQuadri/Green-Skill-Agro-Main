import { identity } from '@gsa/services';
import { TodayScreen } from '@/components/field/TodayScreen';
import { requireSession } from '@/server/session';

export default async function TodayPage() {
  const ctx = await requireSession();
  const me = await identity.getMe(ctx);
  return <TodayScreen name={me.name} />;
}
