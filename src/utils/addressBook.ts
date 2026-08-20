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

function safeParse(raw: string | null): AddressBookEntry[] {
  if (!raw) return [];
  try {
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export function loadAddressBook(): AddressBookEntry[] {
  try {
    return safeParse(localStorage.getItem(STORAGE_KEY));
  } catch {
    return [];
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
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  } catch {
    /* quota / private mode */
  }
  return merged;
}
