/**
 * TikTok Shop OAuth helpers — callback URL, query parse, frontend redirect.
 * Token exchange: khung sẵn, gọi API thật khi có App Key/Secret.
 */
import { resolveAppBaseUrl } from "../../utils/appPaths.js";

const APP_BASE_URL = resolveAppBaseUrl();

function resolveTiktokCallbackUrl() {
  const explicit = String(process.env.TIKTOK_CALLBACK_URL || "").trim().replace(/\/$/, "");
  if (explicit) return explicit;
  return `${APP_BASE_URL}/api/tiktok/callback`;
}

export const TIKTOK_CALLBACK_URL = resolveTiktokCallbackUrl();
export const TIKTOK_CALLBACK_IDLE_MSG =
  "Callback route is active. Waiting for TikTok Shop parameters (code, shop_id)...";

export const TIKTOK_APP_KEY = String(process.env.TIKTOK_APP_KEY || "").trim();
export const TIKTOK_APP_SECRET = String(process.env.TIKTOK_APP_SECRET || "").trim();

/** Host đổi auth_code → access_token (TikTok Shop Partner). */
export const TIKTOK_TOKEN_HOST =
  String(process.env.TIKTOK_TOKEN_HOST || "https://auth.tiktok-shops.com").trim().replace(/\/$/, "");

export function isTiktokConfigValid() {
  return (
    TIKTOK_APP_KEY.length > 0 &&
    TIKTOK_APP_SECRET.length > 0 &&
    !/CHUA_CO|YOUR_|PLACEHOLDER/i.test(TIKTOK_APP_KEY) &&
    !/CHUA_CO|YOUR_|PLACEHOLDER/i.test(TIKTOK_APP_SECRET)
  );
}

export function queryParamOne(value) {
  if (Array.isArray(value)) return String(value[0] ?? "").trim();
  return String(value ?? "").trim();
}

export function shouldOAuthRedirectToFrontend(req) {
  if (queryParamOne(req.query?.format) === "json") return false;
  if (queryParamOne(req.query?.redirect) === "0") return false;
  return true;
}

/**
 * Redirect về trang Cấu hình & Kết nối sàn.
 * success → tiktok_linked=1 ; lỗi → tiktok_linked=0&error=...
 */
export function buildOAuthFrontendRedirectUrl(req, result) {
  const shopId = String(result.shop_id || queryParamOne(req.query?.shop_id) || "");
  const base = `${APP_BASE_URL}/?tab=settings`;
  if (result.success) {
    const shopQ = shopId ? `&shop_id=${encodeURIComponent(shopId)}` : "";
    return `${base}&tiktok_linked=1${shopQ}`;
  }
  const errMsg = result.message || result.error || "token_exchange_failed";
  const shopQ = shopId ? `&shop_id=${encodeURIComponent(shopId)}` : "";
  return `${base}&tiktok_linked=0${shopQ}&error=${encodeURIComponent(errMsg)}`;
}

/**
 * Đổi Authorization Code lấy access_token.
 * TODO: hoàn thiện khi có TIKTOK_APP_KEY / TIKTOK_APP_SECRET trên .env cPanel.
 *
 * @param {string} code
 * @param {{ shopId?: string }} [opts]
 * @returns {Promise<{ success: boolean, shop_id?: string, access_token?: string, refresh_token?: string, error?: string, message?: string, pending?: boolean }>}
 */
export async function exchangeTiktokAuthCode(code, opts = {}) {
  const shopId = String(opts.shopId || "").trim();

  if (!code) {
    return {
      success: false,
      shop_id: shopId || undefined,
      error: "missing_code",
      message: "Thiếu authorization code từ TikTok Shop.",
    };
  }

  if (!isTiktokConfigValid()) {
    // Khung sẵn: nhận code thành công nhưng chưa cấu hình App Key/Secret để đổi token.
    console.warn(
      "[TikTok OAuth] Nhận code OK nhưng TIKTOK_APP_KEY/TIKTOK_APP_SECRET chưa cấu hình — bỏ qua token exchange.",
      JSON.stringify({ code_length: code.length, shop_id: shopId || null }),
    );
    return {
      success: true,
      pending: true,
      shop_id: shopId || undefined,
      message:
        "Đã nhận authorization code từ TikTok. Chưa đổi token vì App Key/Secret chưa cấu hình trên server.",
    };
  }

  try {
    // TODO: gọi API thật TikTok Shop — POST /api/v2/token/get
    // Body mẫu: { app_key, app_secret, auth_code: code, grant_type: "authorized_code" }
    // const url = `${TIKTOK_TOKEN_HOST}/api/v2/token/get`;
    // const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({...}) });
    // const data = await res.json();
    // → lưu access_token / refresh_token / open_id / seller info vào DB hoặc file tokens.

    console.log(
      "[TikTok OAuth] TODO token exchange — App Key đã có, chờ implement call API.",
      JSON.stringify({
        code_length: code.length,
        shop_id: shopId || null,
        token_host: TIKTOK_TOKEN_HOST,
      }),
    );

    return {
      success: true,
      pending: true,
      shop_id: shopId || undefined,
      message:
        "Đã nhận code. Token exchange TikTok Shop đang ở trạng thái TODO — sẽ lưu token khi hoàn thiện API call.",
    };
  } catch (error) {
    return {
      success: false,
      shop_id: shopId || undefined,
      error: error?.message || "token_exchange_error",
      message: error?.message || "Lỗi đổi code lấy access_token TikTok.",
    };
  }
}
