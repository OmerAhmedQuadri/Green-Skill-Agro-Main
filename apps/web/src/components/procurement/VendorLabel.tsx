'use client';

import { useTranslations } from 'next-intl';
import type { PoSummary } from './types';

/**
 * ADR-0045: a purchase order's vendor, as this person may see it — the code,
 * with the name only when the server sent one, or that the approver will
 * choose. The server decides what is sent; this only lays it out.
 */
export function VendorLabel({ vendor, stacked = false }: { vendor: PoSummary['vendor']; stacked?: boolean }) {
  const t = useTranslations('procurement');
  if (!vendor) return <span className="text-stone-500">{t('vendorAtApproval')}</span>;
  const code = <bdi dir="ltr" className="font-mono">{vendor.code}</bdi>;
  if (!vendor.name) return code;
  return stacked
    ? <>{code}<div className="text-xs text-stone-500">{vendor.name}</div></>
    : <span>{code}{' · '}{vendor.name}</span>;
}
