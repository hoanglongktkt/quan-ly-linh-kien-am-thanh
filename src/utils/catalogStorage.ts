/** Cache catalog cũ trên trình duyệt — không còn dùng, chỉ để dọn dẹp. */
export const LEGACY_CATALOG_KEYS = ['omni_products', 'omni_channel_listings'] as const;

export const CATALOG_PURGE_FLAG = 'omni_catalog_empty_v2';

export function purgeLegacyCatalogCache(): void {
  for (const key of LEGACY_CATALOG_KEYS) {
    localStorage.removeItem(key);
  }
}
