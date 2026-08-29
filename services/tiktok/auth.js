/**
 * TikTok Shop — Custom App credentials (Seller Center).
 * Nguồn (ưu tiên): shop record → tiktok_tokens.json → channel_settings → .env
 * Đọc TIKTOK_APP_KEY / TIKTOK_APP_SECRET lúc runtime (sau dotenv).
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

/** Host OpenAPI — đọc runtime. */
export function getTiktokApiHost() {
  return String(process.env.TIKTOK_API_HOST || "https://open-api.tiktokglobalshop.com")
    .trim()
    .replace(/\/$/, "");
}

/** @deprecated dùng getTiktokApiHost() */
export const TIKTOK_API_HOST = getTiktokApiHost();

function envTiktokAppKey() {
  return String(process.env.TIKTOK_APP_KEY || "").trim();
}
function envTiktokAppSecret() {
  return String(process.env.TIKTOK_APP_SECRET || "").trim();
}
function envTiktokAccessToken() {
  return String(process.env.TIKTOK_ACCESS_TOKEN || "").trim();
}
function envTiktokShopId() {
  return String(process.env.TIKTOK_SHOP_ID || "").trim();
}
function envTiktokShopCipher() {
  return String(process.env.TIKTOK_SHOP_CIPHER || "").trim();
}

/** Snapshot env lúc import (có thể rỗng nếu dotenv chưa load) — giữ export cũ. */
export const TIKTOK_APP_KEY = envTiktokAppKey();
export const TIKTOK_APP_SECRET = envTiktokAppSecret();
export const TIKTOK_ACCESS_TOKEN = envTiktokAccessToken();
export const TIKTOK_SHOP_ID = envTiktokShopId();
export const TIKTOK_SHOP_CIPHER = envTiktokShopCipher();

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
 * Lưu / cập nhật credentials Custom App.
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

/** Trích credentials từ 1 shop object (channel_settings / FE body). */
export function extractTiktokFieldsFromShop(shop) {
  if (!shop || typeof shop !== "object") return null;
  const shop_id = String(shop.shopId || shop.shop_id || "").trim();
  if (!shop_id) return null;
  const access_token = String(
    shop.accessToken || shop.access_token || shop.apiKey || shop.api_key || "",
  ).trim();
  const app_key = String(
    shop.appKey || shop.app_key || shop.tiktokAppKey || "",
  ).trim();
  const app_secret = String(
    shop.appSecret || shop.app_secret || shop.apiSecret || shop.api_secret || "",
  ).trim();
  const shop_cipher = String(
    shop.shopCipher || shop.shop_cipher || shop.tiktokShopCipher || "",
  ).trim();
  const shop_name = String(shop.shopName || shop.shop_name || "").trim();
  return {
    shop_id,
    shop_name: shop_name || undefined,
    access_token: access_token || undefined,
    app_key: app_key || undefined,
    app_secret: app_secret || undefined,
    shop_cipher: shop_cipher || undefined,
    connected: Boolean(shop.connected),
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
    return extractTiktokFieldsFromShop(shop);
  } catch {
    return null;
  }
}

/**
 * Đồng bộ mọi shop TikTok từ channel_settings → tiktok_tokens.json
 * (gọi sau khi PUT /api/settings/channels).
 */
export function syncTiktokCredentialsFromShops(shops) {
  const list = Array.isArray(shops) ? shops : [];
  let synced = 0;
  for (const shop of list) {
    if (String(shop?.platform || "").toLowerCase() !== "tiktok") continue;
    const fields = extractTiktokFieldsFromShop(shop);
    if (!fields?.shop_id) continue;
    if (!fields.access_token && !fields.app_key && !fields.app_secret) continue;
    upsertTiktokCustomAppCredentials(fields.shop_id, {
      app_key: fields.app_key,
      app_secret: fields.app_secret,
      access_token: fields.access_token,
      shop_cipher: fields.shop_cipher,
      shop_name: fields.shop_name,
    });
    synced += 1;
  }
  return synced;
}

/**
 * Resolve credentials — luôn đọc .env lúc gọi (sau dotenv trên cPanel).
 * Ưu tiên: override shop → tokens file → channel_settings → env toàn cục.
 */
export function resolveTiktokCustomAppCredentials(shopId, shopOverride = null) {
  const want = String(shopId || envTiktokShopId() || "").trim();
  const fromOverride = shopOverride ? extractTiktokFieldsFromShop(shopOverride) : null;
  const fromFile = want ? loadTiktokTokens()[want] : null;
  const fromSettings = want ? loadTiktokShopFromChannelSettings(want) : null;

  const app_key = String(
    fromOverride?.app_key || fromFile?.app_key || fromSettings?.app_key || envTiktokAppKey() || "",
  ).trim();
  const app_secret = String(
    fromOverride?.app_secret ||
      fromFile?.app_secret ||
      fromSettings?.app_secret ||
      envTiktokAppSecret() ||
      "",
  ).trim();
  const access_token = String(
    fromOverride?.access_token ||
      fromFile?.access_token ||
      fromSettings?.access_token ||
      envTiktokAccessToken() ||
      "",
  ).trim();
  const shop_cipher = String(
    fromOverride?.shop_cipher ||
      fromFile?.shop_cipher ||
      fromSettings?.shop_cipher ||
      envTiktokShopCipher() ||
      "",
  ).trim();
  const shop_id =
    want ||
    String(fromOverride?.shop_id || fromFile?.shop_id || fromSettings?.shop_id || envTiktokShopId() || "").trim();

  const placeholder = /CHUA_CO|YOUR_|PLACEHOLDER/i;
  const valid =
    Boolean(app_key) &&
    Boolean(app_secret) &&
    Boolean(access_token) &&
    !placeholder.test(app_key) &&
    !placeholder.test(app_secret) &&
    !placeholder.test(access_token);

  let source = "none";
  if (fromOverride?.access_token || fromOverride?.app_key) source = "shop_payload";
  else if (fromFile?.access_token || fromFile?.app_key) source = "tiktok_tokens";
  else if (fromSettings?.access_token || fromSettings?.app_key) source = "channel_settings";
  else if (access_token || app_key) source = "env";

  return {
    mode: "custom_app",
    shop_id: shop_id || undefined,
    shop_name:
      fromOverride?.shop_name || fromFile?.shop_name || fromSettings?.shop_name || undefined,
    shop_cipher: shop_cipher || undefined,
    app_key: app_key || undefined,
    app_secret: app_secret || undefined,
    access_token: access_token || undefined,
    valid,
    source,
    env_app_key_configured: Boolean(envTiktokAppKey()),
    env_app_secret_configured: Boolean(envTiktokAppSecret()),
  };
}

export function isTiktokCustomAppConfigured(shopId) {
  return resolveTiktokCustomAppCredentials(shopId).valid;
}

export function isTiktokConfigValid() {
  return isTiktokCustomAppConfigured(envTiktokShopId());
}

/** @deprecated Partner OAuth — ưu tiên Custom App. */
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
  return {
    success: true,
    pending: true,
    shop_id: shopId || undefined,
    message:
      "Đã nhận code. Hệ thống dùng Custom App — lưu App Key/Secret/Access Token từ Seller Center.",
  };
}

export function listTiktokCredentialSummaries() {
  const tokens = loadTiktokTokens();
  return Object.keys(tokens).map((id) => sanitizeCredentialRecord(tokens[id]));
}
