/**
 * Shopee OAuth / token store / access-token refresh.
 * Phase 6 — tách từ server.ts.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { resolveAppRoot, resolveAppBaseUrl } from "../../utils/appPaths.js";
import { fetchWithTimeout, SHOPEE_REAUTH_REQUIRED_MESSAGE } from "./client.js";
import { parseShopeeJson, toShopeeId } from "./jsonBig.js";

export { SHOPEE_REAUTH_REQUIRED_MESSAGE };

const APP_ROOT = resolveAppRoot();
const APP_BASE_URL = resolveAppBaseUrl();

/** Shopee console khai báo domain quanly — redirect_uri phải cùng domain đó. */
function resolveShopeeCallbackUrl() {
  const explicit = String(process.env.SHOPEE_CALLBACK_URL || "").trim().replace(/\/$/, "");
  if (explicit) return explicit;
  return `${APP_BASE_URL}/api/shopee/callback`;
}

export const SHOPEE_CALLBACK_URL = resolveShopeeCallbackUrl();
/** Canonical Push URL — khớp giao diện Cài đặt. */
export const SHOPEE_WEBHOOK_URL = `${APP_BASE_URL}/api/shopee/webhook`;
export const SHOPEE_CALLBACK_IDLE_MSG =
  "Callback route is active. Waiting for Shopee parameters (code, shop_id)...";

export const SHOPEE_ENV = (process.env.SHOPEE_ENV || "live").toLowerCase();
export const SHOPEE_HOST = "https://partner.shopeemobile.com";
if (SHOPEE_ENV !== "live") {
  console.warn(`[Shopee API] SHOPEE_ENV=${SHOPEE_ENV} — chỉ dùng host Live: ${SHOPEE_HOST}`);
}
export const SHOPEE_PARTNER_ID = process.env.SHOPEE_PARTNER_ID || "";
export const SHOPEE_PARTNER_KEY = process.env.SHOPEE_PARTNER_KEY || "";

export function isShopeeConfigValid() {
  return /^\d+$/.test(SHOPEE_PARTNER_ID) && SHOPEE_PARTNER_KEY.length > 0 && !/CHUA_CO|YOUR_LIVE/i.test(SHOPEE_PARTNER_KEY);
}

if (!isShopeeConfigValid()) {
  console.warn(
    `[Shopee API] \u26A0\uFE0F SHOPEE_PARTNER_ID (hi\u1EC7n t\u1EA1i: "${SHOPEE_PARTNER_ID || "(r\u1ED7ng)"}") ho\u1EB7c SHOPEE_PARTNER_KEY ch\u01B0a \u0111\u01B0\u1EE3c \u0111i\u1EC1n \u0111\xFAng trong .env. ` +
      "Partner_id ph\u1EA3i l\xE0 m\u1ED9t s\u1ED1 nguy\xEAn (v\xED d\u1EE5: 2001234), l\u1EA5y t\u1EEB App PRODUCTION (Live) tr\xEAn open.shopee.com, KH\xD4NG d\xF9ng Sandbox. M\u1ECDi l\u1EA7n g\u1ECDi API Shopee s\u1EBD b\u1EC3 tr\u1EA3 l\u1ED7i error_param cho \u0111\u1EBFn khi s\u1EEDa \u0111\xFAng gi\xE1 tr\u1ECB n\xE0y."
  );
}

export const SHOPEE_TOKENS_PATH = path.resolve(APP_ROOT, "data", "shopee_tokens.json");
const SHOPEE_OAUTH_LAST_PATH = path.resolve(APP_ROOT, "data", "shopee_oauth_last.json");

/** Deps từ server.ts (channel settings sync chưa tách hết). */
let deps = {
  syncOAuthShopsToChannelSettings: () => {},
  logOAuthSaveError: () => {},
};

export function initShopeeAuth(partial) {
  deps = { ...deps, ...partial };
}

export function ensureDataDirs() {
  const dataDir = path.join(APP_ROOT, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(SHOPEE_TOKENS_PATH)) {
    fs.writeFileSync(SHOPEE_TOKENS_PATH, "{}\n", "utf-8");
  }
}

export function saveOAuthAudit(entry) {
  try {
    ensureDataDirs();
    fs.writeFileSync(
      SHOPEE_OAUTH_LAST_PATH,
      JSON.stringify({ ...entry, at: new Date().toISOString() }, null, 2),
      "utf-8",
    );
  } catch (error) {
    console.error("[Shopee OAuth] Failed to write shopee_oauth_last.json:", error);
  }
}

export function loadLastOAuthAudit() {
  try {
    if (!fs.existsSync(SHOPEE_OAUTH_LAST_PATH)) return null;
    return JSON.parse(fs.readFileSync(SHOPEE_OAUTH_LAST_PATH, "utf-8"));
  } catch {
    return null;
  }
}

export function bootShopeeAuth() {
  ensureDataDirs();
  try {
    const normalized = normalizeTokenStore(loadShopeeTokens());
    if (Object.keys(normalized).length > 0) {
      saveShopeeTokens(normalized);
      console.log(`[Boot] Normalized shopee_tokens.json keys: [${Object.keys(normalized).join(", ")}]`);
    }
  } catch (error) {
    console.error("[Boot] Failed to normalize shopee_tokens.json:", error);
  }
  console.log(
    `[Boot] APP_ROOT=${APP_ROOT} | cwd=${process.cwd()} | SHOPEE_TOKENS_PATH=${SHOPEE_TOKENS_PATH} | exists=${fs.existsSync(SHOPEE_TOKENS_PATH)} | SHOPEE_CALLBACK_URL=${SHOPEE_CALLBACK_URL}`,
  );
}

export function loadShopeeTokens() {
  try {
    if (!fs.existsSync(SHOPEE_TOKENS_PATH)) return {};
    const raw = fs.readFileSync(SHOPEE_TOKENS_PATH, "utf-8");
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const map = {};
      for (const row of parsed) {
        const k = normalizeShopIdKey(row?.shop_id ?? row?.shopId);
        if (k) map[k] = row;
      }
      return map;
    }
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    console.error("[Shopee Tokens] Failed to read shopee_tokens.json:", error);
    return {};
  }
}

function maskTokenStoreForLog(tokens) {
  const masked = {};
  for (const [key, record] of Object.entries(tokens || {})) {
    masked[key] = {
      shop_id: record?.shop_id ?? key,
      oauth_shop_id: record?.oauth_shop_id ?? null,
      shop_id_list: record?.shop_id_list ?? [],
      merchant_id_list: record?.merchant_id_list ?? [],
      expire_in: record?.expire_in ?? null,
      obtained_at: record?.obtained_at ?? null,
      access_token: record?.access_token ? `${String(record.access_token).slice(0, 16)}…` : null,
      refresh_token: record?.refresh_token ? `${String(record.refresh_token).slice(0, 16)}…` : null,
    };
  }
  return masked;
}

