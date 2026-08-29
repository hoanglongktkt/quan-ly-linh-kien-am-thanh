/**
 * TikTok Shop OpenAPI HTTP client — Custom App.
 * Ký HMAC-SHA256 + auto refresh khi token hết hạn (retry 1 lần).
 */
import crypto from "crypto";
import { sleep } from "../../utils/concurrency.js";
import {
  TIKTOK_API_HOST,
  getTiktokApiHost,
  resolveTiktokCustomAppCredentials,
} from "./auth.js";
import { refreshTikTokToken, isTiktokTokenExpiredError } from "./token.js";

export const TIKTOK_HTTP_TIMEOUT_MS = 30_000;
export const TIKTOK_API_DELAY_MS = 400;
export const TIKTOK_PAGE_LIMIT = 50;
export const TIKTOK_MAX_PAGES = 20;

/**
 * Chữ ký TikTok Shop OpenAPI (Custom App).
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

async function tiktokApiRequestOnce(method, apiPath, opts, creds) {
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

  const host = getTiktokApiHost() || TIKTOK_API_HOST;
  const url = `${host}${apiPath}?${buildQuery(query)}`;
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

/**
 * Gọi TikTok Shop OpenAPI — tự refresh + retry 1 lần khi token hết hạn.
 * @param {string} method
 * @param {string} apiPath
 * @param {{ shopId?: string, query?: Record<string, any>, body?: object|null, credentials?: object, _retried?: boolean }} [opts]
 */
export async function tiktokApiRequest(method, apiPath, opts = {}) {
  let creds = opts.credentials || resolveTiktokCustomAppCredentials(opts.shopId);
  if (!creds?.valid) {
    return {
      success: false,
      error: "tiktok_credentials_missing",
      message:
        "Thiếu App Key / App Secret / Access Token. Lưu Authorization Code hoặc credentials Custom App / .env.",
      data: null,
    };
  }

  const first = await tiktokApiRequestOnce(method, apiPath, opts, creds);
  if (first.success) return first;

  const shopId = String(opts.shopId || creds.shop_id || "").trim();
  if (opts._retried || !shopId || !isTiktokTokenExpiredError(first)) {
    return first;
  }

  console.warn(
    `[TikTok API] Token hết hạn shop=${shopId} — auto refresh rồi retry ${apiPath}`,
  );
  const refreshed = await refreshTikTokToken(shopId);
  if (!refreshed.success) {
    return {
      success: false,
      error: "tiktok_refresh_failed",
      message:
        refreshed.message ||
        "Access Token hết hạn và không refresh được. Hãy dán Authorization Code mới.",
      data: null,
      refresh: refreshed,
      previous: first,
    };
  }

  creds = resolveTiktokCustomAppCredentials(shopId);
  if (!creds?.valid) {
    return {
      success: false,
      error: "tiktok_credentials_missing_after_refresh",
      message: "Đã refresh nhưng credentials vẫn thiếu.",
      data: null,
    };
  }

  await sleep(200);
  return tiktokApiRequestOnce(method, apiPath, { ...opts, _retried: true }, creds);
}

export async function tiktokApiDelay(ms = TIKTOK_API_DELAY_MS) {
  await sleep(Math.max(0, Number(ms) || 0));
}
