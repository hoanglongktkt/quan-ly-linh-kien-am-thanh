/**
 * Live ping TikTok Shop — dùng appKey/appSecret/accessToken của shop hoặc .env.
 */
import { tiktokApiRequest } from "./client.js";
import {
  resolveTiktokCustomAppCredentials,
  upsertTiktokCustomAppCredentials,
  extractTiktokFieldsFromShop,
} from "./auth.js";

const SHOPS_PING_PATH = "/authorization/202309/shops";

/**
 * Map shop FE/Settings → credentials (kết hợp .env toàn cục).
 */
export function credentialsFromShopRecord(shop) {
  const fields = extractTiktokFieldsFromShop(shop);
  const shopId = fields?.shop_id || String(shop?.shopId || shop?.shop_id || "").trim();

  if (shopId && fields && (fields.access_token || fields.app_key || fields.app_secret)) {
    try {
      const existing = resolveTiktokCustomAppCredentials(shopId);
      upsertTiktokCustomAppCredentials(shopId, {
        app_key: fields.app_key || existing.app_key,
        app_secret: fields.app_secret || existing.app_secret,
        access_token: fields.access_token || existing.access_token,
        shop_cipher: fields.shop_cipher || existing.shop_cipher,
        shop_name: fields.shop_name || existing.shop_name,
      });
    } catch {
      /* ignore */
    }
  }

  return resolveTiktokCustomAppCredentials(shopId, shop);
}

/**
 * Ping thật TikTok OpenAPI bằng credentials đã resolve.
 */
export async function pingTiktokShopConnection(shop) {
  const shopId = String(shop?.shopId || shop?.shop_id || "").trim();
  const fields = extractTiktokFieldsFromShop(shop);
  const accessToken = fields?.access_token || "";

  if (!shopId) {
    return {
      online: false,
      connection_status: "missing",
      message: "Thiếu Seller ID (shopId) TikTok",
    };
  }

  const creds = credentialsFromShopRecord(shop);

  if (!creds.access_token && !accessToken) {
    return {
      online: false,
      connection_status: "missing",
      message: "Thiếu Access Token TikTok trên shop hoặc .env (TIKTOK_ACCESS_TOKEN)",
    };
  }

  if (!creds.valid) {
    const missing = [];
    if (!creds.app_key) missing.push("App Key (shop.appKey hoặc TIKTOK_APP_KEY)");
    if (!creds.app_secret) missing.push("App Secret (shop.apiSecret hoặc TIKTOK_APP_SECRET)");
    if (!creds.access_token) missing.push("Access Token");
    return {
      online: false,
      connection_status: "missing",
      message: `Thiếu credentials TikTok: ${missing.join(", ")}. Điền trên UI hoặc file .env cPanel.`,
      env_app_key_configured: creds.env_app_key_configured,
      env_app_secret_configured: creds.env_app_secret_configured,
      source: creds.source,
    };
  }

  const result = await tiktokApiRequest("GET", SHOPS_PING_PATH, {
    shopId,
    credentials: creds,
  });

  if (result.success) {
    const shops =
      result.data?.shops ||
      result.data?.shop_list ||
      (Array.isArray(result.data) ? result.data : []);
    const count = Array.isArray(shops) ? shops.length : 0;
    return {
      online: true,
      connection_status: "online",
      message:
        count > 0
          ? `TikTok API OK — ${count} shop được ủy quyền (Live ping, source=${creds.source})`
          : `TikTok API OK — Access Token hợp lệ (Live ping, source=${creds.source})`,
    };
  }

  const msg = String(result.message || result.error || "TikTok API lỗi");
  const authFail = /token|auth|unauthorized|expire|invalid|permission|sign/i.test(msg);
  return {
    online: false,
    connection_status: authFail ? "expired" : "missing",
    message: `Lỗi kết nối TikTok: ${msg}`,
  };
}
