import { OnboardStoreScreen } from '@/components/stores/OnboardStoreScreen';

/** IMP-008: re-verifying a store imported from the books, on the seller's phone. */
export default async function ReverifyStorePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <OnboardStoreScreen reverifyId={id} />;
}
