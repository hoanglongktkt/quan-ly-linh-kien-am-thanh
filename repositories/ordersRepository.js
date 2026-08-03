/**
 * Orders Database Repository — chỉ giao tiếp MongoDB (bulkWrite upsert).
 * Không gọi API sàn. Controllers / Sync Service dùng lớp này để ghi đơn.
 */
import {
  bulkUpsertOrdersToStore,
  isMongoReady,
  loadOrdersFromStore,
} from "../src/db/mongoStore.ts";

/**
 * Upsert mảng đơn bằng 1 lệnh bulkWrite (updateOne + upsert:true theo orderSn).
 * @param {any[]} orders
 * @returns {Promise<{ written: number; ok: boolean; error?: string }>}
 */
export async function bulkUpsertOrders(orders) {
  if (!Array.isArray(orders) || orders.length === 0) {
    return { written: 0, ok: true };
  }
  if (!isMongoReady()) {
    console.error("[OrdersRepository] bulkUpsert SKIP — MongoDB not ready");
    return { written: 0, ok: false, error: "mongodb_not_ready" };
  }
  console.log(`[OrdersRepository] BulkWrite START ops=${orders.length}`);
  try {
    const written = await bulkUpsertOrdersToStore(orders);
    console.log(
      `[OrdersRepository] BulkWrite OK written=${written} input=${orders.length}`,
    );
    return { written, ok: true };
  } catch (err) {
    const message = err?.message || String(err);
    console.error("[OrdersRepository] BulkWrite FAILED:", message);
    return { written: 0, ok: false, error: message };
  }
}

/** Đọc đơn từ MongoDB (GET list cho FE). */
export async function findOrdersFromDb(opts) {
  if (!isMongoReady()) return [];
  return loadOrdersFromStore(opts || {});
}

export { isMongoReady, bulkUpsertOrdersToStore };
