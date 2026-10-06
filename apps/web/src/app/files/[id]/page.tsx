import { FilePage } from '@/components/storage/FilePage';
import { BrandMark } from '@/components/shell/BrandMark';
import { requireSession } from '@/server/session';

/**
 * ADR-0049: every stored photo or slip opens here — for a seller as for the
 * console — with how long it is kept, a hold for those who may place one, and,
 * once it has been deleted, when. Who may see the file is the API's decision.
 */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  await requireSession();
  const { id } = await params;
  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6">
      <BrandMark />
      <FilePage id={id} />
    </main>
  );
}
