import type { SystemFee } from '../types';

function toSafeAmount(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

function isFeeActive(fee: SystemFee): boolean {
  return fee.active === true;
}

/** Lợi nhuận ước tính: Giá bán − Giá nhập − Σ phí đang bật trong Cấu hình Chi phí Hệ thống. */
export function calculateProfitWithSystemFees(
  sellPrice: number,
  importPrice: number,
  systemFees: SystemFee[] | null | undefined,
): number {
  const sell = toSafeAmount(sellPrice);
  const cost = toSafeAmount(importPrice);
  const fees = Array.isArray(systemFees) ? systemFees : [];

  const totalFees = fees
    .filter((fee) => isFeeActive(fee) && String(fee?.name || '').trim() && toSafeAmount(fee?.value) > 0)
    .reduce((sum, fee) => {
      const value = toSafeAmount(fee.value);
      if (fee.calculationType === 'percentage') {
        return sum + Math.round(sell * (value / 100));
      }
      return sum + Math.round(value);
    }, 0);

  return sell - cost - totalFees;
}
