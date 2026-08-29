/**
 * TikTok Shop — Custom App credentials (Seller Center).
 * Không phụ thuộc Partner Center / OAuth công khai.
 * Nguồn: .env, data/tiktok_tokens.json, hoặc shop trong channel_settings.
 */
import fs from "fs";
import path from "path";
import { resolveAppRoot, resolveAppBaseUrl } from "../../utils/appPaths.js";

const APP_ROOT = resolveAppRoot();
const APP_BASE_URL = resolveAppBaseUrl();

export const TIKTOK_TOKENS_PATH = path.resolve(APP_ROOT, "data", "tiktok_tokens.json");
const CHANNEL_SETTINGS_PATH = path.resolve(APP_ROOT, "data", "channel_settings.json");

export const TIKTOK_CALLBACK_URL =
  String(process.env.TIKTOK_CALLBACK_URL || "").trim().replace(/\/$/, "") ||
  `${APP_BASE_URL}/api/tiktok/callback`;

export const TIKTOK_CALLBACK_IDLE_MSG =
  "Callback route is active. Waiting for TikTok Shop parameters (code, shop_id)...";

/** Host OpenAPI (Custom App / Seller API). */
export const TIKTOK_API_HOST = String(
  process.env.TIKTOK_API_HOST || "https://open-api.tiktokglobalshop.com",
)
  .trim()
  .replace(/\/$/, "");

export const TIKTOK_APP_KEY = String(process.env.TIKTOK_APP_KEY || "").trim();
export const TIKTOK_APP_SECRET = String(process.env.TIKTOK_APP_SECRET || "").trim();
export const TIKTOK_ACCESS_TOKEN = String(process.env.TIKTOK_ACCESS_TOKEN || "").trim();
export const TIKTOK_SHOP_ID = String(process.env.TIKTOK_SHOP_ID || "").trim();
export const TIKTOK_SHOP_CIPHER = String(process.env.TIKTOK_SHOP_CIPHER || "").trim();

export function queryParamOne(value) {
  if (Array.isArray(value)) return String(value[0] ?? "").trim();
  return String(value ?? "").trim();
}

export function shouldOAuthRedirectToFrontend(req) {
  if (queryParamOne(req.query?.format) === "json") return false;
  if (queryParamOne(req.query?.redirect) === "0") return false;
  return true;
}

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

function ensureTokensFile() {
  const dir = path.dirname(TIKTOK_TOKENS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(TIKTOK_TOKENS_PATH)) {
    fs.writeFileSync(TIKTOK_TOKENS_PATH, "{}\n", "utf-8");
  }
}