export function saveShopeeTokens(tokensToWrite) {
  const absPath = path.resolve(SHOPEE_TOKENS_PATH);
  try {
    ensureDataDirs();

    const onDisk = normalizeTokenStore(loadShopeeTokens());
    const tokensData = { ...onDisk };
    const keysBefore = Object.keys(tokensData);

    for (const [rawKey, record] of Object.entries(tokensToWrite || {})) {
      const shop_id = normalizeShopIdKey(record?.shop_id ?? rawKey);
      if (!shop_id || !record) continue;
      tokensData[shop_id] = {
        ...tokensData[shop_id],
        ...record,
        shop_id,
      };
      console.log(`[Shopee Tokens] UPSERT shop_id=${shop_id}`);
    }

    const keysAfter = Object.keys(tokensData);
    console.log(
      "DEBUG SAVE: Merge keys",
      JSON.stringify({ keysBefore, keysAfter, addedOrUpdated: keysAfter.filter((k) => !keysBefore.includes(k) || tokensToWrite[k]) }),
    );
    console.log("DEBUG SAVE: Full tokensData file keys:", keysAfter);
    console.log(
      "DEBUG SAVE: Full tokensData (masked):",
      JSON.stringify(maskTokenStoreForLog(tokensData)),
    );

    const payload = JSON.stringify(tokensData, null, 2);
    console.log(
      "[Shopee Tokens] fs.writeFileSync — TRƯỚC KHI GHI",
      JSON.stringify({
        absPath,
        SHOPEE_TOKENS_PATH,
        APP_ROOT,
        keys: keysAfter,
        byteLength: Buffer.byteLength(payload, "utf-8"),
      }),
    );
    fs.writeFileSync(absPath, payload, "utf-8");
    console.log(
      "[Shopee Tokens] fs.writeFileSync — GHI THÀNH CÔNG",
      JSON.stringify({ absPath, keys: keysAfter, fileSize: fs.statSync(absPath).size }),
    );
    return true;
  } catch (error) {
    deps.logOAuthSaveError("saveShopeeTokens", error);
    console.error(
      "[Shopee Tokens] fs.writeFileSync — LỖI GHI FILE",
      JSON.stringify({
        absPath,
        SHOPEE_TOKENS_PATH,
        errorMessage: error?.message || String(error),
        errorCode: error?.code || null,
      }),
    );
    return false;
  }
}

