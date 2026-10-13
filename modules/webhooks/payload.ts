// Chuẩn hóa payload và khóa job; giữ nguyên quy tắc xử lý dữ liệu.
import { parseShopeeJson } from "../../services/shopee/jsonBig.js";
import { safeError } from "../../utils/safeProductionLog.js";
export function unwrapWebhookData(payload: Record<string, unknown>): Record<string, unknown> {
  const raw = payload.data;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed: unknown = parseShopeeJson(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* giữ envelope */
    }
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return payload;
}

function coerceWebhookPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const data = unwrapWebhookData(payload);
  if (data === payload) return payload;
  if (payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)) {
    return payload;
  }
  return { ...payload, data };
}

export function webhookOrderKey(payload: Record<string, unknown>): string {
  const data = unwrapWebhookData(payload);
  const shopId = String(payload.shop_id ?? data.shop_id ?? "").trim();
  const orderSn = String(
    data.ordersn ?? data.order_sn ?? data.orderSn ?? payload.ordersn ?? payload.order_sn ?? "",
  ).trim();
  return orderSn ? `${shopId}:${orderSn}` : "";
}

/** Parse body Buffer | object | string → object payload (Shopee v2 Push). uint64 → string. */
export function parseWebhookBody(reqBody: unknown): Record<string, unknown> | null {
  try {
    if (Buffer.isBuffer(reqBody)) {
      const text = reqBody.toString("utf8");
      if (!text.trim()) return null;
      const parsed: unknown = parseShopeeJson(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return coerceWebhookPayload(parsed as Record<string, unknown>);
      }
      return null;
    }
    if (typeof reqBody === "string") {
      const text = reqBody.trim();
      if (!text) return null;
      const parsed: unknown = parseShopeeJson(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return coerceWebhookPayload(parsed as Record<string, unknown>);
      }
      return null;
    }
    if (reqBody && typeof reqBody === "object" && !Array.isArray(reqBody)) {
      return coerceWebhookPayload(reqBody as Record<string, unknown>);
    }
  } catch (err) {
    console.error("[Shopee Webhook] JSON parse failed:", safeError(err));
  }
  return null;
}

export function buildWebhookJobId(
  shopId: string,
  orderSn: string,
  status: string,
  updateTime: string,
): string {
  const clean = (value: string, fallback: string) => {
    const text = String(value || "").trim().replace(/[^\w.:-]/g, "");
    return text || fallback;
  };
  return [
    clean(shopId, "0"),
    clean(orderSn, "0"),
    clean(status, "UNKNOWN"),
    clean(updateTime, "0"),
  ].join("_");
}
