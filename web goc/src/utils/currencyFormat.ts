/** Format số nguyên tiền VN: 1200000 → "1.200.000" */
export function formatVndInput(value: number | string | null | undefined): string {
  const digits = String(value ?? '').replace(/[^\d]/g, '');
  if (!digits) return '';
  const n = Number(digits);
  if (!Number.isFinite(n)) return '';
  return n.toLocaleString('vi-VN');
}

/** Parse chuỗi có dấu chấm/phẩy ngăn cách → số nguyên */
export function parseVndInput(raw: string | number | null | undefined): number {
  if (typeof raw === 'number') return Math.max(0, Math.round(raw) || 0);
  const digits = String(raw ?? '').replace(/[^\d]/g, '');
  if (!digits) return 0;
  return Math.max(0, Math.round(Number(digits)) || 0);
}
