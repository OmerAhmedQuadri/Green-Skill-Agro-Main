/**
 * ADR-0057: the mark the app and its delivery documents show — Green Agro's
 * logo, or the sprout symbol used before it. The sprout also stands in
 * wherever the logo file cannot be shown. Switching back is this one line.
 */
export const BRAND_MARKS = ['LOGO', 'SYMBOL'] as const;
export type BrandMarkKind = (typeof BRAND_MARKS)[number];
export const BRAND_MARK: BrandMarkKind = 'LOGO';
