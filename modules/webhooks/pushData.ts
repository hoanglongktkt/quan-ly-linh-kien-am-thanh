// Giữ nguyên cách đọc data dạng chuỗi/object và trạng thái push.
import { parseShopeeJson } from "../../services/shopee/jsonBig.js";
export function readShopeePushData(payload: any): any {
  const envelope =
    payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  let data = envelope.data;
  if (typeof data === "string" && data.trim()) {
    try {
      const parsed = parseShopeeJson(data);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed;
    } catch {
      data = undefined;
    }
  }
  if (data && typeof data === "object" && !Array.isArray(data)) return data;
  return envelope;
}

/** body.data.status | body.data.order_status | body.status | body.order_status */
export function extractShopeeWebhookRawStatus(payload: any): string {
  const envelope =
    payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const data = readShopeePushData(payload);
  return String(
    data?.status || data?.order_status || envelope.status || envelope.order_status || "",
  )
    .trim()
    .toUpperCase();
}
