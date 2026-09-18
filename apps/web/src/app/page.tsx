import { redirect } from 'next/navigation';
import { getSession, homeFor } from '@/server/session';

export default async function Home() {
  const session = await getSession();
  if (!session) redirect('/login');
  if (session.mustChangePassword) redirect('/change-password');
  redirect(homeFor(session.ctx.user.role));
}
