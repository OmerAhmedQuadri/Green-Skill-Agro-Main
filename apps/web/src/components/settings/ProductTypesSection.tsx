'use client';

import { ATTRIBUTE_MODES, assertValidTemplate, PRODUCT_ATTRIBUTES, type AttributeMode, type ProductAttribute, type Template } from '@gsa/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { Alert, Button, Field, Select } from '@gsa/ui';
import type { ProductType } from '@/components/catalogue/types';
import { ActiveBadge } from '@/components/common/ActiveBadge';
import { NameFields } from '@/components/common/NameFields';
import { Section } from '@/components/common/Section';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { formText } from '@/lib/forms';
import { useCommand, useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';

const isMode = (v: string): v is AttributeMode => (ATTRIBUTE_MODES as readonly string[]).includes(v);
const templateFrom = (f: FormData, fallback: Template): Template =>
  Object.fromEntries(PRODUCT_ATTRIBUTES.map((a) => {
    const v = formText(f, `attr-${a}`);
    return [a, isMode(v) ? v : fallback[a]];
  })) as Template;
const validTemplate = (template: Template) => { try { assertValidTemplate(template); return true; } catch { return false; } };

/** SYS-004, CAT-013..016: which attributes each product type shows and requires. */
export function ProductTypesSection() {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const types = useQuery({ queryKey: keys.productTypes, queryFn: () => api<ProductType[]>('/product-types') });
  const [creating, setCreating] = useState(false);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: keys.productTypes });

  return (
    <Section title={t('settings.productTypes')} description={t('settings.productTypesHint')}
      actions={!creating ? <Button variant="secondary" size="sm" onClick={() => setCreating(true)}><Plus className="size-4" aria-hidden />{t('settings.newProductType')}</Button> : undefined}>
      {creating && types.data?.[0] ? <TypeEditor base={types.data[0]} onDone={() => { setCreating(false); refresh(); }} /> : null}
      {types.data?.map((pt) => <TypeEditor key={`${pt.id}-${pt.version}`} type={pt} base={pt} onDone={refresh} />)}
    </Section>
  );
}

function TypeEditor({ type, base, onDone }: { type?: ProductType; base: ProductType; onDone: () => void }) {
  const t = useTranslations();
  const format = useFormat();
  const errorText = useErrorText();
  const [template, setTemplate] = useState<Template>(type?.template ?? base.template);
  const save = useCommand((body: Record<string, unknown>, key) => (type
    ? api<ProductType>(`/product-types/${type.id}`, { method: 'PATCH', body: { ...body, version: type.version }, idempotencyKey: key })
    : api<ProductType>('/product-types', { method: 'POST', body, idempotencyKey: key })), { onSuccess: onDone });
  const valid = validTemplate(template);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    save.run({ nameEn: formText(f, 'nameEn'), nameAr: formText(f, 'nameAr'), countUnit: formText(f, 'countUnit') === 'SEED' ? 'SEED' : 'PIECE', template: templateFrom(f, template) });
  };

  return (
    <form onSubmit={submit} className="space-y-4 border-b border-stone-200 p-5 last:border-b-0" noValidate>
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-sm font-semibold">{type ? format.name(type) : t('settings.newProductType')}</h3>
        {type ? <ActiveBadge active={type.isActive} /> : null}
      </div>
      {save.error ? <Alert>{errorText(save.error)}</Alert> : null}
      <div className="grid gap-4 sm:grid-cols-3">
        <NameFields prefix={`type-${type?.id ?? 'new'}`} defaults={type} />
        <Field id={`type-${type?.id ?? 'new'}-count`} label={t('settings.countUnit')}>
          <Select id={`type-${type?.id ?? 'new'}-count`} name="countUnit" defaultValue={type?.countUnit ?? 'PIECE'}>
            <option value="SEED">{t('settings.countUnits.SEED')}</option>
            <option value="PIECE">{t('settings.countUnits.PIECE')}</option>
          </Select>
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {PRODUCT_ATTRIBUTES.map((a: ProductAttribute) => (
          <Field key={a} id={`type-${type?.id ?? 'new'}-${a}`} label={t(`settings.attributes.${a}`)}>
            <Select id={`type-${type?.id ?? 'new'}-${a}`} name={`attr-${a}`} value={template[a]}
              onChange={(e) => { const v = e.target.value; if (isMode(v)) setTemplate((prev) => ({ ...prev, [a]: v })); }}>
              {ATTRIBUTE_MODES.map((m) => <option key={m} value={m}>{t(`settings.modes.${m}`)}</option>)}
            </Select>
          </Field>
        ))}
      </div>
      {!valid ? <Alert tone="warning">{t('errors.INVALID_TEMPLATE')}</Alert> : null}
      <div className="flex gap-2">
        <Button type="submit" disabled={save.isPending || !valid}>{save.isPending ? t('common.saving') : type ? t('common.save') : t('settings.createProductType')}</Button>
        {type ? (
          <Button variant="ghost" disabled={save.isPending} onClick={() => save.run({ isActive: !type.isActive })}>
            {type.isActive ? t('common.deactivate') : t('common.reactivate')}
          </Button>
        ) : <Button variant="ghost" onClick={onDone}>{t('common.cancel')}</Button>}
      </div>
    </form>
  );
}
