import { notFound } from 'next/navigation';
import { PricingPage } from '@/components/pricing/PricingPage';
import { canSeePricing } from '@/lib/navigation';
import { requireSession } from '@/server/session';

export default async function Page() {
  const ctx = await requireSession();
  if (!canSeePricing(ctx.permissions)) notFound();
  return (
    <PricingPage can={{
      managePriceLists: ctx.permissions.has('pricing.manage_price_lists'),
      setCeilings: ctx.permissions.has('pricing.set_discount_ceilings'),
    }} />
  );
}
