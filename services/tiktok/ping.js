/**
 * Live ping TikTok Shop — exchange auth code nếu cần, rồi gọi OpenAPI.
 */
import { tiktokApiRequest } from "./client.js";
import {
  resolveTiktokCustomAppCredentials,
  extractTiktokFieldsFromShop,
} from "./auth.js";
import { ensureTiktokInboundCredential, refreshTikTokToken } from "./token.js";

const SHOPS_PING_PATH = "/authorization/202309/shops";

export function credentialsFromShopRecord(shop) {
  const shopId = String(shop?.shopId || shop?.shop_id || "").trim();
  return resolveTiktokCustomAppCredentials(shopId, shop);
}

export async function pingTiktokShopConnection(shop) {
  const shopId = String(shop?.shopId || shop?.shop_id || "").trim();
  if (!shopId) {
    return {
      online: false,
      connection_status: "missing",
      message: "Thiếu Seller ID (shopId) TikTok",
    };
  }

  // Cấp token lần đầu nếu UI gửi Authorization Code
  const inbound = await ensureTiktokInboundCredential(shop);
  if (!inbound.success && inbound.error === "app_key_mistake") {
    return {
      online: false,
      connection_status: "missing",
      message: inbound.message,
    };
  }
  if (!inbound.success && inbound.error === "missing_token_input") {
    return {
      online: false,
      connection_status: "missing",
      message: inbound.message,
    };
  }
  // Nếu exchange auth_code thất bại → báo rõ, không giả Online
  if (!inbound.success && inbound.error !== "missing_token_input") {
    const fields = extractTiktokFieldsFromShop(shop);
    if (fields?.access_token) {
      // vẫn thử ping bằng token cũ nếu có
    } else {
      return {
        online: false,
        connection_status: "expired",
        message: inbound.message || "Không cấp được Access Token từ Authorization Code.",
      };
    }
  }

  let creds = resolveTiktokCustomAppCredentials(shopId, inbound.shopPatch
    ? { ...shop, ...inbound.shopPatch }
    : shop);

  if (!creds.valid) {
    const missing = [];
    if (!creds.app_key) missing.push("App Key (.env TIKTOK_APP_KEY)");
    if (!creds.app_secret) missing.push("App Secret (.env TIKTOK_APP_SECRET)");
    if (!creds.access_token) missing.push("Access Token / Authorization Code");
    return {
      online: false,
      connection_status: "missing",
      message: `Thiếu credentials TikTok: ${missing.join(", ")}`,
      source: creds.source,
    };
  }

  let result = await tiktokApiRequest("GET", SHOPS_PING_PATH, {
    shopId,
    credentials: creds,
  });

  // Fallback: nếu vẫn auth fail và có refresh_token — refresh rồi ping lại
  if (!result.success) {
    const refreshed = await refreshTikTokToken(shopId);
    if (refreshed.success) {
      creds = resolveTiktokCustomAppCredentials(shopId);
      result = await tiktokApiRequest("GET", SHOPS_PING_PATH, {
        shopId,
        credentials: creds,
        _retried: true,
      });
    }
  }

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
          ? `TikTok API OK — ${count} shop được ủy quyền${inbound.exchanged ? " (đã đổi Auth Code)" : ""}`
          : `TikTok API OK — Token hợp lệ${inbound.exchanged ? " (đã đổi Auth Code)" : ""}`,
    };
  }

  const msg = String(result.message || result.error || "TikTok API lỗi");
  const authFail = /token|auth|unauthorized|expire|invalid|permission|sign|refresh/i.test(msg);
  return {
    online: false,
    connection_status: authFail ? "expired" : "missing",
    message: `Lỗi kết nối TikTok: ${msg}`,
  };
}