export function normalizeShopIdKey(shopId) {
  const key = String(shopId ?? "").trim();
  return /^\d+$/.test(key) ? key : "";
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

export function buildOAuthFrontendRedirectUrl(req, result) {
  const oauthShopId = String(result.oauth_shop_id || queryParamOne(req.query.shop_id) || "");
  const expectedShop = queryParamOne(req.query?.expected_shop) || String(result.expected_shop_id || "");
  if (result.success) {
    const savedQuery = encodeURIComponent((result.saved_shop_ids || []).join(","));
    const expectedQuery = expectedShop ? `&expected_shop=${encodeURIComponent(expectedShop)}` : "";
    return `${APP_BASE_URL}/?shopee_linked=1&shop_id=${encodeURIComponent(oauthShopId)}&saved_shops=${savedQuery}${expectedQuery}`;
  }
  const errMsg = result.message || result.error || "token_exchange_failed";
  return `${APP_BASE_URL}/?shopee_linked=0&shop_id=${encodeURIComponent(oauthShopId)}&error=${encodeURIComponent(errMsg)}`;
}

function normalizeShopeeTokenResponse(raw) {
  const inner =
    raw?.response && typeof raw.response === "object" && !Array.isArray(raw.response)
      ? raw.response
      : raw?.data && typeof raw.data === "object"
        ? raw.data
        : raw;

  const access_token =
    inner?.access_token ?? inner?.accessToken ?? raw?.access_token ?? raw?.accessToken ?? "";
  const refresh_token =
    inner?.refresh_token ?? inner?.refreshToken ?? raw?.refresh_token ?? raw?.refreshToken ?? "";
  const expire_in = Number(
    inner?.expire_in ?? inner?.expire_time ?? inner?.expires_in ?? raw?.expire_in ?? raw?.expire_time ?? 0,
  );

  const shop_id_list = inner?.shop_id_list ?? raw?.shop_id_list ?? inner?.shop_ids ?? [];
  const merchant_id_list = inner?.merchant_id_list ?? raw?.merchant_id_list ?? [];

  return {
    ...raw,
    access_token: access_token || undefined,
    refresh_token: refresh_token || undefined,
    expire_in: expire_in > 0 ? expire_in : undefined,
    shop_id_list: Array.isArray(shop_id_list) ? shop_id_list : [],
    merchant_id_list: Array.isArray(merchant_id_list) ? merchant_id_list : [],
    shop_id: inner?.shop_id ?? raw?.shop_id,
    error: raw?.error ?? inner?.error,
    message: raw?.message ?? inner?.message,
    _raw: raw,
  };
}

function buildShopeeTokenRecord(shopKey, authJson, oauthShopId, existing) {
  const key = normalizeShopIdKey(shopKey);
  const oauth = normalizeShopIdKey(oauthShopId) || key;
  // Nếu API trả shop_id_list (kể cả []) → thay thế, KHÔNG merge list cũ.
  // Merge stale khiến shop A bị clone token sang shop B → get_order_list invalid_access_token.
  const authHasShopList = Array.isArray(authJson?.shop_id_list);
  const fromAuthList = authHasShopList
    ? authJson.shop_id_list.map((x) => normalizeShopIdKey(x)).filter(Boolean)
    : [];
  const fromExistingList = Array.isArray(existing?.shop_id_list)
    ? existing.shop_id_list.map((x) => normalizeShopIdKey(x)).filter(Boolean)
    : [];
  const shopIdList = authHasShopList
    ? [...new Set([...fromAuthList, key].filter(Boolean))]
    : [...new Set([...fromExistingList, key].filter(Boolean))];

  const fromAuthMerchants = Array.isArray(authJson?.merchant_id_list)
    ? authJson.merchant_id_list.map((x) => String(x)).filter(Boolean)
    : [];
  const fromExistingMerchants = Array.isArray(existing?.merchant_id_list)
    ? existing.merchant_id_list.map((x) => String(x)).filter(Boolean)
    : [];
  const merchantIdList = [...new Set([...fromAuthMerchants, ...fromExistingMerchants])];

  return {
    shop_id: key,
    access_token: String(authJson?.access_token ?? existing?.access_token ?? ""),
    refresh_token: String(authJson?.refresh_token ?? existing?.refresh_token ?? ""),
    expire_in: Number(authJson?.expire_in ?? existing?.expire_in ?? 14400),
    obtained_at: Number(authJson?.obtained_at ?? Math.floor(Date.now() / 1000)),
    oauth_shop_id: existing?.oauth_shop_id || oauth,
    shop_id_list: shopIdList,
    merchant_id_list: merchantIdList,
  };
}

function saveShopeeTokenFromAuth(shopId, authJson, oauthShopId) {
  const key = normalizeShopIdKey(shopId);
  if (!key || !authJson?.access_token) return false;

  const new_token_data = buildShopeeTokenRecord(key, authJson, oauthShopId || key);
  console.log(
    "DEBUG SAVE: Saving data for shop:",
    key,
    "Full Data:",
    JSON.stringify(new_token_data),
  );

  const tokensData = normalizeTokenStore(loadShopeeTokens());
  tokensData[key] = new_token_data;
  return saveShopeeTokens(tokensData);
}

export function normalizeTokenStore(tokens) {
  const out = {};
  for (const [rawKey, record] of Object.entries(tokens || {})) {
    if (!record || typeof record !== "object") continue;
    const key = normalizeShopIdKey(record.shop_id ?? rawKey);
    if (!key || !record.access_token) continue;
    const oauthShopId = normalizeShopIdKey(record.oauth_shop_id) || key;
    out[key] = buildShopeeTokenRecord(key, record, oauthShopId, record);
  }
  return out;
}

export function getShopeeTokenRecord(tokens, shopId) {
  const key = normalizeShopIdKey(shopId);
  if (!key) return null;
  // Ưu tiên đúng key shop_id — tuyệt đối không lấy nhầm token shop khác khi đã có record riêng.
  if (tokens[key]?.access_token || tokens[key]?.refresh_token) return tokens[key];
  for (const [k, v] of Object.entries(tokens)) {
    if (normalizeShopIdKey(k) === key) return v;
  }
  // Fallback linked chỉ khi shop chưa có record riêng (main-account OAuth).
  for (const [k, v] of Object.entries(tokens)) {
    if (normalizeShopIdKey(k) === key) continue;
    const linked = Array.isArray(v?.shop_id_list) ? v.shop_id_list : [];
    if (linked.some((id) => normalizeShopIdKey(id) === key)) return v;
  }
  return null;
}

/**
 * Trạng thái kết nối token thật (không phụ thuộc shop.connected trong DB).
 * @returns {{ status: 'missing'|'expired'|'online', message: string, expires_at: number|null }}
 */
export function resolveShopeeTokenConnectionStatus(shopId) {
  const key = normalizeShopIdKey(shopId);
  if (!key) {
    return { status: "missing", message: "Thiếu Shop ID", expires_at: null };
  }
  const tokens = loadShopeeTokens();
  const record = getShopeeTokenRecord(tokens, key);
  if (!record?.access_token) {
    return {
      status: "missing",
      message: "Chưa kết nối OAuth — không có access_token",
      expires_at: null,
    };
  }
  const now = Math.floor(Date.now() / 1000);
  const obtainedAt = Number(record.obtained_at) || 0;
  const expireIn = Number(record.expire_in) || 0;
  const expiresAt = obtainedAt > 0 && expireIn > 0 ? obtainedAt + expireIn : null;
  if (expiresAt != null && now > expiresAt) {
    return {
      status: "expired",
      message: `Token hết hạn lúc ${new Date(expiresAt * 1000).toLocaleString("vi-VN")} — cần OAuth lại hoặc refresh`,
      expires_at: expiresAt,
    };
  }
  return {
    status: "online",
    message:
      expiresAt != null
        ? `Token hợp lệ đến ${new Date(expiresAt * 1000).toLocaleString("vi-VN")}`
        : "Token hợp lệ",
    expires_at: expiresAt,
  };
}

function collectShopIdsForTokenSave(requestShopId, authJson, expectedShopId) {
  const ids = new Set();
  const primary = normalizeShopIdKey(requestShopId);
  if (primary) ids.add(primary);

  const expected = normalizeShopIdKey(expectedShopId);
  if (expected) ids.add(expected);

  for (const raw of authJson?.shop_id_list || []) {
    const k = normalizeShopIdKey(raw);
    if (k) ids.add(k);
  }

  const fromBody = normalizeShopIdKey(authJson?.shop_id);
  if (fromBody) ids.add(fromBody);

  return [...ids];
}

function persistOAuthTokens(authJson, opts) {
  if (!authJson?.access_token) return [];

  const oauthShopId = normalizeShopIdKey(opts.oauthShopId);
  const mainAccountId = normalizeShopIdKey(opts.mainAccountId);
  const expected = normalizeShopIdKey(opts.expectedShopId);
  const shopIds = new Set(collectShopIdsForTokenSave(oauthShopId || mainAccountId, authJson, expected));

  if (mainAccountId && Array.isArray(authJson?.shop_id_list)) {
    for (const raw of authJson.shop_id_list) {
      const k = normalizeShopIdKey(raw);
      if (k) shopIds.add(k);
    }
  }

  const shopMismatch = Boolean(expected && oauthShopId && expected !== oauthShopId);
  if (shopMismatch && !shopIds.has(expected)) {
    console.warn(
      `[Shopee OAuth] Shop mismatch: expected=${expected}, oauth=${oauthShopId}, shop_id_list=[${(authJson?.shop_id_list || []).join(", ")}] — không lưu alias token sai shop.`,
    );
    shopIds.delete(expected);
  }

  if (shopIds.size === 0 && oauthShopId) shopIds.add(oauthShopId);

  const keysBeforeMerge = Object.keys(normalizeTokenStore(loadShopeeTokens()));
  const tokenOwner = oauthShopId || mainAccountId || "";
  const updates = {};

  for (const id of shopIds) {
    updates[id] = buildShopeeTokenRecord(id, authJson, tokenOwner || id, loadShopeeTokens()[id]);
    console.log("DEBUG SAVE: Saving data for shop:", id, "Full Data:", JSON.stringify(updates[id]));
  }

  saveShopeeTokens(updates);

  for (const id of shopIds) {
    console.log("Lưu token thành công cho shop: ", id);
  }

  const saved = [...shopIds];
  const tokensData = normalizeTokenStore(loadShopeeTokens());
  console.log(
    "[Shopee Tokens] persistOAuthTokens — SAU MERGE",
    JSON.stringify({
      oauthShopId,
      mainAccountId: mainAccountId || null,
      expectedShopId: expected || null,
      shopMismatch,
      keysBefore: keysBeforeMerge,
      keysAfter: Object.keys(tokensData),
      shopIdsSaved: saved,
      shopee_shop_id_list: authJson?.shop_id_list || [],
      tokensPath: SHOPEE_TOKENS_PATH,
    }),
  );
  return saved;
}

function verifyTokenSaved(shopId) {
  const key = normalizeShopIdKey(shopId);
  if (!key) return false;
  const tokens = loadShopeeTokens();
  return Boolean(getShopeeTokenRecord(tokens, key)?.access_token);
}

export async function completeShopeeOAuthFlow(code, params) {
  const oauthShopId = normalizeShopIdKey(params.shopIdRaw);
  const mainAccountId = normalizeShopIdKey(params.mainAccountIdRaw);
  const expected = normalizeShopIdKey(params.expectedShopId);

  if (!oauthShopId && !mainAccountId) {
    return {
      success: false,
      oauth_shop_id: "",
      saved_shop_ids: [],
      verified_in_file: false,
      error: "invalid_shop_id",
      message: `Thiếu shop_id hoặc main_account_id hợp lệ trong callback (shop_id=${params.shopIdRaw || ""}, main_account_id=${params.mainAccountIdRaw || ""})`,
    };
  }

  console.log(
    "[Shopee OAuth] completeShopeeOAuthFlow BẮT ĐẦU",
    JSON.stringify({
      oauthShopId: oauthShopId || null,
      mainAccountId: mainAccountId || null,
      expectedShopId: expected || null,
      shop_mismatch: expected && oauthShopId ? expected !== oauthShopId : false,
      code_preview: `${code.slice(0, 8)}…`,
      tokensPath: SHOPEE_TOKENS_PATH,
    }),
  );

  const tokenResult = await exchangeShopeeCodeForToken(code, {
    shopId: oauthShopId || undefined,
    mainAccountId: mainAccountId || undefined,
  });
  let savedIds = [];

  if (tokenResult.access_token) {
    savedIds = persistOAuthTokens(tokenResult, {
      oauthShopId: oauthShopId || undefined,
      mainAccountId: mainAccountId || undefined,
      expectedShopId: expected || undefined,
    });
    tokenResult.saved_shop_ids = savedIds;
    if (savedIds.length > 0) {
      deps.syncOAuthShopsToChannelSettings(savedIds, { expectedShopId: expected || undefined });
    }
  }

  const shopMismatch = Boolean(
    expected &&
      oauthShopId &&
      expected !== oauthShopId &&
      !savedIds.includes(expected),
  );
  const verified = expected
    ? savedIds.includes(expected) && verifyTokenSaved(expected)
    : oauthShopId
      ? verifyTokenSaved(oauthShopId)
      : savedIds.length > 0;

  saveOAuthAudit({
    callback_shop_id: oauthShopId || null,
    main_account_id: mainAccountId || null,
    expected_shop_id: expected || null,
    shop_mismatch: shopMismatch,
    callback_code_present: Boolean(code),
    success: Boolean(tokenResult.access_token) && verified && !shopMismatch,
    verified_in_file: verified,
    error: tokenResult.error || null,
    message: tokenResult.message || null,
    saved_shop_ids: savedIds,
    shopee_shop_id_list: tokenResult.shop_id_list || [],
    file_keys_after: Object.keys(loadShopeeTokens()),
    tokens_path: SHOPEE_TOKENS_PATH,
    app_root: APP_ROOT,
  });

  return {
    success: Boolean(tokenResult.access_token) && verified && !shopMismatch,
    oauth_shop_id: oauthShopId || savedIds[0] || "",
    expected_shop_id: expected || null,
    shop_mismatch: shopMismatch,
    saved_shop_ids: savedIds,
    verified_in_file: verified,
    error: tokenResult.error || (shopMismatch ? "shop_mismatch" : verified ? null : "token_not_persisted"),
    message: shopMismatch
      ? `Shopee trả về shop ${oauthShopId}, KHÔNG phải shop bạn yêu cầu ${expected}. Token KHÔNG thể dùng cho shop khác — hãy đăng xuất Shopee Seller Center, đăng nhập đúng shop ${expected}, rồi bấm OAuth lại.`
      : tokenResult.message ||
        (verified
          ? `OAuth thành công. Token đã lưu cho: [${savedIds.join(", ")}].`
          : "Token không ghi được vào shopee_tokens.json"),
    shopee_response: tokenResult.access_token
      ? { shop_id_list: tokenResult.shop_id_list || [], expire_in: tokenResult.expire_in }
      : tokenResult,
  };
}

export function buildShopeeAuthPartnerUrl(shopId) {
  const apiPath = "/api/v2/shop/auth_partner";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp);
  const sid = normalizeShopIdKey(shopId);
  const redirectTarget = sid
    ? `${SHOPEE_CALLBACK_URL}?redirect=1&expected_shop=${sid}`
    : `${SHOPEE_CALLBACK_URL}?redirect=1`;
  const redirect = encodeURIComponent(redirectTarget);
  let url = `${SHOPEE_HOST}${apiPath}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&sign=${sign}&redirect=${redirect}`;
  if (sid) url += `&shop_id=${sid}`;
  console.log(`[Shopee OAuth] auth_partner URL cho shop_id=${sid || "(none)"}: ${url.replace(/sign=[^&]+/, "sign=***")}`);
  return url;
}

