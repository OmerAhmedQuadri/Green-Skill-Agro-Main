import { DomainError } from '../errors';

/**
 * Names are data, held in English and Arabic (I18N-003, CAT-004). Whitespace
 * is collapsed so "Okra " and "Okra" cannot become two products.
 */
export function cleanName(value: string, field: string, max = 120): string {
  const name = value.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!name || name.length > max) throw new DomainError('INVALID_NAME', { field });
  return name;
}

export type BilingualName = { readonly nameEn: string; readonly nameAr: string };

export function bilingualName(input: BilingualName, max = 120): BilingualName {
  return { nameEn: cleanName(input.nameEn, 'nameEn', max), nameAr: cleanName(input.nameAr, 'nameAr', max) };
}
