/**
 * TikTok Shop — đổi Authorization Code → token + auto refresh.
 * Auth host: https://auth.tiktok-shops.com
 *   GET /api/v2/token/get
 *   GET /api/v2/token/refresh
 */
import {
  resolveTiktokCustomAppCredentials,
  upsertTiktokCustomAppCredentials,
  extractTiktokFieldsFromShop,
  loadTiktokTokens,
  saveTiktokTokens,
} from "./auth.js";

const AUTH_HOST = () =>
  String(process.env.TIKTOK_AUTH_HOST || "https://auth.tiktok-shops.com")
    .trim()
    .replace(/\/$/, "");

const TOKEN_HTTP_TIMEOUT_MS = 25_000;
const refreshLocks = new Map();

function envAppKey() {
  return String(process.env.TIKTOK_APP_KEY || "").trim();
}
function envAppSecret() {
  return String(process.env.TIKTOK_APP_SECRET || "").trim();
}

/**
 * Phân loại chuỗi người dùng dán từ UI.
 */
export function classifyTiktokCredentialInput(raw, appKeyHint = "") {
  const value = String(raw || "").trim();
  if (!value) return { kind: "empty", value: "" };

  const appKey = String(appKeyHint || envAppKey() || "").trim();
  if (appKey && value === appKey) {
    return {
      kind: "app_key_mistake",
      value,
      message:
        "Bạn đang dán App Key vào ô Token. Hãy dán Authorization Code (sau khi authorize) hoặc Access Token.",
    };
  }

  if (/^TTP[_-]/i.test(value) || value.length >= 80) {
    return { kind: "access_token", value };
  }

  if (value.length >= 8 && value.length < 80) {
    return { kind: "auth_code", value };
  }

  return { kind: "access_token", value };
}

