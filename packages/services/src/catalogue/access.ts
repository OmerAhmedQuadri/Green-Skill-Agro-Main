import type { PermissionCode } from '@gsa/core';

/**
 * Who may read the catalogue. Viewing it is its own permission, but a manager
 * who maintains the structure, edits products or sets prices must see what
 * they are working on.
 */
export const CATALOGUE_READERS: readonly PermissionCode[] = [
  'catalogue.view', 'catalogue.manage_structure', 'catalogue.manage_products',
  'pricing.manage_price_lists', 'pricing.set_discount_ceilings', 'system.manage_templates',
];
