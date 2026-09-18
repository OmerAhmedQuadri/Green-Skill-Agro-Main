'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { PageHeader } from '@/components/common/PageHeader';
import { Section } from '@/components/common/Section';
import { api } from '@/lib/api';
import { useCommand } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import { PurchaseOrderForm, type PoInput } from './PurchaseOrderForm';
import type { PoDetail } from './types';

/** Workflow C step 1: a draft, against a vendor. */
export function NewPurchaseOrder() {
  const t = useTranslations();
  const router = useRouter();
  const queryClient = useQueryClient();
  const create = useCommand((input: PoInput, key) => api<PoDetail>('/purchase-orders', { method: 'POST', body: input, idempotencyKey: key }), {
    onSuccess: (po) => {
      queryClient.setQueryData(keys.purchaseOrder(po.id), po);
      void queryClient.invalidateQueries({ queryKey: keys.purchaseOrders() });
      router.push(`/console/purchase-orders/${po.id}`);
    },
  });
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={t('procurement.newOrder')} subtitle={t('procurement.newOrderHint')} back={{ href: '/console/purchase-orders', label: t('procurement.title') }} />
      <Section title={t('procurement.draft')}>
        <div className="p-5">
          <PurchaseOrderForm submitLabel={t('procurement.saveDraft')} pending={create.isPending} error={create.error} onSubmit={create.run}
            onCancel={() => router.push('/console/purchase-orders')} />
        </div>
      </Section>
    </div>
  );
}
