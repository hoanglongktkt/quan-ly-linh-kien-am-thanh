export const PRICE_OFFSET = 168;

export function linearPrice(basePrice: number, step: number): number {
  return Math.max(0, Math.round(Number(basePrice) || 0)) + step * PRICE_OFFSET;
}
