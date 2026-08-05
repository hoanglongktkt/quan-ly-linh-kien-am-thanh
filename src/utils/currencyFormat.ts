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

/**
 * Parse số linh hoạt khi đang gõ: hỗ trợ thập phân `.` / `,`
 * và dấu ngăn nghìn (vd 1.200 hoặc 1.200.000).
 */
export function parseFlexibleAmount(raw: string | number | null | undefined): number {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0;
  let s = String(raw ?? '').trim().replace(/\s/g, '');
  if (!s) return 0;

  const hasComma = s.includes(',');
  const hasDot = s.includes('.');

  if (hasComma && hasDot) {
    const lastComma = s.lastIndexOf(',');
    const lastDot = s.lastIndexOf('.');
    if (lastComma > lastDot) {
      // 1.234,56
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      // 1,234.56
      s = s.replace(/,/g, '');
    }
  } else if (hasComma) {
    const parts = s.split(',');
    if (parts.length === 2 && parts[1].length > 0 && parts[1].length <= 2) {
      s = `${parts[0]}.${parts[1]}`;
    } else {
      s = s.replace(/,/g, '');
    }
  } else if (hasDot) {
    const parts = s.split('.');
    if (parts.length === 2 && parts[1].length > 0 && parts[1].length <= 2) {
      // thập phân: 9.3, 0.5, 15.50
      s = `${parts[0]}.${parts[1]}`;
    } else {
      // ngăn nghìn: 1.200 hoặc 1.200.000
      s = s.replace(/\./g, '');
    }
  }

  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Gõ tắt thông minh: nếu giá trị < 1000 thì ×1000, rồi làm tròn số nguyên.
 * Ví dụ: 9.3 → 9300, 15 → 15000, 0.5 → 500, 9300 → 9300.
 */
export function applySmartShorthand(raw: string | number | null | undefined): number {
  const n = typeof raw === 'number' ? raw : parseFlexibleAmount(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const scaled = n < 1000 ? n * 1000 : n;
  return Math.max(0, Math.round(scaled));
}
