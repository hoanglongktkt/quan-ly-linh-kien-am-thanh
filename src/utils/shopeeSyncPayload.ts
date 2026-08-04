/**
 * Payload FE gửi tới POST /api/products/sync-shopee.
 * Backend tự load stock/price/item_id/model_id từ kho + Mapping (đã ép Number uint64).
 * Giữ 1 chỗ duy nhất để nút ngoài và nút trong Modal gửi giống hệt nhau.
 */
export function buildShopeeSyncPayload(productId: string): { productIds: string[] } {
  return {
    productIds: [String(productId || '').trim()].filter(Boolean),
  };
}