export function saveShopeeTokenForShop(shopId, record) {
  const key = normalizeShopIdKey(shopId);
  if (!key) return;
  const tokens = normalizeTokenStore(loadShopeeTokens());
  const existing = tokens[key];
  tokens[key] = buildShopeeTokenRecord(
    key,
    { ...existing, ...record, obtained_at: record.obtained_at ?? Math.floor(Date.now() / 1000) },
    existing?.oauth_shop_id || key,
    existing,
  );
  saveShopeeTokens(tokens);
  if (tokens[key]?.access_token) {
    tokenCacheSet(key, tokens[key].access_token, tokens[key].expire_in);
  }
  console.log(`[Shopee Tokens] Saved token for shop_id=${key}. All shops: [${Object.keys(tokens).join(", ")}]`);
}

export function listShopeeOAuthShopIds() {
  return listShopeeSyncShopIds();
}

export function listShopeeSyncShopIds() {
  const ids = new Set();
  for (const [rawKey, record] of Object.entries(loadShopeeTokens())) {
    const key = normalizeShopIdKey(rawKey);
    if (key) ids.add(key);
    const recordShopId = normalizeShopIdKey(record?.shop_id);
    if (recordShopId) ids.add(recordShopId);
    for (const rawLinkedShopId of Array.isArray(record?.shop_id_list) ? record.shop_id_list : []) {
      const linkedShopId = normalizeShopIdKey(rawLinkedShopId);
      if (linkedShopId) ids.add(linkedShopId);
    }
  }
  return [...ids].sort();
}

export function ensureShopeeLinkedShopTokenKeys() {
  const tokens = normalizeTokenStore(loadShopeeTokens());
  const updates = {};
  let pruned = 0;

  for (const [rawKey, record] of Object.entries(tokens)) {
    if (!record?.access_token && !record?.refresh_token) continue;
    const owner = normalizeShopIdKey(rawKey) || normalizeShopIdKey(record?.shop_id);
    if (!owner) continue;

    const list = Array.isArray(record?.shop_id_list)
      ? record.shop_id_list.map((x) => normalizeShopIdKey(x)).filter(Boolean)
      : [];
    // Token 1 shop: ép shop_id_list = [owner], gỡ link giả.
    if (list.length <= 1) {
      if (list.length !== 1 || list[0] !== owner) {
        updates[owner] = {
          ...record,
          shop_id: owner,
          shop_id_list: [owner],
        };
        pruned += 1;
      }
      continue;
    }

    // Multi-shop (main account): chỉ materialize key nằm trong shop_id_list.
    const oauth = normalizeShopIdKey(record?.oauth_shop_id) || owner;
    for (const id of list) {
      const existing = tokens[id] || updates[id];
      if (existing?.access_token && existing?.refresh_token) {
        // Shop đã có token riêng khác refresh_token → không đè.
        if (
          id !== owner &&
          existing.refresh_token &&
          record.refresh_token &&
          String(existing.refresh_token) !== String(record.refresh_token)
        ) {
          continue;
        }
        const mergedList = [...new Set([...(existing.shop_id_list || []).map(normalizeShopIdKey), ...list].filter(Boolean))];
        if (mergedList.join(",") !== (existing.shop_id_list || []).map(normalizeShopIdKey).join(",")) {
          updates[id] = {
            ...existing,
            shop_id: id,
            oauth_shop_id: existing.oauth_shop_id || oauth,
            shop_id_list: mergedList,
          };
        }
        continue;
      }
      updates[id] = buildShopeeTokenRecord(
        id,
        {
          access_token: record.access_token,
          refresh_token: record.refresh_token,
          expire_in: record.expire_in,
          obtained_at: record.obtained_at,
          shop_id_list: list,
          merchant_id_list: record.merchant_id_list || [],
        },
        oauth || id,
        existing,
      );
    }
  }

  // Gỡ key clone giả: cùng refresh_token với shop khác nhưng không nằm trong shop_id_list của owner.
  for (const [rawKey, record] of Object.entries({ ...tokens, ...updates })) {
    const key = normalizeShopIdKey(rawKey);
    if (!key || !record) continue;
    const oauth = normalizeShopIdKey(record.oauth_shop_id);
    if (!oauth || oauth === key) continue;
    const ownerRec = updates[oauth] || tokens[oauth];
    if (!ownerRec) continue;
    const ownerList = Array.isArray(ownerRec.shop_id_list)
      ? ownerRec.shop_id_list.map(normalizeShopIdKey).filter(Boolean)
      : [oauth];
    const sameRefresh =
      record.refresh_token &&
      ownerRec.refresh_token &&
      String(record.refresh_token) === String(ownerRec.refresh_token);
    if (sameRefresh && !ownerList.includes(key)) {
      // Token clone giả — xóa khỏi store để sync không gọi get_order_list với token sai.
      console.error(
        `[Shopee Tokens] Gỡ shop clone giả shop_id=${key} (token thuộc ${oauth}, không có trong shop_id_list). Cần OAuth riêng shop ${key}.`,
      );
      delete updates[key];
      if (tokens[key]) {
        // Đánh dấu xóa bằng save sau
        updates[`__delete__${key}`] = true;
      }
      pruned += 1;
    }
  }

  const deleteKeys = Object.keys(updates).filter((k) => k.startsWith("__delete__"));
  for (const dk of deleteKeys) {
    delete updates[dk];
  }

  if (Object.keys(updates).length > 0 || deleteKeys.length > 0) {
    const next = normalizeTokenStore(loadShopeeTokens());
    for (const dk of deleteKeys) {
      const id = dk.replace(/^__delete__/, "");
      delete next[id];
    }
    Object.assign(next, updates);
    // saveShopeeTokens merges — cần ghi đè cả file khi xóa key.
    fs.writeFileSync(SHOPEE_TOKENS_PATH, JSON.stringify(next, null, 2), "utf8");
    console.log(
      `[Shopee Tokens] ensureLinkedShopTokenKeys — upsert=[${Object.keys(updates).join(", ")}]` +
        ` deleted=[${deleteKeys.map((k) => k.replace(/^__delete__/, "")).join(", ")}] pruned=${pruned}`,
    );
  }
  return listShopeeSyncShopIds();
}

