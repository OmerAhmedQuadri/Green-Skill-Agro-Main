/**
 * STK-010, 011 (ADR-0033): a seller's closing count per SKU against the
 * vehicle's position. A declaration, not a calculation — any difference is
 * flagged for review and nothing is adjusted.
 */
export const CLOSING_STATUSES = ['MATCHED', 'VARIANCE_FLAGGED', 'REVIEWED'] as const;
export type ClosingStatus = (typeof CLOSING_STATUSES)[number];

export type ClosingLine = { readonly skuId: string; readonly declaredPacks: number; readonly systemPacks: number; readonly variancePacks: number };

export function compareClosing(
  declared: readonly { skuId: string; packs: number }[], system: readonly { skuId: string; packs: number }[],
): { lines: ClosingLine[]; status: 'MATCHED' | 'VARIANCE_FLAGGED' } {
  const skuIds = [...new Set([...system.map((s) => s.skuId), ...declared.map((d) => d.skuId)])];
  const lines = skuIds.map((skuId) => {
    const declaredPacks = declared.find((d) => d.skuId === skuId)?.packs ?? 0;
    const systemPacks = system.find((s) => s.skuId === skuId)?.packs ?? 0;
    return { skuId, declaredPacks, systemPacks, variancePacks: declaredPacks - systemPacks };
  });
  return { lines, status: lines.every((l) => l.variancePacks === 0) ? 'MATCHED' : 'VARIANCE_FLAGGED' };
}
