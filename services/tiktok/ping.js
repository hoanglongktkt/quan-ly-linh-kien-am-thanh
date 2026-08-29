/**
 * Live ping TikTok Shop Custom App — xác thực token thật trước khi báo Online.
 */
import { tiktokApiRequest } from "./client.js";
import {
  resolveTiktokCustomAppCredentials,
  upsertTiktokCustomAppCredentials,
} from "./auth.js";

/** Endpoint nhẹ để test auth (danh sách shop được ủy quyền). */
const SHOPS_PING_PATH = "/authorization/202309/shops";

/**
 * Map shop từ Settings / FE → credentials Custom App.
 * FE: apiKey = Access Token; apiSecret = App Secret (nếu có); appKey = App Key.
 */
export function credentialsFromShopRecord(shop) {
  if (!shop || typeof shop !== "object") {
    return resolveTiktokCustomAppCredentials("");
  }
  const shopId = String(shop.shopId || shop.shop_id || shop.id || "").trim();
  const access_token = String(
    shop.access_token || shop.accessToken || shop.apiKey || "",
  ).trim();
  const app_secret = String(
    shop.app_secret || shop.appSecret || shop.apiSecret || "",
  ).trim();
  const app_key = String(
    shop.app_key || shop.appKey || shop.tiktokAppKey || "",
  ).trim();
  const shop_cipher = String(
    shop.shop_cipher || shop.shopCipher || shop.tiktokShopCipher || "",
  ).trim();

  // Ghi tạm vào store nếu user vừa nhập đủ (để lần sau resolve được).
  if (shopId && (access_token || app_key || app_secret)) {
    try {
      const existing = resolveTiktokCustomAppCredentials(shopId);
      upsertTiktokCustomAppCredentials(shopId, {
        app_key: app_key || existing.app_key,
        app_secret: app_secret || existing.app_secret,
        access_token: access_token || existing.access_token,
        shop_cipher: shop_cipher || existing.shop_cipher,
        shop_name: String(shop.shopName || shop.shop_name || "").trim() || undefined,
      });
    } catch {
      /* ignore persist errors during ping */
    }
  }

  const merged = resolveTiktokCustomAppCredentials(shopId);
  // Ưu tiên giá trị vừa gửi từ FE (đang test) hơn file cũ.
  return {
    ...merged,
    shop_id: shopId || merged.shop_id,
    app_key: app_key || merged.app_key,
    app_secret: app_secret || merged.app_secret,
    access_token: access_token || merged.access_token,
    shop_cipher: shop_cipher || merged.shop_cipher,
    valid: Boolean(
      (app_key || merged.app_key) &&
        (app_secret || merged.app_secret) &&
        (access_token || merged.access_token),
    ),
  };
}

/**
 * Ping thật TikTok OpenAPI.
 * @returns {Promise<{ online: boolean, connection_status: 'online'|'expired'|'missing', message: string }>}
 */
export async function pingTiktokShopConnection(shop) {
  const shopId = String(shop?.shopId || shop?.shop_id || "").trim();
  const accessToken = String(shop?.apiKey || shop?.access_token || "").trim();

  if (!shopId || !accessToken) {
    return {
      online: false,
      connection_status: "missing",
      message: "Thiếu Seller ID hoặc Access Token TikTok",
    };
  }

  const creds = credentialsFromShopRecord(shop);
  if (!creds.valid) {
    return {
      online: false,
      connection_status: "missing",
      message:
        "Thiếu App Key / App Secret / Access Token — không thể gọi API TikTok. Lưu đủ credentials Custom App (Seller Center) rồi Test lại.",
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
          ? `TikTok API OK — ${count} shop được ủy quyền (Live ping)`
          : "TikTok API OK — Access Token hợp lệ (Live ping)",
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
