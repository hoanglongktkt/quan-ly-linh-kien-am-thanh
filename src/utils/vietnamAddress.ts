export interface VnAdminUnit {
  name: string;
  code: number;
}

export interface StructuredAddressValue {
  provinceCode: string;
  provinceName: string;
  districtCode: string;
  districtName: string;
  wardCode: string;
  wardName: string;
  street: string;
}

export const emptyStructuredAddress = (): StructuredAddressValue => ({
  provinceCode: '',
  provinceName: '',
  districtCode: '',
  districtName: '',
  wardCode: '',
  wardName: '',
  street: '',
});

export function formatFullAddress(addr: StructuredAddressValue): string {
  const parts = [addr.street, addr.wardName, addr.districtName, addr.provinceName].filter(Boolean);
  return parts.join(', ');
}

export function isStructuredAddressComplete(addr: StructuredAddressValue): boolean {
  return !!(addr.provinceCode && addr.districtCode && addr.wardCode && addr.street.trim());
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
