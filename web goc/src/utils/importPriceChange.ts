export type ImportPriceChangeStatus = 'new' | 'up' | 'down' | 'same';

/** Returns null when oldPrice is 0 (first import — no baseline). */
export function calcImportPriceChangePercent(
  oldPrice: number,
  newPrice: number
): number | null {
  const old = Number(oldPrice);
  const neu = Number(newPrice);
  if (!old || old <= 0) return null;
  if (!Number.isFinite(neu)) return null;
  return ((neu - old) / old) * 100;
}

export function getImportPriceChangeStatus(
  oldPrice: number,
  newPrice: number
): ImportPriceChangeStatus {
  const pct = calcImportPriceChangePercent(oldPrice, newPrice);
  if (pct === null) return 'new';
  if (pct > 0) return 'up';
  if (pct < 0) return 'down';
  return 'same';
}
