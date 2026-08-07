/**
 * HTTP client Shopee (Axios + json-bigint).
 * Parse response uint64 (promotion_id, activity_id, medicine_id…) → String —
 * tránh JSON.parse mặc định làm tràn Number.MAX_SAFE_INTEGER.
 */
import axios from "axios";
import {
  normalizeShopeeProductIds,
  parseShopeeJson,
  stringifyShopeeJson,
} from "./jsonBig.js";

const SHOPEE_AXIOS_TIMEOUT_MS = 30_000;

const shopeeAxios = axios.create({
  timeout: SHOPEE_AXIOS_TIMEOUT_MS,
  responseType: "text",
  transitional: { forcedJSONParsing: false, silentJSONParsing: false },
  headers: { Accept: "application/json" },
  transformResponse: [
    (data) => {
      if (data == null || data === "") return {};
      if (typeof data === "object" && !Buffer.isBuffer(data)) {
        return normalizeShopeeProductIds(data);
      }
      try {
        return normalizeShopeeProductIds(parseShopeeJson(data));
      } catch {
        return { error: "json_parse_error", message: "Shopee response không phải JSON hợp lệ" };
      }
    },
  ],
});

/** GET JSON Shopee — ID lớn giữ dạng String. */
export async function shopeeAxiosGet(url, context = "shopee_get") {
  const res = await shopeeAxios.get(url);
  return { json: res.data || {}, httpStatus: res.status, context };
}

/** POST JSON Shopee — body serialize chuẩn (Number cho item_id trong safe range). */
export async function shopeeAxiosPost(url, body, context = "shopee_post") {
  const res = await shopeeAxios.post(url, body, {
    headers: { "Content-Type": "application/json" },
    transformRequest: [
      (data, headers) => {
        if (headers && typeof headers === "object") {
          headers["Content-Type"] = "application/json";
        }
        return typeof data === "string" ? data : JSON.stringify(data ?? {});
      },
    ],
  });
  return { json: res.data || {}, httpStatus: res.status, context };
}

/** Serialize khi cần giữ uint64 string trong body (promotion/activity). */
export function stringifyShopeeRequestBody(value) {
  return stringifyShopeeJson(value);
}

export { shopeeAxios };
export default shopeeAxios;