export function loadTiktokTokens() {
  try {
    ensureTokensFile();
    const raw = fs.readFileSync(TIKTOK_TOKENS_PATH, "utf-8");
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function saveTiktokTokens(tokens) {
  ensureTokensFile();
  fs.writeFileSync(TIKTOK_TOKENS_PATH, `${JSON.stringify(tokens || {}, null, 2)}\n`, "utf-8");
  return true;
}

/**
 * Lưu / cập nhật credentials Custom App (thủ công từ Seller Center).
 * @param {string} shopId
 * @param {{ app_key?: string, app_secret?: string, access_token?: string, shop_cipher?: string, shop_name?: string }} payload
 */
export function upsertTiktokCustomAppCredentials(shopId, payload = {}) {
  const key = String(shopId || "").trim();
  if (!key) {
    return { success: false, error: "shop_id_required", message: "Thiếu shop_id / Seller ID." };
  }
  const tokens = loadTiktokTokens();
  const prev = tokens[key] && typeof tokens[key] === "object" ? tokens[key] : {};
  const next = {
    ...prev,
    shop_id: key,
    mode: "custom_app",
    app_key: String(payload.app_key ?? prev.app_key ?? "").trim() || undefined,
    app_secret: String(payload.app_secret ?? prev.app_secret ?? "").trim() || undefined,
    access_token: String(payload.access_token ?? prev.access_token ?? "").trim() || undefined,
    shop_cipher: String(payload.shop_cipher ?? prev.shop_cipher ?? "").trim() || undefined,
    shop_name: String(payload.shop_name ?? prev.shop_name ?? "").trim() || undefined,
    updated_at: new Date().toISOString(),
  };
  tokens[key] = next;
  saveTiktokTokens(tokens);
  return { success: true, shop_id: key, record: sanitizeCredentialRecord(next) };
}

function sanitizeCredentialRecord(record) {
  if (!record || typeof record !== "object") return null;
  return {
    shop_id: record.shop_id || null,
    mode: record.mode || "custom_app",
    shop_name: record.shop_name || null,
    shop_cipher: record.shop_cipher || null,
    has_app_key: Boolean(record.app_key),
    has_app_secret: Boolean(record.app_secret),
    has_access_token: Boolean(record.access_token),
    updated_at: record.updated_at || null,
  };
}

function loadTiktokShopFromChannelSettings(shopId) {
  try {
    if (!fs.existsSync(CHANNEL_SETTINGS_PATH)) return null;
    const raw = fs.readFileSync(CHANNEL_SETTINGS_PATH, "utf-8");
    const parsed = JSON.parse(raw || "{}");
    const shops = Array.isArray(parsed?.shops) ? parsed.shops : [];
    const want = String(shopId || "").trim();
    const shop = shops.find(
      (s) =>
        String(s?.platform || "").toLowerCase() === "tiktok" &&
        String(s?.shopId || s?.id || "").trim() === want,
    );
    if (!shop) return null;
    return {
      shop_id: String(shop.shopId || shop.id || "").trim(),
      shop_name: String(shop.shopName || "").trim() || undefined,
      // FE hiện lưu Access Token vào apiKey; App Secret (nếu có) vào apiSecret.
      access_token: String(shop.apiKey || "").trim() || undefined,
      app_secret: String(shop.apiSecret || "").trim() || undefined,
      app_key: String(shop.appKey || shop.tiktokAppKey || "").trim() || undefined,
      shop_cipher: String(shop.shopCipher || shop.tiktokShopCipher || "").trim() || undefined,
      connected: Boolean(shop.connected),
    };
  } catch {
    return null;
  }
}

/**
 * Resolve credentials Custom App theo thứ tự:
 * 1) data/tiktok_tokens.json (shop)
 * 2) channel_settings shops[]
 * 3) biến môi trường (.env)
 */
export function resolveTiktokCustomAppCredentials(shopId) {
  const want = String(shopId || TIKTOK_SHOP_ID || "").trim();
  const fromFile = want ? loadTiktokTokens()[want] : null;
  const fromSettings = want ? loadTiktokShopFromChannelSettings(want) : null;

  const app_key =
    String(fromFile?.app_key || fromSettings?.app_key || TIKTOK_APP_KEY || "").trim();
  const app_secret =
    String(fromFile?.app_secret || fromSettings?.app_secret || TIKTOK_APP_SECRET || "").trim();
  const access_token =
    String(fromFile?.access_token || fromSettings?.access_token || TIKTOK_ACCESS_TOKEN || "").trim();
  const shop_cipher =
    String(fromFile?.shop_cipher || fromSettings?.shop_cipher || TIKTOK_SHOP_CIPHER || "").trim();
  const shop_id = want || String(fromFile?.shop_id || fromSettings?.shop_id || TIKTOK_SHOP_ID || "").trim();

  const valid =
    Boolean(app_key) &&
    Boolean(app_secret) &&
    Boolean(access_token) &&
    !/CHUA_CO|YOUR_|PLACEHOLDER/i.test(app_key) &&
    !/CHUA_CO|YOUR_|PLACEHOLDER/i.test(app_secret) &&
    !/CHUA_CO|YOUR_|PLACEHOLDER/i.test(access_token);

  return {
    mode: "custom_app",
    shop_id: shop_id || undefined,
    shop_name: fromFile?.shop_name || fromSettings?.shop_name || undefined,
    shop_cipher: shop_cipher || undefined,
    app_key: app_key || undefined,
    app_secret: app_secret || undefined,
    access_token: access_token || undefined,
    valid,
    source: fromFile?.access_token
      ? "tiktok_tokens"
      : fromSettings?.access_token
        ? "channel_settings"
        : access_token
          ? "env"
          : "none",
  };
}

export function isTiktokCustomAppConfigured(shopId) {
  return resolveTiktokCustomAppCredentials(shopId).valid;
}

/** Alias cũ — Custom App cần App Key + Secret + Access Token. */
export function isTiktokConfigValid() {
  return isTiktokCustomAppConfigured(TIKTOK_SHOP_ID);
}

/**
 * @deprecated Partner OAuth — giữ khung tương thích callback; ưu tiên Custom App + token thủ công.
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
  console.warn(
    "[TikTok] OAuth Partner không dùng cho Custom App. Hãy lưu Access Token thủ công qua /api/tiktok/custom-app/credentials.",
  );
  return {
    success: true,
    pending: true,
    shop_id: shopId || undefined,
    message:
      "Đã nhận code. Hệ thống đang dùng mô hình Custom App — hãy nhập App Key/Secret/Access Token thủ công từ Seller Center.",
  };
}

export function listTiktokCredentialSummaries() {
  const tokens = loadTiktokTokens();
  return Object.keys(tokens).map((id) => sanitizeCredentialRecord(tokens[id]));
}
