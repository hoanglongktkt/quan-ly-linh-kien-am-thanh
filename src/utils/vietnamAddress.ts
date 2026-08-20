export interface VnAdminUnit {
  name: string;
  code: number;
  id?: string | number;
  districtCode?: number;
  districtName?: string;
}

export type AddressMode = 'new2' | 'old3';

export interface StructuredAddressValue {
  name: string;
  phone: string;
  provinceCode: string;
  provinceName: string;
  districtCode: string;
  districtName: string;
  wardCode: string;
  wardName: string;
  street: string;
  addressMode: AddressMode;
  saveToAddressBook: boolean;
}

export const emptyStructuredAddress = (): StructuredAddressValue => ({
  name: '',
  phone: '',
  provinceCode: '',
  provinceName: '',
  districtCode: '',
  districtName: '',
  wardCode: '',
  wardName: '',
  street: '',
  addressMode: 'new2',
  saveToAddressBook: true,
});

export function formatFullAddress(addr: StructuredAddressValue): string {
  const parts =
    addr.addressMode === 'new2'
      ? [addr.street, addr.wardName, addr.provinceName]
      : [addr.street, addr.wardName, addr.districtName, addr.provinceName];
  return parts.filter(Boolean).join(', ');
}

export function isStructuredAddressComplete(addr: StructuredAddressValue): boolean {
  const hasCore = !!(
    addr.name.trim() &&
    addr.phone.trim() &&
    addr.street.trim() &&
    addr.provinceCode &&
    addr.wardCode
  );
  if (!hasCore) return false;
  if (addr.addressMode === 'old3' && !addr.districtCode) return false;
  return true;
}

export function normalizeVnName(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const ALIASES: Record<string, string> = {
  hcm: 'ho chi minh',
  tphcm: 'ho chi minh',
  'tp hcm': 'ho chi minh',
  'tp ho chi minh': 'ho chi minh',
  'sai gon': 'ho chi minh',
  hn: 'ha noi',
  'tp ha noi': 'ha noi',
  dn: 'da nang',
  'tp da nang': 'da nang',
};

export function matchAdminUnit<T extends VnAdminUnit>(list: T[], query: string): T | undefined {
  if (!query?.trim() || !list.length) return undefined;

  const raw = normalizeVnName(query);
  const expanded = ALIASES[raw] || raw;

  const score = (name: string): number => {
    const n = normalizeVnName(name);
    if (n === expanded || n === raw) return 100;
    if (n.includes(expanded) || expanded.includes(n)) return 80;
    const stripped = n.replace(/^(tinh|thanh pho|tp|quan|huyen|thi xa|phuong|xa|thi tran)\s+/, '');
    if (stripped === expanded || expanded.includes(stripped) || stripped.includes(expanded)) return 60;
    return 0;
  };

  let best: T | undefined;
  let bestScore = 0;
  for (const item of list) {
    const s = score(item.name);
    if (s > bestScore) {
      bestScore = s;
      best = item;
    }
  }
  return bestScore >= 60 ? best : undefined;
}

/** Chỉ giữ chữ số. Không tự thêm số 0 đầu (tránh 0944 → 00944 khi đang gõ). */
export function normalizePhone(raw: string): string {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  // Dán +840944... / 840944... → bỏ mã 84, giữ số 0 người dùng đã có.
  if (digits.startsWith('840') && digits.length >= 12) return digits.slice(2);
  return digits;
}
