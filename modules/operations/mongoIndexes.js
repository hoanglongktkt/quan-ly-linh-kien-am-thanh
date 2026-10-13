// TTL luôn là số giây hợp lệ; cấu hình sai không được làm mất dữ liệu.
export function retentionSeconds(name, fallbackDays = 14) {
  const value = Number(process.env[name] ?? fallbackDays * 86400);
  if (!Number.isSafeInteger(value) || value < 86400 || value > 365 * 86400) {
    throw new Error(`${name}: cần số giây nguyên từ 86400 đến 31536000`);
  }
  return value;
}

/** @typedef {[Record<string, 1 | -1>, {name: string, expireAfterSeconds?: number}]} IndexSpec */
/** @type {IndexSpec[]} */
export const ORDER_OPERATIONAL_INDEXES = [
  [{ shopId: 1, orderSn: 1 }, { name: "orders_shop_order" }],
  [{ shopId: 1, status: 1, last_shopee_update_at: -1 }, { name: "orders_shop_status_update" }],
];
// Listing hiện dùng channelId và sku; không tạo index trên shopId chưa được lưu.
/** @type {IndexSpec[]} */
export const LISTING_OPERATIONAL_INDEXES = [
  [{ platform: 1, status: 1, _id: 1 }, { name: "listings_platform_status" }],
  [{ platform: 1, sku: 1 }, { name: "listings_platform_sku" }],
];
/** @type {IndexSpec[]} */
export const WEBHOOK_OPERATIONAL_INDEXES = [
  [{ state: 1, priority: -1, next_run_at: 1, _id: 1 }, { name: "webhook_jobs_claim" }],
  [{ createdAt: 1 }, { name: "webhook_jobs_metrics_window" }],
  [{ shopId: 1, createdAt: 1 }, { name: "webhook_jobs_shop_window" }],
  [{ shopId: 1, state: 1 }, { name: "webhook_jobs_shop_state" }],
  [{ state: 1, createdAt: 1, kind: 1 }, { name: "webhook_jobs_stale_sweep" }],
  // Chỉ job kết thúc có finished_at; pending/running/failed không bị TTL xóa.
  [{ finished_at: 1 }, { name: "webhook_jobs_ttl", expireAfterSeconds: 30 * 86400 }],
];

export async function ensureMongoIndex(db, collection, key, options) {
  const coll = db.collection(collection);
  let existing = [];
  try { existing = await coll.indexes(); }
  catch (error) { if (error?.code !== 26) throw error; }
  const hit = existing.find((index) => JSON.stringify(index.key) === JSON.stringify(key));
  if (hit) {
    if (options.expireAfterSeconds !== undefined && hit.expireAfterSeconds !== options.expireAfterSeconds) {
      // collMod sửa TTL tại chỗ, không tạo khoảng trống bằng dropIndex.
      await db.command({ collMod: collection, index: { name: hit.name, expireAfterSeconds: options.expireAfterSeconds } });
    }
    return hit.name;
  }
  return coll.createIndex(key, options);
}

export function operationalIndexPlan() {
  return [
    ["orders", ORDER_OPERATIONAL_INDEXES],
    ["channel_listings", LISTING_OPERATIONAL_INDEXES],
    ["webhook_jobs", WEBHOOK_OPERATIONAL_INDEXES],
    ["ops_api_errors", [
      [{ bucket_at: 1 }, { name: "ops_api_errors_window" }],
      [{ shopId: 1, bucket_at: 1 }, { name: "ops_api_errors_shop_window" }],
      [{ expires_at: 1 }, { name: "ops_api_errors_ttl", expireAfterSeconds: 0 }],
    ]],
    ["order_events", [[{ occurred_at: 1 }, { name: "order_events_ttl",
      expireAfterSeconds: retentionSeconds("ORDER_EVENT_TTL_SECONDS") }]]],
    ["sync_jobs", [[{ finished_at: 1 }, { name: "sync_jobs_ttl",
      expireAfterSeconds: retentionSeconds("SYNC_JOB_TTL_SECONDS") }]]],
  ];
}

export async function ensureOperationalIndexes(db) {
  const groups = operationalIndexPlan();
  const applied = [];
  // Tạo tuần tự để hạn chế tải lúc khởi động cPanel; không xóa index hiện có.
  for (const [collection, indexes] of groups) {
    for (const [key, options] of indexes) applied.push(await ensureMongoIndex(db, collection, key, options));
  }
  return applied;
}