export function propagateShopeeTokenToLinkedShops(sourceShopId, patch, opts) {
  const key = normalizeShopIdKey(sourceShopId);
  if (!key || !patch?.access_token) return;
  const tokens = normalizeTokenStore(loadShopeeTokens());
  const record = getShopeeTokenRecord(tokens, key) || tokens[key];
  if (!record) {
    saveShopeeTokenForShop(key, patch);
    tokenCacheSet(key, patch.access_token, patch.expire_in);
    return;
  }
  // Chỉ propagate tới shop nằm trong shop_id_list MỚI từ refresh/OAuth.
  // Không union với list cũ — tránh clone token shop A sang shop B.
  const fromPatch = Array.isArray(patch.shop_id_list)
    ? patch.shop_id_list.map((x) => normalizeShopIdKey(x)).filter(Boolean)
    : [];
  const linked = new Set(fromPatch.length ? fromPatch : [key]);
  linked.add(key);
  const oauth = normalizeShopIdKey(record.oauth_shop_id);
  const onlyMatchingRefresh = opts?.onlyMatchingRefreshToken
    ? String(opts.onlyMatchingRefreshToken)
    : "";
  const updates = {};
  for (const id of linked) {
    const existing = tokens[id] || (id === key ? record : null);
    // Chỉ ghi đè shop đang dùng cùng refresh_token cũ — tránh đè token độc lập của shop khác.
    if (
      onlyMatchingRefresh &&
      existing?.refresh_token &&
      String(existing.refresh_token) !== onlyMatchingRefresh &&
      id !== key
    ) {
      continue;
    }
    // Shop khác đã có refresh_token riêng (OAuth độc lập) — không ghi đè.
    if (
      id !== key &&
      existing?.refresh_token &&
      onlyMatchingRefresh &&
      String(existing.refresh_token) !== onlyMatchingRefresh
    ) {
      continue;
    }
    updates[id] = buildShopeeTokenRecord(
      id,
      {
        access_token: patch.access_token,
        refresh_token: patch.refresh_token,
        expire_in: patch.expire_in,
        obtained_at: patch.obtained_at,
        shop_id_list: [...linked],
      },
      normalizeShopIdKey(existing?.oauth_shop_id) || oauth || key,
      existing || record,
    );
    tokenCacheSet(id, patch.access_token, patch.expire_in);
  }
  saveShopeeTokens(updates);
  console.log(
    `[Shopee Tokens] propagate from=${key} → [${Object.keys(updates).join(", ")}] list=[${[...linked].join(",")}]`,
  );
}

export function shopeeSign(apiPath, timestamp, accessToken, shopId) {
  const baseString = accessToken && shopId
    ? `${SHOPEE_PARTNER_ID}${apiPath}${timestamp}${accessToken}${shopId}`
    : `${SHOPEE_PARTNER_ID}${apiPath}${timestamp}`;
  return crypto.createHmac("sha256", SHOPEE_PARTNER_KEY).update(baseString).digest("hex");
}

async function exchangeShopeeCodeForToken(code, opts) {
  const shopId = normalizeShopIdKey(opts.shopId);
  const mainAccountId = normalizeShopIdKey(opts.mainAccountId);

  if (!isShopeeConfigValid()) {
    const error = {
      error: "invalid_partner_config",
      message: `SHOPEE_PARTNER_ID/"${SHOPEE_PARTNER_ID}" ho\u1EB7c SHOPEE_PARTNER_KEY trong .env ch\u01B0a ph\u1EA3i gi\xE1 tr\u1ECB Live th\u1EF1c. Vui l\xF2ng \u0111i\u1EC1n \u0111\xFAng Partner ID (s\u1ED1 nguy\xEAn) v\xE0 Partner Key t\u1EEB App PRODUCTION tr\xEAn open.shopee.com r\u1ED3i th\u1EED l\u1EA1i.`,
    };
    console.error(`[Shopee OAuth] \u274C Kh\xF4ng th\u1EC3 \u0111\u1ED5i code: ${error.message}`);
    return error;
  }

  if (!shopId && !mainAccountId) {
    return {
      error: "missing_shop_or_main_account",
      message: "Shopee token/get cần shop_id HOẶC main_account_id (không được thiếu cả hai).",
    };
  }

  const apiPath = "/api/v2/auth/token/get";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp);
  const url = `${SHOPEE_HOST}${apiPath}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&sign=${sign}`;

  const body = {
    code,
    partner_id: Number(SHOPEE_PARTNER_ID),
  };
  if (mainAccountId) {
    body.main_account_id = Number(mainAccountId);
  } else if (shopId) {
    body.shop_id = Number(shopId);
  }

  console.log(
    "[Shopee OAuth] token/get request",
    JSON.stringify({
      shop_id: shopId || null,
      main_account_id: mainAccountId || null,
      partner_id: SHOPEE_PARTNER_ID,
      url_host: SHOPEE_HOST,
    }),
  );

  let res;
  let rawText;
  try {
    res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    rawText = await res.text();
  } catch (error) {
    deps.logOAuthSaveError("exchangeShopeeCodeForToken fetch", error);
    return {
      error: "network_error",
      message: error?.message || "Không gọi được Shopee token/get",
    };
  }
  console.log("DEBUG RAW RESPONSE:", rawText);

  let json;
  try {
    json = rawText ? parseShopeeJson(rawText) : {};
  } catch (parseErr) {
    console.error("[Shopee OAuth] Không parse được JSON từ Shopee:", parseErr);
    return { error: "invalid_json", message: rawText.slice(0, 500) };
  }

  json = normalizeShopeeTokenResponse(json);
  console.log("DEBUG NORMALIZED RESPONSE:", JSON.stringify(json));
  console.log(`[Shopee API] POST ${apiPath} (env=${SHOPEE_ENV}) -> HTTP ${res.status}`);

  if (json.access_token && json.refresh_token) {
    console.log(
      "[Shopee OAuth] ĐÃ LẤY TOKEN TỪ SHOPEE",
      JSON.stringify({
        shop_id: shopId || null,
        main_account_id: mainAccountId || null,
        access_token: `${String(json.access_token).slice(0, 16)}…`,
        refresh_token: `${String(json.refresh_token).slice(0, 16)}…`,
        expire_in: json.expire_in,
        shop_id_list: json.shop_id_list || [],
      }),
    );
  } else {
    console.error(
      "[Shopee OAuth] SHOPEE KHÔNG TRẢ đủ access_token/refresh_token",
      JSON.stringify({
        shop_id: shopId || null,
        main_account_id: mainAccountId || null,
        httpStatus: res.status,
        error: json.error || null,
        message: json.message || null,
        keys: Object.keys(json),
      }),
    );
  }
  return json;
}

/**
 * Refresh token cho ĐÚNG shop_id truyền vào — lưu DB map theo shop_id, không dùng biến global.
 */
async function refreshShopeeToken(shopId, refreshToken) {
  const key = normalizeShopIdKey(shopId);
  if (!key || !refreshToken) {
    return { error: "invalid_refresh_params", message: `Thiếu shop_id hoặc refresh_token (shop_id=${shopId})` };
  }

  const apiPath = "/api/v2/auth/access_token/get";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp);
  const url = `${SHOPEE_HOST}${apiPath}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&sign=${sign}`;

  try {
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        refresh_token: String(refreshToken),
        shop_id: Number(key),
        partner_id: Number(SHOPEE_PARTNER_ID),
      }),
    });
    const rawText = await res.text();
    const json = rawText ? parseShopeeJson(rawText) : {};
    console.log(
      `[Shopee API] POST ${apiPath} (refresh shop_id=${key}) -> HTTP ${res.status}:`,
      JSON.stringify(json),
    );

    const normalized = normalizeShopeeTokenResponse(json);
    if (normalized.access_token) {
      // shop_id_list từ API: [] hoặc thiếu = token 1 shop → chỉ [key], không giữ list cũ.
      const apiList = Array.isArray(normalized.shop_id_list)
        ? normalized.shop_id_list
        : Array.isArray(json?.shop_id_list)
          ? json.shop_id_list
          : [];
      const shopIdListForSave = apiList.length
        ? apiList.map((x) => normalizeShopIdKey(x)).filter(Boolean)
        : [key];
      // Chỉ UPSERT đúng key shop_id đang refresh — không ghi nhầm sang shop khác.
      saveShopeeTokenForShop(key, {
        access_token: normalized.access_token,
        refresh_token: normalized.refresh_token || refreshToken,
        expire_in: normalized.expire_in,
        obtained_at: Math.floor(Date.now() / 1000),
        shop_id_list: shopIdListForSave,
      });
      tokenCacheSet(key, normalized.access_token, normalized.expire_in);
      return {
        ...normalized,
        shop_id: key,
        shop_id_list: shopIdListForSave,
      };
    }
    console.error(
      `[Shopee API] Refresh token thất bại shop_id=${key}:`,
      normalized.error || json.error,
      normalized.message || json.message,
    );
    return { ...normalized, shop_id: key };
  } catch (error) {
    deps.logOAuthSaveError(`refreshShopeeToken shop_id=${key}`, error);
    return { error: "refresh_failed", message: error?.message || String(error), shop_id: key };
  }
}

