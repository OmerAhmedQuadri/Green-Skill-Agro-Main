'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { Alert, Button, Field, Input } from '@gsa/ui';
import { ActiveBadge } from '@/components/common/ActiveBadge';
import { NameFields } from '@/components/common/NameFields';
import { PageHeader } from '@/components/common/PageHeader';
import { Section } from '@/components/common/Section';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { formText, wholeNumber } from '@/lib/forms';
import { useCommand, useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import type { Category } from './types';

type Sub = Category['subCategories'][number];
type CategoryBody = { nameEn: string; nameAr: string; expiryWarningDays: number | null };

const namesOf = (f: FormData) => ({ nameEn: formText(f, 'nameEn'), nameAr: formText(f, 'nameAr') });
const daysOf = (f: FormData) => wholeNumber(formText(f, 'expiryWarningDays'));

/** CAT-001..003: categories and sub-categories, maintained by the Admin in the application. */
export function StructurePage() {
  const t = useTranslations();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const categories = useQuery({ queryKey: keys.categories, queryFn: () => api<Category[]>('/categories') });
  const [adding, setAdding] = useState(false);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: keys.categories });
    void queryClient.invalidateQueries({ queryKey: keys.products() });
  };
  const create = useCommand((body: CategoryBody, key) => api<Category>('/categories', { method: 'POST', body, idempotencyKey: key }),
    { onSuccess: () => { refresh(); setAdding(false); } });

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        back={{ href: '/console/catalogue', label: t('catalogue.title') }}
        title={t('catalogue.structure.title')}
        subtitle={t('catalogue.structure.subtitle')}
        actions={!adding ? <Button onClick={() => setAdding(true)}><Plus className="size-4" aria-hidden />{t('catalogue.structure.addCategory')}</Button> : undefined}
      />

      {adding ? (
        <Section title={t('catalogue.structure.addCategory')}>
          <form className="grid gap-4 p-5 sm:grid-cols-3" noValidate onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            create.run({ ...namesOf(f), expiryWarningDays: daysOf(f) });
          }}>
            {create.error ? <Alert className="sm:col-span-3">{errorText(create.error)}</Alert> : null}
            <NameFields prefix="category-new" />
            <ExpiryDaysField id="category-new-days" />
            <div className="flex gap-2 sm:col-span-3">
              <Button type="submit" disabled={create.isPending}>{create.isPending ? t('common.saving') : t('catalogue.structure.addCategory')}</Button>
              <Button variant="ghost" onClick={() => setAdding(false)}>{t('common.cancel')}</Button>
            </div>
          </form>
        </Section>
      ) : null}

      {categories.error ? <Alert>{errorText(categories.error)}</Alert> : null}
      {categories.isPending ? <p className="text-sm text-stone-500">{t('common.loading')}</p> : null}
      {categories.data?.length === 0 && !adding ? <p className="text-sm text-stone-500">{t('catalogue.structure.empty')}</p> : null}
      {categories.data?.map((c) => <CategoryCard key={c.id} category={c} onChange={refresh} />)}
    </div>
  );
}

function ExpiryDaysField({ id, defaultValue }: { id: string; defaultValue?: number | null }) {
  const t = useTranslations('catalogue.structure');
  return (
    <Field id={id} label={t('expiryWarningDays')} hint={t('expiryWarningHint')}>
      <Input id={id} name="expiryWarningDays" type="number" inputMode="numeric" min={1} max={730} dir="ltr" defaultValue={defaultValue ?? ''} />
    </Field>
  );
}

