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

/**
 * ID dạng NUMBER cho body request Shopee (Go uint64).
 * Shopee từ chối string: cannot unmarshal string into ... item_id of type uint64.
 * Chỉ dùng khi ID nằm trong Number.MAX_SAFE_INTEGER (item/model Shopee thường 10–12 chữ số).
 */
export function toShopeeIdNumber(value) {
  const id = toShopeeId(value);
  if (id == null) return null;
  if (!Number.isSafeInteger(Number(id))) {
    console.warn(
      `[Shopee uint64] ID vượt Safe Integer — không ép Number an toàn: ${id}`,
    );
    // Vẫn cố Number vì API bắt buộc kiểu số; caller có thể log thêm.
  }
  const n = Number(id);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
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

/**
 * SN alphanumeric (return_sn / order_sn) — chỉ String(), KHÔNG qua toShopeeId
 * (regex digits sẽ cắt mất phần chữ của mã YCTH).
 */
export function toShopeeSn(value) {
  if (value == null || value === "") return null;
  if (typeof value === "bigint") return value.toString();
  const s = String(value).trim();
  return s || null;
}

/** Mã yêu cầu trả hàng / hoàn tiền = return_sn (Seller Center). */
export function extractReturnRequestCode(detail) {
  if (!detail || typeof detail !== "object") return null;
  return (
    toShopeeSn(detail.return_sn) ||
    toShopeeSn(detail.returnSn) ||
    toShopeeSn(detail.return_id) ||
    null
  );
}

/**
 * Chuẩn hoá payload get_return_detail / get_return_list row:
 * uint64 (activity_id, promotion_id, item_id…) → string; return_sn / order_sn → string.
 */
export function normalizeShopeeReturnDetail(payload) {
  if (payload == null) return payload;
  const hasEnvelope = payload && typeof payload === "object" && payload.response != null;
  const root = hasEnvelope ? payload.response : payload;
  if (!root || typeof root !== "object") return payload;
  const safe = stringifyShopeeIdsDeep(root);
  const returnSn = extractReturnRequestCode(safe);
  if (returnSn) safe.return_sn = returnSn;
  const orderSn = toShopeeSn(safe.order_sn ?? safe.orderSn);
  if (orderSn) safe.order_sn = orderSn;
  // activity[] — ép activity_id string (schema uint64 mới của Shopee).
  if (Array.isArray(safe.activity)) {
    safe.activity = safe.activity.map((act) => {
      if (!act || typeof act !== "object") return act;
      const aid = toShopeeId(act.activity_id) ?? (act.activity_id != null ? String(act.activity_id) : null);
      return aid != null ? { ...act, activity_id: aid } : { ...act };
    });
  }
  if (hasEnvelope) return { ...payload, response: safe };
  return safe;
}
