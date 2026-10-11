import type { Sale } from './types';

type T = (key: 'open.title' | 'open.titleWith', values?: { buyer: string }) => string;

/** Who a sale went to: its store, or an open sale with the buyer's name when they gave it (ADR-0052). */
export function partyName(store: { readonly name: string } | null, buyerName: string | null | undefined, t: T): string {
  if (store) return store.name;
  return buyerName ? t('open.titleWith', { buyer: buyerName }) : t('open.title');
}

export const partyOf = (sale: Sale, t: T): string => partyName(sale.store, sale.open?.buyerName, t);