export class ShopeeRefreshTokenExpiredError extends Error {
  constructor(shopId) {
    super(SHOPEE_REAUTH_REQUIRED_MESSAGE);
    this.name = "ShopeeRefreshTokenExpiredError";
    this.shopId = shopId;
    this.code = "shopee_reauth_required";
  }
}

export function isShopeeInvalidTokenError(error, message) {
  const text = `${error || ""} ${message || ""}`.toLowerCase();
  return /invalid_acceess_token|invalid_access_token|error_auth|invalid_token|access_token.*expire|token.*expire|token.*invalid|unauthorized|hết hạn|không hợp lệ/.test(
    text,
  );
}

function isShopeeRefreshPermanentlyFailed(error, message) {
  const text = `${error || ""} ${message || ""}`.toLowerCase();
  return /invalid_refresh_token|refresh_token.*expire|refresh.*invalid|error_auth|invalid_token|error_param/.test(
    text,
  );
}

/**
 * Mutex refresh theo "chủ token" (oauth_shop_id / fingerprint refresh_token).
 * Tránh 2 shop dùng chung refresh_token refresh song song → 1 shop invalid_refresh_token → Offline.
 */
const shopeeTokenRefreshLocks = new Map();

/** Cache access_token trên RAM — key = shop_id (không dùng biến global đơn). */
const shopeeAccessTokenCache = new Map();

function tokenCacheGet(shopId) {
  const key = normalizeShopIdKey(shopId);
  if (!key) return null;
  const entry = shopeeAccessTokenCache.get(key);
  if (!entry?.token) return null;
  if (Math.floor(Date.now() / 1000) >= Number(entry.expiresAt || 0)) {
    shopeeAccessTokenCache.delete(key);
    return null;
  }
  return String(entry.token);
}

function tokenCacheSet(shopId, token, expireIn) {
  const key = normalizeShopIdKey(shopId);
  if (!key || !token) return;
  const ttl = Math.max(60, Number(expireIn) || 14400) - 60;
  shopeeAccessTokenCache.set(key, {
    token: String(token),
    expiresAt: Math.floor(Date.now() / 1000) + ttl,
  });
}

function tokenCacheClear(shopId) {
  const key = normalizeShopIdKey(shopId);
  if (key) {
    shopeeAccessTokenCache.delete(key);
    shopeeShopTokenVerifyCache.delete(key);
  }
}

/** Cache kết quả get_shop_info — tránh spam verify mỗi đơn, TTL 10 phút. */
const shopeeShopTokenVerifyCache = new Map();

function shopTokenVerifyCacheOk(shopId, token) {
  const key = normalizeShopIdKey(shopId);
  if (!key || !token) return false;
  const entry = shopeeShopTokenVerifyCache.get(key);
  if (!entry?.tokenTail) return false;
  if (Math.floor(Date.now() / 1000) >= Number(entry.expiresAt || 0)) {
    shopeeShopTokenVerifyCache.delete(key);
    return false;
  }
  return entry.tokenTail === String(token).slice(-8);
}

function shopTokenVerifyCacheSet(shopId, token) {
  const key = normalizeShopIdKey(shopId);
  if (!key || !token) return;
  shopeeShopTokenVerifyCache.set(key, {
    tokenTail: String(token).slice(-8),
    expiresAt: Math.floor(Date.now() / 1000) + 10 * 60,
  });
}

function resolveRefreshLockKey(shopId, record) {
  const key = normalizeShopIdKey(shopId);
  const oauth = normalizeShopIdKey(record?.oauth_shop_id);
  if (oauth) return `oauth:${oauth}`;
  const rt = record?.refresh_token ? String(record.refresh_token) : "";
  if (rt) return `rt:${rt.slice(0, 32)}`;
  return `shop:${key}`;
}

function readShopeeAccessTokenIfFresh(shopId) {
  const key = normalizeShopIdKey(shopId);
  const cached = tokenCacheGet(key);
  if (cached) return cached;

  const tokens = loadShopeeTokens();
  const record = getShopeeTokenRecord(tokens, key);
  if (!record?.access_token) return null;
  const now = Math.floor(Date.now() / 1000);
  const obtainedAt = Number(record.obtained_at) || 0;
  const expireIn = Number(record.expire_in) || 14400;
  if (obtainedAt > 0 && now - obtainedAt >= expireIn - 60) return null;
  tokenCacheSet(key, record.access_token, expireIn - (now - obtainedAt));
  return String(record.access_token);
}

export async function refreshShopeeAccessTokenLocked(shopId, opts) {
  const key = normalizeShopIdKey(shopId);
  if (!key) throw new ShopeeRefreshTokenExpiredError(String(shopId || "?"));

  const tokensPeek = loadShopeeTokens();
  const recordPeek = getShopeeTokenRecord(tokensPeek, key);
  const lockKey = resolveRefreshLockKey(key, recordPeek);

  const inflight = shopeeTokenRefreshLocks.get(lockKey);
  if (inflight) {
    console.log(`[Shopee Token] Mutex: chờ refresh lock=${lockKey} (shop_id=${key})`);
    await inflight;
    const afterWait = readShopeeAccessTokenIfFresh(key);
    if (afterWait) return afterWait;
    // Sibling refresh xong nhưng shop này chưa có token fresh — đọc lại từ DB.
    const tokensAfter = loadShopeeTokens();
    const recAfter = getShopeeTokenRecord(tokensAfter, key);
    if (recAfter?.access_token) {
      tokenCacheSet(key, recAfter.access_token, recAfter.expire_in);
      return String(recAfter.access_token);
    }
    throw new ShopeeRefreshTokenExpiredError(key);
  }

  const run = (async () => {
    const tokens = loadShopeeTokens();
    const record = getShopeeTokenRecord(tokens, key);
    if (!record) {
      throw new ShopeeRefreshTokenExpiredError(key);
    }
    if (!record.refresh_token) {
      throw new ShopeeRefreshTokenExpiredError(key);
    }

    if (!opts?.force) {
      const fresh = readShopeeAccessTokenIfFresh(key);
      if (fresh) return fresh;
    } else {
      const now = Math.floor(Date.now() / 1000);
      const obtainedAt = Number(record.obtained_at) || 0;
      if (obtainedAt > 0 && now - obtainedAt < 15 && record.access_token) {
        console.log(`[Shopee Token] Bỏ qua force refresh — token vừa mới (${now - obtainedAt}s) shop_id=${key}`);
        tokenCacheSet(key, record.access_token, record.expire_in);
        return String(record.access_token);
      }
    }

    const oldRefresh = String(record.refresh_token);
    // Ưu tiên refresh ĐÚNG shop_id đang yêu cầu. Chỉ dùng oauth_shop_id khi
    // refresh shop thất bại VÀ shop nằm trong shop_id_list thật (main-account).
    const oauthOwner = normalizeShopIdKey(record.oauth_shop_id);
    console.log(
      `[Shopee Token] Refresh access_token shop_id=${key}` +
        ` force=${Boolean(opts?.force)} lock=${lockKey}...`,
    );
    let refreshed = await refreshShopeeToken(key, oldRefresh);
    let refreshVia = key;

    if (
      !refreshed.access_token &&
      oauthOwner &&
      oauthOwner !== key
    ) {
      console.warn(
        `[Shopee Token] Refresh shop_id=${key} fail — retry oauth_shop_id=${oauthOwner}`,
      );
      refreshed = await refreshShopeeToken(oauthOwner, oldRefresh);
      refreshVia = oauthOwner;
    }

    if (refreshed.access_token) {
      // Token lấy qua shop khác → bắt buộc verify get_shop_info cho shop đang cần.
      if (refreshVia !== key) {
        const verified = await verifyShopeeShopToken(key, refreshed.access_token);
        if (!verified.ok) {
          console.error(
            `[Shopee Token] Token từ shop=${refreshVia} KHÔNG dùng được cho shop_id=${key}` +
              ` (error=${verified.error}). Cần OAuth riêng shop ${key}.`,
          );
          tokenCacheClear(key);
          throw new ShopeeRefreshTokenExpiredError(key);
        }
      }

      const obtainedAt = Math.floor(Date.now() / 1000);
      const apiList = Array.isArray(refreshed.shop_id_list)
        ? refreshed.shop_id_list.map((x) => normalizeShopIdKey(x)).filter(Boolean)
        : [];
      // Chỉ propagate sang shop trong list API trả về (main-account). Token 1 shop = [refreshVia].
      const propagateList = apiList.length ? apiList : [refreshVia];
      if (!propagateList.includes(key) && refreshVia === key) {
        // ok — single shop
      } else if (!propagateList.includes(key) && refreshVia !== key) {
        // Đã verify ở trên — vẫn lưu cho key này nhưng không clone lung tung.
        propagateList.push(key);
      }

      propagateShopeeTokenToLinkedShops(
        refreshVia,
        {
          access_token: refreshed.access_token,
          refresh_token: refreshed.refresh_token || oldRefresh,
          expire_in: refreshed.expire_in,
          obtained_at: obtainedAt,
          shop_id_list: propagateList,
        },
        { onlyMatchingRefreshToken: oldRefresh },
      );
      tokenCacheSet(key, refreshed.access_token, refreshed.expire_in);
      if (refreshVia !== key) {
        tokenCacheSet(refreshVia, refreshed.access_token, refreshed.expire_in);
      }
      console.log(
        `[Shopee Token] Refresh OK shop_id=${key} via=${refreshVia}` +
          ` list=[${propagateList.join(",")}]`,
      );
      return String(refreshed.access_token);
    }

    tokenCacheClear(key);
    console.error(
      `[Shopee Token] Refresh THẤT BẠI shop_id=${key}:`,
      refreshed.error || refreshed.message,
    );
    throw new ShopeeRefreshTokenExpiredError(key);
  })().finally(() => {
    shopeeTokenRefreshLocks.delete(lockKey);
  });

  shopeeTokenRefreshLocks.set(lockKey, run);
  return run;
}

