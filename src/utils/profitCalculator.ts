import type { SystemFee } from '../types';

function toSafeAmount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

function isFeeActive(fee: SystemFee | null | undefined): boolean {
  return fee?.active === true;
}

/** Lợi nhuận ước tính: Giá bán − Giá nhập − Σ phí đang bật. Giá nhập trống/NaN = 0, không return 0 sớm. */
export function calculateProfitWithSystemFees(
  sellPrice: number,
  importPrice: number,
  systemFees: SystemFee[] | null | undefined,
): number {
  const safeSellPrice = Number(sellPrice) || 0;
  const safeImportPrice = Number(importPrice) || 0;
  const sell = toSafeAmount(safeSellPrice);
  const cost = toSafeAmount(safeImportPrice);
  const fees = Array.isArray(systemFees) ? systemFees : [];

  const totalFees = fees
    .filter((fee) => isFeeActive(fee) && String(fee?.name || '').trim() && toSafeAmount(fee?.value) > 0)
    .reduce((sum, fee) => {
      const value = toSafeAmount(fee?.value);
      if (fee?.calculationType === 'percentage') {
        return sum + Math.round(sell * (value / 100));
      }
      return sum + Math.round(value);
    }, 0);

  const profit = sell - cost - totalFees;
  return Number.isFinite(profit) ? profit : 0;
}
