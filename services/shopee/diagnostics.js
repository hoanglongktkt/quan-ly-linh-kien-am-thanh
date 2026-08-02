/**
 * Shopee connectivity diagnostics.
 * Phase 6 — tách từ server.ts.
 */
import {
  isShopeeConfigValid,
  loadShopeeTokens,
  getValidShopeeAccessToken,
  shopeeSign,
  SHOPEE_PARTNER_KEY,
  SHOPEE_PARTNER_ID,
  SHOPEE_ENV,
  SHOPEE_HOST,
  SHOPEE_TOKENS_PATH,
} from "./auth.js";
import {
  fetchWithTimeout,
  SHOPEE_TLS_MIN_VERSION,
  SHOPEE_TLS_MAX_VERSION,
  SHOPEE_HTTP_TIMEOUT_MS,
} from "./client.js";
import { parseShopeeJson } from "./jsonBig.js";

export async function runShopeeConnectivityDiagnostics(shopIdInput) {
  const steps = [];
  const maskedPartnerKey = SHOPEE_PARTNER_KEY
    ? `${SHOPEE_PARTNER_KEY.slice(0, 4)}…${SHOPEE_PARTNER_KEY.slice(-4)}`
    : "";

  steps.push({
    step: "env_partner_config",
    ok: isShopeeConfigValid(),
    code: isShopeeConfigValid() ? "OK" : "MISSING_PARTNER_CONFIG",
    detail: isShopeeConfigValid()
      ? "SHOPEE_PARTNER_ID / SHOPEE_PARTNER_KEY hợp lệ (trên backend cPanel .env hoặc SetEnv)."
      : `Thiếu hoặc sai Partner credentials. partner_id="${SHOPEE_PARTNER_ID || "(rỗng)"}", key=${SHOPEE_PARTNER_KEY ? "đã set" : "(rỗng)"}`,
    data: {
      shopee_env: SHOPEE_ENV,
      shopee_host: SHOPEE_HOST,
      partner_id: SHOPEE_PARTNER_ID || null,
      partner_key_preview: SHOPEE_PARTNER_KEY ? maskedPartnerKey : null,
      tls_min_version: SHOPEE_TLS_MIN_VERSION,
      tls_max_version: SHOPEE_TLS_MAX_VERSION,
      http_dispatcher_connections: 3,
      note: "Biến SHOPEE_* phải cấu hình trên cPanel backend — KHÔNG chỉ trên Vercel frontend.",
    },
  });

  steps.push({
    step: "tls_http_client",
    ok: true,
    code: "OK",
    detail: `Shopee HTTP client dùng undici Agent TLS ${SHOPEE_TLS_MIN_VERSION}–${SHOPEE_TLS_MAX_VERSION}, keepAlive, max 3 connections.`,
    data: {
      tls_min_version: SHOPEE_TLS_MIN_VERSION,
      tls_max_version: SHOPEE_TLS_MAX_VERSION,
      timeout_ms: SHOPEE_HTTP_TIMEOUT_MS,
      override_env: "SHOPEE_TLS_MIN_VERSION / SHOPEE_TLS_MAX_VERSION",
    },
  });

  if (!isShopeeConfigValid()) {
    return { ok: false, code: "MISSING_PARTNER_CONFIG", steps };
  }

  const tokens = loadShopeeTokens();
  const availableShopIds = Object.keys(tokens);
  steps.push({
    step: "oauth_token_store",
    ok: availableShopIds.length > 0,
    code: availableShopIds.length > 0 ? "OK" : "MISSING_OAUTH_TOKEN",
    detail:
      availableShopIds.length > 0
        ? `Có token OAuth cho shop: ${availableShopIds.join(", ")}`
        : "Chưa có shop nào trong data/shopee_tokens.json — cần OAuth lại qua /api/shopee/callback",
    data: { availableShopIds, tokensPath: SHOPEE_TOKENS_PATH },
  });

  const shopId = String(shopIdInput || availableShopIds[0] || "").trim();
  if (!shopId) {
    steps.push({
      step: "shop_id",
      ok: false,
      code: "MISSING_OAUTH_TOKEN",
      detail: "Không có shop_id để kiểm tra. Truyền ?shop_id= hoặc OAuth shop trước.",
    });
    return { ok: false, code: "MISSING_OAUTH_TOKEN", steps };
  }

  let accessToken = null;
  try {
    accessToken = await getValidShopeeAccessToken(shopId);
    steps.push({
      step: "access_token",
      ok: Boolean(accessToken),
      code: accessToken ? "OK" : "INVALID_TOKEN",
      detail: accessToken
        ? `Lấy được access_token cho shop_id=${shopId}`
        : `Không lấy được token hợp lệ cho shop_id=${shopId} (hết hạn / refresh fail)`,
      data: { shopId },
    });
  } catch (error) {
    steps.push({
      step: "access_token",
      ok: false,
      code: "INVALID_TOKEN",
      detail: error?.message || String(error),
    });
    return { ok: false, code: "INVALID_TOKEN", steps };
  }

  if (!accessToken) {
    return { ok: false, code: "INVALID_TOKEN", steps };
  }

  try {
    const apiPath = "/api/v2/shop/get_shop_info";
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);
    const url = `${SHOPEE_HOST}${apiPath}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&access_token=${accessToken}&shop_id=${shopId}&sign=${sign}`;
    const res = await fetchWithTimeout(url);
    const rawText = await res.text();
    const json = rawText ? parseShopeeJson(rawText) : {};

    const shopeeErr = String(json?.error || "").trim();
    const ok = res.ok && !shopeeErr;
    let code = "OK";
    let detail = `HTTP ${res.status} — gọi ${SHOPEE_HOST} thành công`;

    if (!ok) {
      const errLower = shopeeErr.toLowerCase();
      if (/invalid.*token|error_auth|refresh/.test(errLower)) code = "INVALID_TOKEN";
      else if (/error_param|invalid.*partner|sign/.test(errLower)) code = "MISSING_PARTNER_CONFIG";
      else code = "SHOPEE_API_ERROR";
      detail = shopeeErr
        ? `Shopee trả lỗi: ${shopeeErr} — ${json?.message || ""}`.trim()
        : `HTTP ${res.status} từ Shopee API`;
    }

    steps.push({
      step: "shopee_api_ping",
      ok,
      code,
      detail,
      data: { httpStatus: res.status, shopeeResponse: json },
    });

    return { ok, code, steps, shopId };
  } catch (error) {
    const isTimeout = error?.name === "AbortError";
    const code = isTimeout
      ? "TIMEOUT"
      : error?.cause?.code === "ENOTFOUND"
        ? "NETWORK_ERROR"
        : "UNKNOWN_ERROR";
    steps.push({
      step: "shopee_api_ping",
      ok: false,
      code,
      detail: isTimeout
        ? "Timeout 12s khi gọi partner.shopeemobile.com"
        : error?.message || String(error),
    });
    return { ok: false, code, steps, shopId };
  }
}
