import { AsyncLocalStorage } from "node:async_hooks";
import mongoose from "mongoose";
import { retentionSeconds } from "./mongoIndexes.js";

export const webhookObservation = new AsyncLocalStorage();

export function markWebhookOrderPersisted() {
  const observation = webhookObservation.getStore();
  // Ghi lần lưu thành công đầu tiên, kể cả khi bước sau đó phải retry.
  if (observation && !observation.orderPersistedAt) observation.orderPersistedAt = new Date();
}

export async function recordShopeeApiError(url, category) {
  try {
    const parsed = new URL(url);
    // Chỉ giữ shopId và loại lỗi; không lưu URL chứa access_token/sign.
    if (!/(^|\.)(shopeemobile\.com|shopee\.(com|cn))$/.test(parsed.hostname)) return;
    const shopId = parsed.searchParams.get("shop_id") || "unknown";
    if (shopId !== "unknown" && !/^\d{1,20}$/.test(shopId)) return;
    if (!["http", "network", "application", "parse"].includes(category)) return;
    const db = mongoose.connection.db;
    if (mongoose.connection.readyState !== 1 || !db) return;
    const now = Date.now();
    const bucket = Math.floor(now / 60000) * 60000;
    // Gộp theo phút/shop/loại lỗi để log không tăng theo từng request.
    await db.collection("ops_api_errors").updateOne(
      { _id: `${shopId}:${bucket}:${category}` },
      { $inc: { count: 1 }, $setOnInsert: { shopId, category, bucket_at: new Date(bucket),
        expires_at: new Date(bucket + 60000 + retentionSeconds("OPS_API_ERROR_TTL_SECONDS") * 1000) } },
      { upsert: true, maxTimeMS: 1500, timeoutMS: 1500 },
    );
  } catch {
    // Giám sát không được làm hỏng xử lý đơn khi Mongo hoặc cấu hình log lỗi.
    console.warn("[Operations] api_error_metric_write_failed");
  }
}
