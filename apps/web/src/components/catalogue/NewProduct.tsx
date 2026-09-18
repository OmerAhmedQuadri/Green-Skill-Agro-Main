'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { PageHeader } from '@/components/common/PageHeader';
import { Section } from '@/components/common/Section';
import { api } from '@/lib/api';
import { useCommand } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import { ProductForm, type ProductInput } from './ProductForm';
import type { ProductDetail } from './types';

/** Workflow A: create the product, then add its varieties, SKUs and prices on its page. */
export function NewProduct() {
  const t = useTranslations();
  const router = useRouter();
  const queryClient = useQueryClient();
  const create = useCommand((input: ProductInput, key) => api<ProductDetail>('/products', { method: 'POST', body: input, idempotencyKey: key }), {
    onSuccess: (product) => {
      queryClient.setQueryData(keys.product(product.id), product);
      void queryClient.invalidateQueries({ queryKey: keys.products() });
      router.push(`/console/catalogue/${product.id}`);
    },
  });
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title={t('catalogue.newProduct')} subtitle={t('catalogue.newProductHint')} back={{ href: '/console/catalogue', label: t('catalogue.title') }} />
      <Section title={t('catalogue.details')}>
        <div className="p-5">
          <ProductForm submitLabel={t('catalogue.createProduct')} pending={create.isPending} error={create.error} onSubmit={create.run}
            onCancel={() => router.push('/console/catalogue')} />
        </div>
      </Section>
    </div>
  );
}
