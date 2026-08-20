export type AddressBookEntry = {
  id: string;
  name: string;
  phone: string;
  provinceCode: string;
  provinceName: string;
  districtCode: string;
  districtName: string;
  wardCode: string;
  wardName: string;
  street: string;
  addressMode: 'new2' | 'old3';
  fullAddress: string;
  savedAt: string;
};

const STORAGE_KEY = 'omni_manual_address_book';
const MAX_ENTRIES = 80;
const FETCH_TIMEOUT_MS = 8_000;

function safeParse(raw: string | null): AddressBookEntry[] {
  if (!raw) return [];
  try {
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function mapApiEntry(raw: Record<string, unknown>): AddressBookEntry | null {
  const phone = String(raw?.phone || '').replace(/\D/g, '');
  const name = String(raw?.name || '').trim();
  if (!phone && !name) return null;
  const street = String(raw?.street || raw?.address || '').trim();
  return {
    id: String(raw?.id || raw?._id || `addr-${Date.now()}`),
    name,
    phone,
    provinceCode: String(raw?.provinceCode || ''),
    provinceName: String(raw?.provinceName || raw?.province || ''),
    districtCode: String(raw?.districtCode || ''),
    districtName: String(raw?.districtName || raw?.district || ''),
    wardCode: String(raw?.wardCode || ''),
    wardName: String(raw?.wardName || raw?.ward || ''),
    street,
    addressMode: raw?.addressMode === 'old3' ? 'old3' : 'new2',
    fullAddress: String(raw?.fullAddress || '').trim(),
    savedAt: String(raw?.savedAt || new Date().toISOString()),
  };
}

export function loadAddressBook(): AddressBookEntry[] {
  try {
    return safeParse(localStorage.getItem(STORAGE_KEY));
  } catch {
    return [];
  }
}

function cacheLocal(list: AddressBookEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, MAX_ENTRIES)));
  } catch {
    /* quota / private mode */
  }
}

export function saveAddressBookEntry(entry: Omit<AddressBookEntry, 'id' | 'savedAt'>): AddressBookEntry[] {
  const list = loadAddressBook();
  const phone = String(entry.phone || '').replace(/\D/g, '');
  const next: AddressBookEntry = {
    ...entry,
    id: `addr-${Date.now()}`,
    savedAt: new Date().toISOString(),
  };
  const deduped = list.filter(
    (item) =>
      !(
        String(item.phone || '').replace(/\D/g, '') === phone &&
        item.street === entry.street &&
        item.wardCode === entry.wardCode
      ),
  );
  const merged = [next, ...deduped].slice(0, MAX_ENTRIES);
  cacheLocal(merged);
  return merged;
}

export async function fetchAddressBook(
  authHeaders: () => Record<string, string>,
): Promise<AddressBookEntry[]> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch('/api/address-book', {
      headers: authHeaders(),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    const rawList = Array.isArray(data?.entries) ? data.entries : Array.isArray(data) ? data : [];
    const mapped: AddressBookEntry[] = [];
    for (let i = 0; i < rawList.length && mapped.length < MAX_ENTRIES; i += 1) {
      const row = mapApiEntry(rawList[i] as Record<string, unknown>);
      if (row) mapped.push(row);
    }
    if (mapped.length) cacheLocal(mapped);
    return mapped.length ? mapped : loadAddressBook();
  } catch {
    return loadAddressBook();
  } finally {
    window.clearTimeout(timer);
  }
}

export async function postAddressBookEntry(
  entry: Omit<AddressBookEntry, 'id' | 'savedAt'>,
  authHeaders: () => Record<string, string>,
): Promise<AddressBookEntry | null> {
  saveAddressBookEntry(entry);
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch('/api/address-book', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: entry.name,
        phone: entry.phone,
        street: entry.street,
        address: entry.street,
        province: entry.provinceName,
        provinceName: entry.provinceName,
        provinceCode: entry.provinceCode,
        district: entry.districtName,
        districtName: entry.districtName,
        districtCode: entry.districtCode,
        ward: entry.wardName,
        wardName: entry.wardName,
        wardCode: entry.wardCode,
        fullAddress: entry.fullAddress,
        addressMode: entry.addressMode,
      }),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) return null;
    return mapApiEntry((data.entry || data) as Record<string, unknown>);
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}