export async function getShopeeAccessTokenForApi(shopKey, opts) {
  const fileKey = normalizeShopIdKey(shopKey);
  if (!fileKey) return null;

  const tokens = loadShopeeTokens();
  const record = getShopeeTokenRecord(tokens, fileKey);
  if (!record?.refresh_token && !record?.access_token) return null;

  // apiShopId = đúng shop đang gọi — không remap sang oauth parent.
  const apiShopId = fileKey;

  try {
    if (opts?.forceRefresh) {
      const token = await refreshShopeeAccessTokenLocked(fileKey, { force: true });
      return { token, apiShopId, fileKey };
    }
    const token = await getValidShopeeAccessToken(fileKey);
    if (!token) return null;
    return { token, apiShopId, fileKey };
  } catch (err) {
    if (err instanceof ShopeeRefreshTokenExpiredError) {
      console.error(`[Shopee Token] ${err.message} shop_id=${err.shopId}`);
      return null;
    }
    throw err;
  }
}

export async function verifyShopeeShopToken(shopId, accessToken) {
  const key = normalizeShopIdKey(shopId);
  if (!key || !accessToken) return { ok: false, error: "missing_shop_or_token" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const apiPath = "/api/v2/shop/get_shop_info";
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = shopeeSign(apiPath, timestamp, accessToken, key);
    const url = `${SHOPEE_HOST}${apiPath}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&access_token=${accessToken}&shop_id=${key}&sign=${sign}`;
    const res = await fetch(url, { signal: controller.signal });
    const rawText = await res.text();
    const json = rawText ? parseShopeeJson(rawText) : {};
    const err = String(json?.error || "").trim();
    if (err) return { ok: false, error: err };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * shop_id dùng khi gọi Shopee OpenAPI.
 * ĐA SHOP: LUÔN dùng đúng shop đang yêu cầu — CẤM đổi sang oauth_shop_id parent
 * (bug cũ: đơn AuDIO bị ghi shopId=LKAT và ngược lại).
 */
export function resolveShopeeApiShopId(record, configuredShopId) {
  const configured = normalizeShopIdKey(configuredShopId);
  if (configured) return configured;
  const recordKey = normalizeShopIdKey(record?.shop_id);
  if (recordKey) return recordKey;
  return normalizeShopIdKey(record?.oauth_shop_id) || "";
}

/**
 * Lấy access_token hợp lệ CHO ĐÚNG shop_id (đa shop — không đoán shop).
 * Nếu access_token hết hạn (~4h) → refresh bằng refresh_token → cập nhật DB → trả token mới.
 * oauth_shop_id !== shopId (hoặc record thuộc shop khác) → BẮT BUỘC verify get_shop_info.
 * Fail → clear cache, return null — CẤM trả token shop 1 cho shop 2.
 */
export async function getValidShopeeAccessToken(shopId) {
  const key = normalizeShopIdKey(shopId);
  if (!key) {
    console.error(
      "[Shopee API] getValidShopeeAccessToken: THIẾU shop_id — từ chối gọi (hệ thống đa shop bắt buộc truyền shop_id).",
    );
    return null;
  }

  const tokens = loadShopeeTokens();
  const record = getShopeeTokenRecord(tokens, key);
  if (!record) {
    const available = listAuthorizedShopeeShopIds();
    console.warn(
      `[Shopee API] Chưa có token record cho shop_id=${key}. Shop đã ủy quyền: [${available.join(", ") || "không có"}]`,
    );
    return null;
  }

  const oauth = normalizeShopIdKey(record.oauth_shop_id);
  const recordOwner = normalizeShopIdKey(record.shop_id);
  const needsVerify = Boolean((oauth && oauth !== key) || (recordOwner && recordOwner !== key));
  const cacheHit = Boolean(tokenCacheGet(key));

  const rejectForeignToken = (reason) => {
    console.error(
      `[Shopee API] shop_id=${key} token không thuộc shop này (oauth=${oauth || "-"} owner=${recordOwner || "-"} error=${reason}).` +
        ` Cần OAuth riêng shop ${key} — không dùng token shop khác.`,
    );
    console.log(`[Shopee API] shop_id=${key} oauth=${oauth || "-"} cache=${cacheHit ? "hit" : "miss"} verified=no`);
    tokenCacheClear(key);
    return null;
  };

  const fresh = readShopeeAccessTokenIfFresh(key);
  if (fresh) {
    if (needsVerify) {
      if (shopTokenVerifyCacheOk(key, fresh)) {
        console.log(`[Shopee API] shop_id=${key} oauth=${oauth || "-"} cache=${cacheHit ? "hit" : "miss"} verified=yes`);
        return fresh;
      }
      const verified = await verifyShopeeShopToken(key, fresh);
      if (!verified.ok) return rejectForeignToken(verified.error);
      shopTokenVerifyCacheSet(key, fresh);
      console.log(`[Shopee API] shop_id=${key} oauth=${oauth || "-"} cache=${cacheHit ? "hit" : "miss"} verified=yes`);
      return fresh;
    }
    console.log(`[Shopee API] shop_id=${key} oauth=${oauth || "-"} cache=${cacheHit ? "hit" : "miss"} verified=n/a`);
    return fresh;
  }

  if (!record.refresh_token) {
    console.error(`[Shopee API] Shop ${key} thiếu refresh_token — cần OAuth lại.`);
    console.log(`[Shopee API] shop_id=${key} oauth=${oauth || "-"} cache=miss verified=no`);
    return null;
  }

  try {
    console.log(
      `[Shopee API] access_token shop_id=${key} HẾT HẠN (expired) — gọi Refresh Token → lưu DB...`,
    );
    const refreshed = await refreshShopeeAccessTokenLocked(key, { force: false });
    if (!refreshed) {
      console.log(`[Shopee API] shop_id=${key} oauth=${oauth || "-"} cache=miss verified=no`);
      return null;
    }
    if (needsVerify) {
      const verified = await verifyShopeeShopToken(key, refreshed);
      if (!verified.ok) return rejectForeignToken(verified.error);
      shopTokenVerifyCacheSet(key, refreshed);
      console.log(`[Shopee API] shop_id=${key} oauth=${oauth || "-"} cache=miss verified=yes`);
      return refreshed;
    }
    console.log(`[Shopee API] shop_id=${key} oauth=${oauth || "-"} cache=miss verified=n/a`);
    return refreshed;
  } catch (err) {
    if (err instanceof ShopeeRefreshTokenExpiredError) {
      console.error(`[Shopee API] ${err.message}`);
      console.log(`[Shopee API] shop_id=${key} oauth=${oauth || "-"} cache=miss verified=no`);
      return null;
    }
    console.error(`[Shopee API] Refresh token thất bại shop_id=${key}:`, err);
    console.log(`[Shopee API] shop_id=${key} oauth=${oauth || "-"} cache=miss verified=no`);
    return null;
  }
}

export async function withShopeeAccessTokenRetry(shopId, runner, isAuthFailure) {
  const key = normalizeShopIdKey(shopId);
  let token = await getValidShopeeAccessToken(key);
  if (!token) {
    throw new ShopeeRefreshTokenExpiredError(key || String(shopId || "?"));
  }

  let result = await runner(token);
  const failed =
    (isAuthFailure && isAuthFailure(result)) ||
    (result &&
      typeof result === "object" &&
      (Number(result.httpStatus) === 401 ||
        Number(result.httpStatus) === 403 ||
        isShopeeInvalidTokenError(result.error, result.message)));

  if (!failed) return result;

  // Không đánh Offline ngay — force refresh đúng shop_id rồi retry API 1 lần.
  console.warn(`[Shopee Token] API báo token hết hạn shop_id=${key} — force refresh + retry 1 lần`);
  tokenCacheClear(key);
  token = await refreshShopeeAccessTokenLocked(key, { force: true });
  return runner(token);
}

/**
 * Danh sách shop_id ĐÃ ủy quyền (có access_token hoặc refresh_token) trong Token Store.
 * Dùng cho môi trường ĐA SHOP — không đoán shop mặc định.
 */
export function listAuthorizedShopeeShopIds() {
  const tokens = loadShopeeTokens();
  const ids = new Set();
  for (const [rawKey, record] of Object.entries(tokens || {})) {
    if (!record?.access_token && !record?.refresh_token) continue;
    const key = normalizeShopIdKey(rawKey) || normalizeShopIdKey(record?.shop_id);
    if (key) ids.add(key);
  }
  return [...ids].sort();
}

/**
 * Resolve 1 shop_id cụ thể từ request.
 * - Có `requested` → tìm đúng shop đó (không fallback sang shop khác).
 * - Không có `requested` + đúng 1 shop trong DB → trả shop đó (legacy single-shop).
 * - Không có `requested` + đa shop → trả null (caller phải dùng listAuthorizedShopeeShopIds / resolveShopeeShopIdsForSync).
 */
export function resolveShopeeTokenShopId(requested) {
  const authorized = listAuthorizedShopeeShopIds();
  if (!authorized.length) {
    console.warn(
      "[Shopee Auth] resolveShopeeTokenShopId: DB không có shop nào được ủy quyền (shopee_tokens trống).",
    );
    return null;
  }

  const req = String(requested || "").trim();
  if (!req) {
    if (authorized.length === 1) return authorized[0];
    console.warn(
      `[Shopee Auth] resolveShopeeTokenShopId: ĐA SHOP (${authorized.length} shop: [${authorized.join(", ")}]) — thiếu shop_id. Tạm fallback về ${authorized[0]} để tránh crash.`,
    );
    return authorized[0];
  }

  const tokens = loadShopeeTokens();
  if (tokens[req]) return req;
  const digits = normalizeShopIdKey(req) || req.match(/(\d{5,})/)?.[1] || "";
  if (digits && tokens[digits]) return digits;
  if (digits) {
    const linked = getShopeeTokenRecord(tokens, digits);
    if (linked) {
      console.log(
        `[Shopee Auth] resolveShopeeTokenShopId: shop_id=${digits} tìm thấy qua linked/oauth record.`,
      );
      return digits;
    }
    console.warn(
      `[Shopee Auth] resolveShopeeTokenShopId: yêu cầu shop_id=${digits} nhưng không có token. Shops: [${authorized.join(", ")}]`,
    );
    return digits;
  }
  return null;
}

/**
 * Danh sách shop cần xử lý cho sync / thao tác đa shop.
 * - Có shop_id → [shop đó]
 * - Không có → toàn bộ shop đã ủy quyền
 */
export function resolveShopeeShopIdsForSync(requested) {
  const req = String(requested || "").trim();
  if (req) {
    const one = resolveShopeeTokenShopId(req);
    return one ? [one] : [];
  }
  const all = listAuthorizedShopeeShopIds();
  console.log(
    `[Shopee Auth] resolveShopeeShopIdsForSync: không truyền shop_id — dùng TẤT CẢ ${all.length} shop: [${all.join(", ")}]`,
  );
  return all;
}

/**
 * Lấy access_token ĐÚNG theo shop_id.
 * BẮT BUỘC truyền shop_id. Token hết hạn (~4h) → refresh → lưu DB → trả token mới.
 */
export async function getAccessTokenForShop(shopId) {
  const key = normalizeShopIdKey(shopId);
  if (!key) {
    console.error("[Shopee Auth] getAccessTokenForShop: THIẾU shop_id — từ chối (môi trường đa shop).");
    return null;
  }
  return getValidShopeeAccessToken(key);
}

/** Thông báo rõ khi DB trống / thiếu ủy quyền — hướng user vào Cài đặt. */
export function getShopeeUnauthorizedShopMessage() {
  const keys = listAuthorizedShopeeShopIds();
  if (!keys.length) {
    return "Chưa có shop Shopee được ủy quyền trong hệ thống. Vào mục Cài đặt → Ủy quyền lại Shop Shopee rồi thử đồng bộ lại.";
  }
  return `Hệ thống có ${keys.length} shop Shopee đã ủy quyền ([${keys.join(", ")}]) nhưng thiếu shop_id cụ thể hoặc token shop yêu cầu không hợp lệ. Vào mục Cài đặt kiểm tra ủy quyền.`;
}

export function describeShopeeTokenFailure(shopKey) {
  const tokens = loadShopeeTokens();
  const key = normalizeShopIdKey(shopKey);
  const record = getShopeeTokenRecord(tokens, key);
  if (!record) {
    return {
      error: "shopee_reauth_required",
      message: SHOPEE_REAUTH_REQUIRED_MESSAGE,
    };
  }
  if (!record.refresh_token) {
    return {
      error: "shopee_reauth_required",
      message: SHOPEE_REAUTH_REQUIRED_MESSAGE,
    };
  }
  const now = Math.floor(Date.now() / 1000);
  const obtainedAt = Number(record.obtained_at) || 0;
  const expireIn = Number(record.expire_in) || 14400;
  const isExpired = obtainedAt > 0 && now - obtainedAt >= expireIn - 60;
  if (isExpired) {
    return {
      error: "shopee_reauth_required",
      message: SHOPEE_REAUTH_REQUIRED_MESSAGE,
    };
  }
  return {
    error: "shopee_reauth_required",
    message: SHOPEE_REAUTH_REQUIRED_MESSAGE,
  };
}
