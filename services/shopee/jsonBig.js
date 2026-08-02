/**
 * Shopee OpenAPI uint64 — parse JSON không mất precision (Safe Integer).
 * storeAsString: số ngoài Number.MAX_SAFE_INTEGER → string.
 */
import JSONBigFactory from "json-bigint";

const JSONBig = JSONBigFactory({ storeAsString: true });

/** Parse response Shopee — thay JSON.parse mặc định. */
export function parseShopeeJson(data) {
  if (data == null || data === "") return {};
  if (typeof data === "object" && !Buffer.isBuffer(data)) return data;
  const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
  if (!text.trim()) return {};
  return JSONBig.parse(text);
}

/** Serialize body gửi Shopee — giữ nguyên string ID (uint64) nếu đã là chuỗi. */
export function stringifyShopeeJson(value) {
  return JSONBig.stringify(value);
}

/**
 * Chuẩn hoá ID Shopee (item_id / model_id / return_id / transaction_id / shop_id…) → string digits.
 * Tuyệt đối không dùng Number() — tránh mất precision uint64.
 */
export function toShopeeId(value) {
  if (value == null || value === "") return null;
  if (typeof value === "bigint") {
    const s = value.toString();
    return s === "0" ? null : s;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    // Chỉ chấp nhận nếu vẫn trong safe integer (đã parse bằng Number trước đó).
    if (!Number.isSafeInteger(value)) {
      console.warn(
        `[Shopee uint64] ID vượt Safe Integer đã bị Number() làm tròn — bỏ qua: ${value}`,
      );
      return null;
    }
    return String(Math.trunc(value));
  }
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return raw === "0" ? null : raw;
  const m = raw.match(/(\d{6,})/);
  if (m?.[1] && m[1] !== "0") return m[1];
  const m2 = raw.match(/(\d+)/);
  if (m2?.[1] && m2[1] !== "0") return m2[1];
  return null;
}

export function isValidShopeeId(value) {
  const id = toShopeeId(value);
  return id != null && /^\d+$/.test(id);
}

/** Ép field ID trong object (in-place) sang string — dùng trước khi ghi Mongo. */
const SHOPEE_ID_KEYS = new Set([
  "item_id",
  "model_id",
  "return_id",
  "transaction_id",
  "order_id",
  "variation_id",
  "package_id",
  "promotion_id",
  "activity_id",
  "shopeeItemId",
  "shopeeModelId",
  "shopeeId",
  "itemId",
  "modelId",
  "productId",
  "shop_id",
  "shopId",
  "main_account_id",
  "buyer_user_id",
  "user_id",
]);

export function stringifyShopeeIdsDeep(input, depth = 0) {
  if (input == null || depth > 12) return input;
  if (Array.isArray(input)) {
    return input.map((v) => stringifyShopeeIdsDeep(v, depth + 1));
  }
  if (typeof input !== "object") return input;
  const out = { ...input };
  for (const [key, val] of Object.entries(out)) {
    if (SHOPEE_ID_KEYS.has(key) && val != null && val !== "") {
      const id = toShopeeId(val);
      if (id != null) out[key] = id;
      else if (typeof val === "number" || typeof val === "bigint") out[key] = String(val);
      else out[key] = String(val);
      continue;
    }
    if (val && typeof val === "object") {
      out[key] = stringifyShopeeIdsDeep(val, depth + 1);
    }
  }
  return out;
}
