'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useMemo } from 'react';

/**
 * I18N-005: one place decides how numbers, money, dates and countries render.
 * Arabic uses Latin digits and the Gregorian calendar, so codes, phone numbers
 * and quantities read the same way side by side (decision recorded in DECISIONS).
 */
export const INTL_LOCALE = { en: 'en-GB', ar: 'ar-SA-u-ca-gregory-nu-latn' } as const;

type Named = { readonly nameEn: string; readonly nameAr: string };
type Size = { readonly measure: 'WEIGHT'; readonly packWeightG: string } | { readonly measure: 'COUNT'; readonly packCount: number };

// Values stay decimal strings end to end (ADR-0003); Intl formats a string numerically.
type NumericString = `${number}`;

export function useFormat() {
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const t = useTranslations('format');
  return useMemo(() => {
    const tag = INTL_LOCALE[locale];
    const moneyFormat = new Intl.NumberFormat(tag, { style: 'currency', currency: 'SAR', minimumFractionDigits: 2 });
    const numberFormat = new Intl.NumberFormat(tag, { maximumFractionDigits: 3 });
    const regions = new Intl.DisplayNames([tag], { type: 'region' });
    // Calendar dates (expiry, arrival) are dates, not instants: format them as UTC so no zone shifts the day.
    const dateFormat = new Intl.DateTimeFormat(tag, { dateStyle: 'medium', timeZone: 'UTC' });
    const dateTimeFormat = new Intl.DateTimeFormat(tag, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Riyadh' });
    return {
      locale,
      /** I18N-003: product, variety and category names are data, shown in the reader's language. */
      name: (n: Named) => (locale === 'ar' ? n.nameAr : n.nameEn),
      /** The other language's name, shown beneath for bilingual staff. */
      otherName: (n: Named) => (locale === 'ar' ? n.nameEn : n.nameAr),
      money: (value: string) => moneyFormat.format(value as NumericString),
      number: (value: string | number) => numberFormat.format(typeof value === 'number' ? value : (value as NumericString)),
      country: (code: string) => regions.of(code) ?? code,
      /** A calendar date, `YYYY-MM-DD`. */
      date: (iso: string) => dateFormat.format(new Date(`${iso}T00:00:00Z`)),
      /** An instant, shown on Riyadh time (CONVENTIONS §4). */
      dateTime: (instant: string | Date) => dateTimeFormat.format(new Date(instant)),
      /** ADR-0015: grams are stored; a whole number of kilograms reads as kilograms. */
      size: (size: Size, countUnit: 'SEED' | 'PIECE') => {
        if (size.measure === 'COUNT') return t(countUnit === 'SEED' ? 'seeds' : 'pieces', { count: size.packCount });
        const [whole = '0', fraction = ''] = size.packWeightG.split('.');
        const grams = fraction.replace(/0+$/, '') ? `${whole}.${fraction.replace(/0+$/, '')}` : whole;
        const kg = !grams.includes('.') && grams.length > 3 && grams.endsWith('000');
        return kg ? t('kilograms', { value: numberFormat.format(grams.slice(0, -3) as NumericString) }) : t('grams', { value: numberFormat.format(grams as NumericString) });
      },
    };
  }, [locale, t]);
}

export type Format = ReturnType<typeof useFormat>;

/** Whole days from today (Riyadh) to a calendar date; negative when it has passed. PO-004's countdown. */
export function daysUntil(iso: string, now = new Date()): number {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(now);
  return Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}