function CategoryCard({ category, onChange }: { category: Category; onChange: () => void }) {
  const t = useTranslations();
  const format = useFormat();
  const errorText = useErrorText();
  const [editing, setEditing] = useState(false);
  const [addingSub, setAddingSub] = useState(false);
  const [editingSub, setEditingSub] = useState<string | null>(null);

  const update = useCommand((body: Partial<CategoryBody> & { version: number; isActive?: boolean }, key) =>
    api<Category>(`/categories/${category.id}`, { method: 'PATCH', body, idempotencyKey: key }), { onSuccess: () => { onChange(); setEditing(false); } });
  const addSub = useCommand((body: { nameEn: string; nameAr: string }, key) =>
    api<Category>(`/categories/${category.id}/sub-categories`, { method: 'POST', body, idempotencyKey: key }), { onSuccess: () => { onChange(); setAddingSub(false); } });
  const updateSub = useCommand(({ id, ...body }: { id: string; version: number; nameEn?: string; nameAr?: string; isActive?: boolean }, key) =>
    api<Category>(`/sub-categories/${id}`, { method: 'PATCH', body, idempotencyKey: key }), { onSuccess: () => { onChange(); setEditingSub(null); } });
  const error = update.error ?? addSub.error ?? updateSub.error;

  return (
    <Section
      title={<span className="flex flex-wrap items-center gap-3">{format.name(category)}<ActiveBadge active={category.isActive} /></span>}
      description={[
        format.otherName(category),
        category.expiryWarningDays ? t('catalogue.structure.warnsDays', { count: category.expiryWarningDays }) : t('catalogue.structure.warnsDefault'),
      ].join(' · ')}
      actions={!editing ? (
        <span className="flex gap-1">
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>{t('common.edit')}</Button>
          <Button variant="ghost" size="sm" disabled={update.isPending} onClick={() => update.run({ version: category.version, isActive: !category.isActive })}>
            {category.isActive ? t('common.deactivate') : t('common.reactivate')}
          </Button>
        </span>
      ) : undefined}
    >
      {error ? <div className="px-5 pt-4"><Alert>{errorText(error)}</Alert></div> : null}
      {editing ? (
        <form className="grid gap-4 border-b border-stone-200 p-5 sm:grid-cols-3" noValidate onSubmit={(e: FormEvent<HTMLFormElement>) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          update.run({ version: category.version, ...namesOf(f), expiryWarningDays: daysOf(f) });
        }}>
          <NameFields prefix={`category-${category.id}`} defaults={category} />
          <ExpiryDaysField id={`category-${category.id}-days`} defaultValue={category.expiryWarningDays} />
          <div className="flex gap-2 sm:col-span-3">
            <Button type="submit" disabled={update.isPending}>{t('common.save')}</Button>
            <Button variant="ghost" onClick={() => setEditing(false)}>{t('common.cancel')}</Button>
          </div>
        </form>
      ) : null}

      <ul className="divide-y divide-stone-100">
        {category.subCategories.map((s: Sub) => (
          <li key={s.id} className="px-5 py-3">
            {editingSub === s.id ? (
              <form className="grid gap-4 sm:grid-cols-2" noValidate onSubmit={(e: FormEvent<HTMLFormElement>) => {
                e.preventDefault();
                updateSub.run({ id: s.id, version: s.version, ...namesOf(new FormData(e.currentTarget)) });
              }}>
                <NameFields prefix={`sub-${s.id}`} defaults={s} />
                <div className="flex gap-2 sm:col-span-2">
                  <Button type="submit" disabled={updateSub.isPending}>{t('common.save')}</Button>
                  <Button variant="ghost" onClick={() => setEditingSub(null)}>{t('common.cancel')}</Button>
                </div>
              </form>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="font-medium">{format.name(s)}</span>
                  <span className="ms-2 text-sm text-stone-500">{format.otherName(s)}</span>
                  {!s.isActive ? <span className="ms-2"><ActiveBadge active={false} /></span> : null}
                </div>
                <span className="flex gap-1">
                  <Button variant="ghost" size="sm" onClick={() => setEditingSub(s.id)}>{t('common.edit')}</Button>
                  <Button variant="ghost" size="sm" disabled={updateSub.isPending} onClick={() => updateSub.run({ id: s.id, version: s.version, isActive: !s.isActive })}>
                    {s.isActive ? t('common.deactivate') : t('common.reactivate')}
                  </Button>
                </span>
              </div>
            )}
          </li>
        ))}
      </ul>

      <div className="border-t border-stone-200 p-4">
        {addingSub ? (
          <form className="grid gap-4 sm:grid-cols-2" noValidate onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            addSub.run(namesOf(new FormData(e.currentTarget)));
          }}>
            <NameFields prefix={`sub-new-${category.id}`} />
            <div className="flex gap-2 sm:col-span-2">
              <Button type="submit" disabled={addSub.isPending}>{t('catalogue.structure.addSubCategory')}</Button>
              <Button variant="ghost" onClick={() => setAddingSub(false)}>{t('common.cancel')}</Button>
            </div>
          </form>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => setAddingSub(true)}><Plus className="size-4" aria-hidden />{t('catalogue.structure.addSubCategory')}</Button>
        )}
      </div>
    </Section>
  );
}