async function callTiktokAuthApi(path, query) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query || {})) {
    if (v != null && v !== "") qs.set(k, String(v));
  }
  const url = `${AUTH_HOST()}${path}?${qs.toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOKEN_HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
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
    const ok = res.ok && (code === 0 || code === "0");
    if (!ok) {
      return {
        success: false,
        error: "tiktok_token_api_error",
        message:
          json?.message ||
          json?.msg ||
          `TikTok token API HTTP ${res.status}${code != null ? ` code=${code}` : ""}`,
        http_status: res.status,
        code,
        data: json?.data ?? null,
        raw: json,
      };
    }
    return { success: true, data: json?.data ?? json, raw: json };
  } catch (error) {
    const aborted = error?.name === "AbortError";
    return {
      success: false,
      error: aborted ? "tiktok_token_timeout" : "tiktok_token_network",
      message: aborted
        ? `TikTok token API timeout sau ${TOKEN_HTTP_TIMEOUT_MS}ms`
        : error?.message || "Không gọi được TikTok token API",
    };
  } finally {
    clearTimeout(timer);
  }
}

function persistTokenResponse(shopId, data, extra = {}) {
  const access_token = String(data?.access_token || "").trim();
  const refresh_token = String(data?.refresh_token || "").trim();
  if (!access_token) {
    return {
      success: false,
      error: "empty_access_token",
      message: "TikTok không trả access_token.",
    };
  }

  const tokens = loadTiktokTokens();
  const prev = tokens[shopId] && typeof tokens[shopId] === "object" ? tokens[shopId] : {};
  tokens[shopId] = {
    ...prev,
    shop_id: shopId,
    mode: "custom_app",
    app_key: extra.app_key || prev.app_key,
    app_secret: extra.app_secret || prev.app_secret,
    access_token,
    refresh_token: refresh_token || prev.refresh_token,
    access_token_expire_in: data?.access_token_expire_in ?? prev.access_token_expire_in,
    refresh_token_expire_in: data?.refresh_token_expire_in ?? prev.refresh_token_expire_in,
    open_id: data?.open_id || prev.open_id,
    seller_name: data?.seller_name || prev.seller_name,
    shop_cipher: data?.cipher || data?.shop_cipher || extra.shop_cipher || prev.shop_cipher,
    shop_name: extra.shop_name || data?.seller_name || prev.shop_name,
    updated_at: new Date().toISOString(),
  };
  saveTiktokTokens(tokens);

  return {
    success: true,
    shop_id: shopId,
    access_token,
    refresh_token: refresh_token || undefined,
    access_token_expire_in: data?.access_token_expire_in,
    refresh_token_expire_in: data?.refresh_token_expire_in,
    open_id: data?.open_id,
    seller_name: data?.seller_name,
  };
}

/** Đổi Authorization Code → access_token + refresh_token. */
export async function exchangeTiktokAuthCode(authCode, opts = {}) {
  const code = String(authCode || "").trim();
  const shopId = String(opts.shopId || "").trim();
  const app_key = String(opts.appKey || envAppKey() || "").trim();
  const app_secret = String(opts.appSecret || envAppSecret() || "").trim();

  if (!code) {
    return { success: false, error: "missing_auth_code", message: "Thiếu Authorization Code." };
  }
  if (!app_key || !app_secret) {
    return {
      success: false,
      error: "missing_app_credentials",
      message:
        "Thiếu TIKTOK_APP_KEY / TIKTOK_APP_SECRET trên .env (hoặc App Key/Secret trên shop) để đổi Authorization Code.",
    };
  }
  if (!shopId) {
    return { success: false, error: "missing_shop_id", message: "Thiếu shopId khi đổi token." };
  }

  const result = await callTiktokAuthApi("/api/v2/token/get", {
    app_key,
    app_secret,
    auth_code: code,
    grant_type: "authorized_code",
  });

  if (!result.success) return { ...result, shop_id: shopId };

  return persistTokenResponse(shopId, result.data, {
    app_key,
    app_secret,
    shop_name: opts.shopName,
    shop_cipher: opts.shopCipher,
  });
}

/** Refresh access_token bằng refresh_token đã lưu. */
export async function refreshTikTokToken(shopId) {
  const id = String(shopId || "").trim();
  if (!id) {
    return { success: false, error: "missing_shop_id", message: "Thiếu shopId khi refresh token." };
  }

  if (refreshLocks.has(id)) {
    return refreshLocks.get(id);
  }

  const job = (async () => {
    const creds = resolveTiktokCustomAppCredentials(id);
    const tokens = loadTiktokTokens();
    const rec = tokens[id] || {};
    const refresh_token = String(rec.refresh_token || "").trim();
    const app_key = String(creds.app_key || envAppKey() || "").trim();
    const app_secret = String(creds.app_secret || envAppSecret() || "").trim();

    if (!refresh_token) {
      return {
        success: false,
        error: "missing_refresh_token",
        message:
          "Chưa có refresh_token. Hãy dán Authorization Code mới từ TikTok (không phải App Key) để cấp token lần đầu.",
      };
    }
    if (!app_key || !app_secret) {
      return {
        success: false,
        error: "missing_app_credentials",
        message: "Thiếu App Key/Secret để refresh token TikTok.",
      };
    }

    console.log(`[TikTok Token] Refresh token cho shop ${id}...`);
    const result = await callTiktokAuthApi("/api/v2/token/refresh", {
      app_key,
      app_secret,
      refresh_token,
      grant_type: "refresh_token",
    });

    if (!result.success) {
      console.error(`[TikTok Token] Refresh thất bại shop=${id}:`, result.message);
      return { ...result, shop_id: id };
    }

    const saved = persistTokenResponse(id, result.data, {
      app_key,
      app_secret,
      shop_name: creds.shop_name || rec.shop_name,
      shop_cipher: creds.shop_cipher || rec.shop_cipher,
    });
    console.log(`[TikTok Token] Refresh OK shop=${id}`);
    return saved;
  })();

  refreshLocks.set(id, job);
  try {
    return await job;
  } finally {
    refreshLocks.delete(id);
  }
}

/**
 * Xử lý đầu vào từ UI: auth_code → exchange; access_token → lưu; app_key nhầm → lỗi.
 */
export async function ensureTiktokInboundCredential(shop) {
  const fields = extractTiktokFieldsFromShop(shop);
  if (!fields?.shop_id) {
    return { success: false, error: "missing_shop_id", message: "Thiếu shopId." };
  }

  const app_key = String(fields.app_key || envAppKey() || "").trim();
  const app_secret = String(fields.app_secret || envAppSecret() || "").trim();
  const raw = String(fields.access_token || "").trim();
  const classified = classifyTiktokCredentialInput(raw, app_key);

  if (classified.kind === "empty") {
    return {
      success: false,
      error: "missing_token_input",
      message: "Thiếu Authorization Code hoặc Access Token.",
    };
  }

  if (classified.kind === "app_key_mistake") {
    return {
      success: false,
      error: "app_key_mistake",
      message: classified.message,
    };
  }

  if (app_key || app_secret) {
    upsertTiktokCustomAppCredentials(fields.shop_id, {
      app_key: app_key || undefined,
      app_secret: app_secret || undefined,
      shop_name: fields.shop_name,
      shop_cipher: fields.shop_cipher,
    });
  }

  if (classified.kind === "auth_code") {
    const exchanged = await exchangeTiktokAuthCode(classified.value, {
      shopId: fields.shop_id,
      appKey: app_key,
      appSecret: app_secret,
      shopName: fields.shop_name,
      shopCipher: fields.shop_cipher,
    });
    if (!exchanged.success) return exchanged;
    return {
      success: true,
      exchanged: true,
      shop_id: fields.shop_id,
      access_token: exchanged.access_token,
      refresh_token: exchanged.refresh_token,
      shopPatch: {
        accessToken: exchanged.access_token,
        apiKey: exchanged.access_token,
        appKey: app_key || undefined,
        apiSecret: app_secret || undefined,
      },
      message: "Đã đổi Authorization Code → Access Token + Refresh Token.",
    };
  }

  upsertTiktokCustomAppCredentials(fields.shop_id, {
    app_key: app_key || undefined,
    app_secret: app_secret || undefined,
    access_token: classified.value,
    shop_name: fields.shop_name,
    shop_cipher: fields.shop_cipher,
  });

  return {
    success: true,
    exchanged: false,
    shop_id: fields.shop_id,
    access_token: classified.value,
    shopPatch: {
      accessToken: classified.value,
      apiKey: classified.value,
      appKey: app_key || undefined,
      apiSecret: app_secret || undefined,
    },
    message: "Đã lưu Access Token.",
  };
}

/** Đồng bộ + exchange token cho danh sách shop TikTok (PUT settings). */
export async function syncAndExchangeTiktokShops(shops) {
  const list = Array.isArray(shops) ? shops : [];
  const next = [];
  const reports = [];

  for (const shop of list) {
    if (String(shop?.platform || "").toLowerCase() !== "tiktok") {
      next.push(shop);
      continue;
    }
    try {
      const result = await ensureTiktokInboundCredential(shop);
      reports.push({
        shop_id: shop.shopId,
        success: result.success,
        message: result.message || result.error,
        exchanged: Boolean(result.exchanged),
      });
      if (result.success && result.shopPatch) {
        next.push({ ...shop, ...result.shopPatch });
      } else {
        next.push(shop);
      }
    } catch (error) {
      reports.push({
        shop_id: shop.shopId,
        success: false,
        message: error?.message || "token_sync_failed",
      });
      next.push(shop);
    }
  }

  return { shops: next, reports };
}

export function isTiktokTokenExpiredError(result) {
  if (!result || result.success) return false;
  const status = Number(result.http_status || 0);
  if (status === 401 || status === 403) return true;
  const code = String(result.code ?? "");
  if (
    ["105001", "105002", "105003", "36009002", "36009003", "36009004", "36009005"].includes(code)
  ) {
    return true;
  }
  const msg = String(result.message || result.error || "");
  return /access.?token|token.?expir|expired|unauthorized|invalid.?token|refresh.?token/i.test(msg);
}
