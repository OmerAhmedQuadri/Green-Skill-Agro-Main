import { notFound } from 'next/navigation';
import { MyPerformance } from '@/components/field/MyPerformance';
import { requireSession } from '@/server/session';

export default async function Page() {
  const ctx = await requireSession();
  // RPT-010: a seller's own figures. Nobody else has a page of them.
  if (!ctx.permissions.has('cash.submit_settlement')) notFound();
  return <MyPerformance />;
}
