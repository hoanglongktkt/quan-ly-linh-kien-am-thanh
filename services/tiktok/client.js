/**
 * TikTok Shop OpenAPI HTTP client — Custom App.
 * Ký HMAC-SHA256 + header x-tts-access-token; chống rate-limit bằng delay/limit.
 */
import crypto from "crypto";
import { sleep } from "../../utils/concurrency.js";
import {
  TIKTOK_API_HOST,
  resolveTiktokCustomAppCredentials,
} from "./auth.js";

export const TIKTOK_HTTP_TIMEOUT_MS = 30_000;
export const TIKTOK_API_DELAY_MS = 400;
export const TIKTOK_PAGE_LIMIT = 50;
export const TIKTOK_MAX_PAGES = 20;

/**
 * Chữ ký TikTok Shop OpenAPI (Custom App).
 * input = secret + path + sorted(key+value, bỏ sign & access_token) + body + secret
 */
export function signTiktokRequest(appSecret, apiPath, queryParams, bodyString = "") {
  const secret = String(appSecret || "");
  const pathOnly = String(apiPath || "").split("?")[0];
  const keys = Object.keys(queryParams || {})
    .filter((k) => k !== "sign" && k !== "access_token")
    .sort();
  let payload = secret + pathOnly;
  for (const key of keys) {
    payload += `${key}${queryParams[key]}`;
  }
  if (bodyString) payload += bodyString;
  payload += secret;
  return crypto.createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

function buildQuery(params) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === "") continue;
    qs.set(k, String(v));
  }
  return qs.toString();
}

/**
 * Gọi TikTok Shop OpenAPI với credentials Custom App.
 * @param {string} method
 * @param {string} apiPath ví dụ /order/202309/orders/search
 * @param {{ shopId?: string, query?: Record<string, any>, body?: object|null, credentials?: object }} [opts]
 */
export async function tiktokApiRequest(method, apiPath, opts = {}) {
  const creds = opts.credentials || resolveTiktokCustomAppCredentials(opts.shopId);
  if (!creds?.valid) {
    return {
      success: false,
      error: "tiktok_credentials_missing",
      message:
        "Thiếu App Key / App Secret / Access Token Custom App. Lưu qua Seller Center → /api/tiktok/custom-app/credentials hoặc .env.",
      data: null,
    };
  }

  const timestamp = String(Math.floor(Date.now() / 1000));
  const query = {
    app_key: creds.app_key,
    timestamp,
    ...(opts.query || {}),
  };
  if (creds.shop_cipher && !query.shop_cipher) {
    query.shop_cipher = creds.shop_cipher;
  }
  if (creds.shop_id && !query.shop_id) {
    query.shop_id = creds.shop_id;
  }

  const bodyObj = opts.body === undefined ? null : opts.body;
  const bodyString =
    bodyObj == null ? "" : typeof bodyObj === "string" ? bodyObj : JSON.stringify(bodyObj);

  query.sign = signTiktokRequest(creds.app_secret, apiPath, query, bodyString);

  const url = `${TIKTOK_API_HOST}${apiPath}?${buildQuery(query)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIKTOK_HTTP_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: String(method || "GET").toUpperCase(),
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "x-tts-access-token": creds.access_token,
      },
      body: bodyString || undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    const code = json?.code ?? json?.error_code;
    const okHttp = res.ok;
    const okBiz = code === 0 || code === "0" || code == null;
    if (!okHttp || !okBiz) {
      return {
        success: false,
        error: "tiktok_api_error",
        message:
          json?.message ||
          json?.msg ||
          `TikTok API HTTP ${res.status}${code != null ? ` code=${code}` : ""}`,
        http_status: res.status,
        code,
        data: json?.data ?? null,
        raw: json,
      };
    }

    return {
      success: true,
      data: json?.data ?? json,
      request_id: json?.request_id,
      http_status: res.status,
    };
  } catch (error) {
    const aborted = error?.name === "AbortError";
    return {
      success: false,
      error: aborted ? "tiktok_timeout" : "tiktok_network_error",
      message: aborted
        ? `TikTok API timeout sau ${TIKTOK_HTTP_TIMEOUT_MS}ms`
        : error?.message || "Không gọi được TikTok API",
      data: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Nghỉ giữa các lần gọi (rate-limit / cPanel). */
export async function tiktokApiDelay(ms = TIKTOK_API_DELAY_MS) {
  await sleep(Math.max(0, Number(ms) || 0));
}
