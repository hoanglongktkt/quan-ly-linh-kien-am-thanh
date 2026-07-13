var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// server.ts
var import_express = __toESM(require("express"), 1);
var import_path = __toESM(require("path"), 1);
var import_fs = __toESM(require("fs"), 1);
var import_crypto = __toESM(require("crypto"), 1);
var import_pdf_lib = require("pdf-lib");
var import_genai = require("@google/genai");
var import_dotenv = __toESM(require("dotenv"), 1);
var import_jsonwebtoken = __toESM(require("jsonwebtoken"), 1);

// src/utils/orderItemVariation.ts
function normalizeModelId(raw) {
  const v = String(raw ?? "").trim();
  if (!v || v === "0") return "0";
  return v;
}
function normalizeImageKey(url) {
  if (!url) return "";
  const cleaned = url.replace(/[?#].*$/, "").replace(/_tn(\.\w+)?$/i, "");
  const file = cleaned.split("/").pop() || cleaned;
  return file.trim();
}
function findCatalogVariants(catalogProducts, itemId) {
  return catalogProducts.filter(
    (p) => p.shopeeItemId === itemId || p.id === itemId || p.shopeeId && String(p.shopeeId).startsWith(`${itemId}:`)
  );
}
function priceMatches(catalogPrice, orderPrice) {
  if (!catalogPrice || !orderPrice) return false;
  const diff = Math.abs(catalogPrice - orderPrice);
  return diff <= Math.max(500, orderPrice * 0.1);
}
function stripModelSuffix(title, modelName) {
  if (!modelName) return title;
  const suffix = ` - ${modelName}`;
  if (title.endsWith(suffix)) return title.slice(0, -suffix.length).trim() || title;
  return title;
}
function parseModelNameFromTitle(title) {
  if (!title.includes(" - ")) return { baseTitle: title };
  const idx = title.lastIndexOf(" - ");
  const maybeModel = title.slice(idx + 3).trim();
  const maybeBase = title.slice(0, idx).trim();
  if (maybeModel && maybeBase) return { baseTitle: maybeBase, modelName: maybeModel };
  return { baseTitle: title };
}
function matchVariantsByName(variants, modelName) {
  const lower = modelName.toLowerCase();
  return variants.filter(
    (p) => p.modelName?.toLowerCase() === lower || p.title.toLowerCase().endsWith(` - ${lower}`)
  );
}
function matchVariantsByPrice(variants, orderPrice) {
  if (!orderPrice || variants.length === 0) return [];
  return variants.filter(
    (p) => p.shopeeModelId && priceMatches(Number(p.sellingPrice) || 0, orderPrice)
  );
}
function matchVariantByImage(variants, orderImage) {
  const orderKey = normalizeImageKey(orderImage);
  if (!orderKey) return void 0;
  const matches = variants.filter((v) => {
    const variantKey = normalizeImageKey(v.avatarUrl || v.imageUrl);
    if (!variantKey) return false;
    if (orderKey === variantKey) return true;
    const orderStem = orderKey.split("-")[0] || orderKey;
    const variantStem = variantKey.split("-")[0] || variantKey;
    return orderStem.length >= 4 && variantStem.length >= 4 && orderStem === variantStem;
  });
  return matches.length === 1 ? matches[0] : void 0;
}
function enrichOrderItemFromCatalog(item, catalogProducts = []) {
  const itemId = String(item.productId || "").trim();
  let modelId = normalizeModelId(item.modelId);
  let modelSku = item.modelSku?.trim();
  let modelName = item.modelName?.trim();
  let productTitle = item.productTitle?.trim() || "S\u1EA3n ph\u1EA9m kh\xF4ng t\xEAn";
  const orderPrice = Number(item.price) || 0;
  const parsed = parseModelNameFromTitle(productTitle);
  if (!modelName && parsed.modelName) {
    modelName = parsed.modelName;
    productTitle = parsed.baseTitle;
  } else {
    productTitle = stripModelSuffix(productTitle, modelName);
  }
  const variants = itemId ? findCatalogVariants(catalogProducts, itemId) : [];
  let matched;
  if (modelId !== "0") {
    matched = variants.find((p) => p.shopeeModelId === modelId);
  }
  if (!matched && modelName) {
    const byName = matchVariantsByName(variants, modelName);
    if (byName.length === 1) matched = byName[0];
  }
  if (!matched && orderPrice > 0) {
    const byPrice = matchVariantsByPrice(variants, orderPrice);
    if (byPrice.length === 1) matched = byPrice[0];
  }
  if (!matched) {
    matched = matchVariantByImage(variants, item.productImage);
  }
  if (matched) {
    modelId = normalizeModelId(matched.shopeeModelId);
    modelSku = modelSku || matched.sku?.trim();
    modelName = modelName || matched.modelName?.trim();
    productTitle = stripModelSuffix(matched.title, matched.modelName) || productTitle;
  }
  const enriched = {
    ...item,
    productTitle: modelName ? `${productTitle} - ${modelName}` : productTitle,
    modelId: modelId !== "0" ? modelId : item.modelId,
    modelSku: modelSku || item.modelSku,
    modelName: modelName || item.modelName
  };
  return enriched;
}
function enrichOrdersFromCatalog(orders, catalogProducts = []) {
  return orders.map((order) => ({
    ...order,
    items: (order.items || []).map((item) => enrichOrderItemFromCatalog(item, catalogProducts))
  }));
}

// server.ts
import_dotenv.default.config();
function resolveAppRoot() {
  const candidates = [
    process.env.PASSENGER_APP_ROOT,
    typeof __dirname !== "undefined" ? __dirname : "",
    process.cwd()
  ].map((c) => String(c || "").trim()).filter(Boolean);
  for (const candidate of candidates) {
    const abs = import_path.default.resolve(candidate);
    if (import_fs.default.existsSync(import_path.default.join(abs, "server.cjs")) || import_fs.default.existsSync(import_path.default.join(abs, "data")) || import_fs.default.existsSync(import_path.default.join(abs, ".htaccess"))) {
      return abs;
    }
  }
  return import_path.default.resolve(candidates[0] || process.cwd());
}
var APP_ROOT = resolveAppRoot();
var SHIPPING_DOCS_DIR = import_path.default.join(APP_ROOT, "storage", "labels");
try {
  import_fs.default.mkdirSync(SHIPPING_DOCS_DIR, { recursive: true });
} catch {
}
function safeLabelFilename(raw) {
  const base = import_path.default.basename(String(raw || "").trim());
  if (!base || base.includes("..") || !/\.pdf$/i.test(base)) return null;
  return base;
}
function isPdfBuffer(buffer, contentType) {
  if (contentType?.includes("pdf")) return true;
  return buffer.length > 4 && buffer.subarray(0, 4).toString() === "%PDF";
}
function serveLabelPdfFromDisk(filename, res) {
  const safe = safeLabelFilename(filename);
  if (!safe) {
    res.status(400).type("text/plain").send("T\xEAn file v\u1EADn \u0111\u01A1n kh\xF4ng h\u1EE3p l\u1EC7.");
    return "invalid";
  }
  const filePath = import_path.default.join(SHIPPING_DOCS_DIR, safe);
  if (!import_fs.default.existsSync(filePath)) {
    return "not_found";
  }
  const buf = import_fs.default.readFileSync(filePath);
  if (!isPdfBuffer(buf)) {
    console.error(
      `[Labels] File kh\xF4ng ph\u1EA3i PDF h\u1EE3p l\u1EC7: ${safe}, size=${buf.length}, head=${buf.subarray(0, 20).toString("hex")}`
    );
    res.status(415).type("text/plain").send("File v\u1EADn \u0111\u01A1n kh\xF4ng ph\u1EA3i PDF h\u1EE3p l\u1EC7.");
    return "invalid";
  }
  res.status(200);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${safe}"`);
  res.setHeader("Content-Length", String(buf.length));
  res.setHeader("Cache-Control", "no-store");
  res.end(buf);
  console.log(`[Labels] Served PDF ${safe} (${buf.length} bytes)`);
  return "sent";
}
var JWT_SECRET = process.env.JWT_SECRET || "omnisales-vn-super-secret-key-2026";
var ENV_PATH = import_path.default.join(APP_ROOT, ".env");
var PRODUCTION_APP_URL = "https://quanly.linhkienamthanh.net";
function resolveAppBaseUrl() {
  const fromEnv = String(process.env.APP_URL || process.env.API_BASE_URL || "").trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  if (process.env.NODE_ENV === "production") return PRODUCTION_APP_URL;
  return PRODUCTION_APP_URL;
}
var APP_BASE_URL = resolveAppBaseUrl();
function resolveShopeeCallbackUrl() {
  const explicit = String(process.env.SHOPEE_CALLBACK_URL || "").trim().replace(/\/$/, "");
  if (explicit) return explicit;
  return `${APP_BASE_URL}/api/shopee/callback`;
}
var SHOPEE_CALLBACK_URL = resolveShopeeCallbackUrl();
var SHOPEE_WEBHOOK_URL = `${APP_BASE_URL}/api/shopee/webhook`;
var SHOPEE_CALLBACK_IDLE_MSG = "Callback route is active. Waiting for Shopee parameters (code, shop_id)...";
function updateEnvVar(key, value) {
  let content = "";
  if (import_fs.default.existsSync(ENV_PATH)) {
    content = import_fs.default.readFileSync(ENV_PATH, "utf-8");
  }
  const regex = new RegExp(`^${key}\\s*=.*$`, "m");
  const line = `${key}=${value}`;
  if (regex.test(content)) {
    content = content.replace(regex, line);
  } else {
    content = (content.trimEnd() ? content.trimEnd() + "\n" : "") + line + "\n";
  }
  import_fs.default.writeFileSync(ENV_PATH, content, "utf-8");
  process.env[key] = value;
}
function maskApiKey(key) {
  if (!key || key.length < 8) return "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022";
  return key.slice(0, 4) + "\u2022\u2022\u2022\u2022" + key.slice(-4);
}
var SHOPEE_ENV = (process.env.SHOPEE_ENV || "live").toLowerCase();
var SHOPEE_HOST = "https://partner.shopeemobile.com";
if (SHOPEE_ENV !== "live") {
  console.warn(`[Shopee API] SHOPEE_ENV=${SHOPEE_ENV} \u2014 ch\u1EC9 d\xF9ng host Live: ${SHOPEE_HOST}`);
}
var SHOPEE_PARTNER_ID = process.env.SHOPEE_PARTNER_ID || "";
var SHOPEE_PARTNER_KEY = process.env.SHOPEE_PARTNER_KEY || "";
function isShopeeConfigValid() {
  return /^\d+$/.test(SHOPEE_PARTNER_ID) && SHOPEE_PARTNER_KEY.length > 0 && !/CHUA_CO|YOUR_LIVE/i.test(SHOPEE_PARTNER_KEY);
}
if (!isShopeeConfigValid()) {
  console.warn(
    `[Shopee API] \u26A0\uFE0F SHOPEE_PARTNER_ID (hi\u1EC7n t\u1EA1i: "${SHOPEE_PARTNER_ID || "(r\u1ED7ng)"}") ho\u1EB7c SHOPEE_PARTNER_KEY ch\u01B0a \u0111\u01B0\u1EE3c \u0111i\u1EC1n \u0111\xFAng trong .env. Partner_id ph\u1EA3i l\xE0 m\u1ED9t s\u1ED1 nguy\xEAn (v\xED d\u1EE5: 2001234), l\u1EA5y t\u1EEB App PRODUCTION (Live) tr\xEAn open.shopee.com, KH\xD4NG d\xF9ng Sandbox. M\u1ECDi l\u1EA7n g\u1ECDi API Shopee s\u1EBD b\u1EC3 tr\u1EA3 l\u1ED7i error_param cho \u0111\u1EBFn khi s\u1EEDa \u0111\xFAng gi\xE1 tr\u1ECB n\xE0y.`
  );
}
var SHOPEE_TOKENS_PATH = import_path.default.resolve(APP_ROOT, "data", "shopee_tokens.json");
var SHOPEE_OAUTH_LAST_PATH = import_path.default.resolve(APP_ROOT, "data", "shopee_oauth_last.json");
function ensureDataDirs() {
  const dataDir = import_path.default.join(APP_ROOT, "data");
  import_fs.default.mkdirSync(dataDir, { recursive: true });
  if (!import_fs.default.existsSync(SHOPEE_TOKENS_PATH)) {
    import_fs.default.writeFileSync(SHOPEE_TOKENS_PATH, "{}\n", "utf-8");
  }
}
function saveOAuthAudit(entry) {
  try {
    ensureDataDirs();
    import_fs.default.writeFileSync(
      SHOPEE_OAUTH_LAST_PATH,
      JSON.stringify({ ...entry, at: (/* @__PURE__ */ new Date()).toISOString() }, null, 2),
      "utf-8"
    );
  } catch (error) {
    console.error("[Shopee OAuth] Failed to write shopee_oauth_last.json:", error);
  }
}
function loadLastOAuthAudit() {
  try {
    if (!import_fs.default.existsSync(SHOPEE_OAUTH_LAST_PATH)) return null;
    return JSON.parse(import_fs.default.readFileSync(SHOPEE_OAUTH_LAST_PATH, "utf-8"));
  } catch {
    return null;
  }
}
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
  `[Boot] APP_ROOT=${APP_ROOT} | cwd=${process.cwd()} | SHOPEE_TOKENS_PATH=${SHOPEE_TOKENS_PATH} | exists=${import_fs.default.existsSync(SHOPEE_TOKENS_PATH)} | SHOPEE_CALLBACK_URL=${SHOPEE_CALLBACK_URL}`
);
function loadShopeeTokens() {
  try {
    if (!import_fs.default.existsSync(SHOPEE_TOKENS_PATH)) return {};
    const raw = import_fs.default.readFileSync(SHOPEE_TOKENS_PATH, "utf-8");
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
      access_token: record?.access_token ? `${String(record.access_token).slice(0, 16)}\u2026` : null,
      refresh_token: record?.refresh_token ? `${String(record.refresh_token).slice(0, 16)}\u2026` : null
    };
  }
  return masked;
}
function saveShopeeTokens(tokensToWrite) {
  const absPath = import_path.default.resolve(SHOPEE_TOKENS_PATH);
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
        shop_id
      };
      console.log(
        "DEBUG SAVE: Saving data for shop:",
        shop_id,
        "Full Data:",
        JSON.stringify(tokensData[shop_id])
      );
    }
    const keysAfter = Object.keys(tokensData);
    console.log(
      "DEBUG SAVE: Merge keys",
      JSON.stringify({ keysBefore, keysAfter, addedOrUpdated: keysAfter.filter((k) => !keysBefore.includes(k) || tokensToWrite[k]) })
    );
    console.log("DEBUG SAVE: Full tokensData file keys:", keysAfter);
    console.log(
      "DEBUG SAVE: Full tokensData (masked):",
      JSON.stringify(maskTokenStoreForLog(tokensData))
    );
    const payload = JSON.stringify(tokensData, null, 2);
    console.log(
      "[Shopee Tokens] fs.writeFileSync \u2014 TR\u01AF\u1EDAC KHI GHI",
      JSON.stringify({
        absPath,
        SHOPEE_TOKENS_PATH,
        APP_ROOT,
        keys: keysAfter,
        byteLength: Buffer.byteLength(payload, "utf-8")
      })
    );
    import_fs.default.writeFileSync(absPath, payload, "utf-8");
    console.log(
      "[Shopee Tokens] fs.writeFileSync \u2014 GHI TH\xC0NH C\xD4NG",
      JSON.stringify({ absPath, keys: keysAfter, fileSize: import_fs.default.statSync(absPath).size })
    );
    return true;
  } catch (error) {
    console.error(
      "[Shopee Tokens] fs.writeFileSync \u2014 L\u1ED6I GHI FILE",
      JSON.stringify({
        absPath,
        SHOPEE_TOKENS_PATH,
        errorMessage: error?.message || String(error),
        errorCode: error?.code || null
      })
    );
    return false;
  }
}
function normalizeShopIdKey(shopId) {
  const key = String(shopId ?? "").trim();
  return /^\d+$/.test(key) ? key : "";
}
function queryParamOne(value) {
  if (Array.isArray(value)) return String(value[0] ?? "").trim();
  return String(value ?? "").trim();
}
function shouldOAuthRedirectToFrontend(req) {
  if (queryParamOne(req.query?.format) === "json") return false;
  if (queryParamOne(req.query?.redirect) === "0") return false;
  return true;
}
function buildOAuthFrontendRedirectUrl(req, result) {
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
  const inner = raw?.response && typeof raw.response === "object" && !Array.isArray(raw.response) ? raw.response : raw?.data && typeof raw.data === "object" ? raw.data : raw;
  const access_token = inner?.access_token ?? inner?.accessToken ?? raw?.access_token ?? raw?.accessToken ?? "";
  const refresh_token = inner?.refresh_token ?? inner?.refreshToken ?? raw?.refresh_token ?? raw?.refreshToken ?? "";
  const expire_in = Number(
    inner?.expire_in ?? inner?.expire_time ?? inner?.expires_in ?? raw?.expire_in ?? raw?.expire_time ?? 0
  );
  const shop_id_list = inner?.shop_id_list ?? raw?.shop_id_list ?? inner?.shop_ids ?? [];
  const merchant_id_list = inner?.merchant_id_list ?? raw?.merchant_id_list ?? [];
  return {
    ...raw,
    access_token: access_token || void 0,
    refresh_token: refresh_token || void 0,
    expire_in: expire_in > 0 ? expire_in : void 0,
    shop_id_list: Array.isArray(shop_id_list) ? shop_id_list : [],
    merchant_id_list: Array.isArray(merchant_id_list) ? merchant_id_list : [],
    shop_id: inner?.shop_id ?? raw?.shop_id,
    error: raw?.error ?? inner?.error,
    message: raw?.message ?? inner?.message,
    _raw: raw
  };
}
function buildShopeeTokenRecord(shopKey, authJson, oauthShopId, existing) {
  const key = normalizeShopIdKey(shopKey);
  const oauth = normalizeShopIdKey(oauthShopId) || key;
  const fromAuthList = Array.isArray(authJson?.shop_id_list) ? authJson.shop_id_list.map((x) => normalizeShopIdKey(x)).filter(Boolean) : [];
  const fromExistingList = Array.isArray(existing?.shop_id_list) ? existing.shop_id_list.map((x) => normalizeShopIdKey(x)).filter(Boolean) : [];
  const shopIdList = [...new Set([...fromAuthList, ...fromExistingList, key].filter(Boolean))];
  const fromAuthMerchants = Array.isArray(authJson?.merchant_id_list) ? authJson.merchant_id_list.map((x) => String(x)).filter(Boolean) : [];
  const fromExistingMerchants = Array.isArray(existing?.merchant_id_list) ? existing.merchant_id_list.map((x) => String(x)).filter(Boolean) : [];
  const merchantIdList = [.../* @__PURE__ */ new Set([...fromAuthMerchants, ...fromExistingMerchants])];
  return {
    shop_id: key,
    access_token: String(authJson?.access_token ?? existing?.access_token ?? ""),
    refresh_token: String(authJson?.refresh_token ?? existing?.refresh_token ?? ""),
    expire_in: Number(authJson?.expire_in ?? existing?.expire_in ?? 14400),
    obtained_at: Number(authJson?.obtained_at ?? Math.floor(Date.now() / 1e3)),
    oauth_shop_id: existing?.oauth_shop_id || oauth,
    shop_id_list: shopIdList,
    merchant_id_list: merchantIdList
  };
}
function normalizeTokenStore(tokens) {
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
function getShopeeTokenRecord(tokens, shopId) {
  const key = normalizeShopIdKey(shopId);
  if (!key) return null;
  if (tokens[key]) return tokens[key];
  for (const [k, v] of Object.entries(tokens)) {
    if (normalizeShopIdKey(k) === key) return v;
    const linked = Array.isArray(v?.shop_id_list) ? v.shop_id_list : [];
    if (linked.some((id) => normalizeShopIdKey(id) === key)) return v;
  }
  return null;
}
function collectShopIdsForTokenSave(requestShopId, authJson, expectedShopId) {
  const ids = /* @__PURE__ */ new Set();
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
      `[Shopee OAuth] Shop mismatch: expected=${expected}, oauth=${oauthShopId}, shop_id_list=[${(authJson?.shop_id_list || []).join(", ")}] \u2014 kh\xF4ng l\u01B0u alias token sai shop.`
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
  const saved = [...shopIds];
  const tokensData = normalizeTokenStore(loadShopeeTokens());
  console.log(
    "[Shopee Tokens] persistOAuthTokens \u2014 SAU MERGE",
    JSON.stringify({
      oauthShopId,
      mainAccountId: mainAccountId || null,
      expectedShopId: expected || null,
      shopMismatch,
      keysBefore: keysBeforeMerge,
      keysAfter: Object.keys(tokensData),
      shopIdsSaved: saved,
      shopee_shop_id_list: authJson?.shop_id_list || [],
      tokensPath: SHOPEE_TOKENS_PATH
    })
  );
  return saved;
}
function verifyTokenSaved(shopId) {
  const key = normalizeShopIdKey(shopId);
  if (!key) return false;
  const tokens = loadShopeeTokens();
  return Boolean(getShopeeTokenRecord(tokens, key)?.access_token);
}
async function completeShopeeOAuthFlow(code, params) {
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
      message: `Thi\u1EBFu shop_id ho\u1EB7c main_account_id h\u1EE3p l\u1EC7 trong callback (shop_id=${params.shopIdRaw || ""}, main_account_id=${params.mainAccountIdRaw || ""})`
    };
  }
  console.log(
    "[Shopee OAuth] completeShopeeOAuthFlow B\u1EAET \u0110\u1EA6U",
    JSON.stringify({
      oauthShopId: oauthShopId || null,
      mainAccountId: mainAccountId || null,
      expectedShopId: expected || null,
      shop_mismatch: expected && oauthShopId ? expected !== oauthShopId : false,
      code_preview: `${code.slice(0, 8)}\u2026`,
      tokensPath: SHOPEE_TOKENS_PATH
    })
  );
  const tokenResult = await exchangeShopeeCodeForToken(code, {
    shopId: oauthShopId || void 0,
    mainAccountId: mainAccountId || void 0
  });
  let savedIds = [];
  if (tokenResult.access_token) {
    savedIds = persistOAuthTokens(tokenResult, {
      oauthShopId: oauthShopId || void 0,
      mainAccountId: mainAccountId || void 0,
      expectedShopId: expected || void 0
    });
    tokenResult.saved_shop_ids = savedIds;
  }
  const shopMismatch = Boolean(
    expected && oauthShopId && expected !== oauthShopId && !savedIds.includes(expected)
  );
  const verified = expected ? savedIds.includes(expected) && verifyTokenSaved(expected) : oauthShopId ? verifyTokenSaved(oauthShopId) : savedIds.length > 0;
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
    app_root: APP_ROOT
  });
  return {
    success: Boolean(tokenResult.access_token) && verified && !shopMismatch,
    oauth_shop_id: oauthShopId || savedIds[0] || "",
    expected_shop_id: expected || null,
    shop_mismatch: shopMismatch,
    saved_shop_ids: savedIds,
    verified_in_file: verified,
    error: tokenResult.error || (shopMismatch ? "shop_mismatch" : verified ? null : "token_not_persisted"),
    message: shopMismatch ? `Shopee tr\u1EA3 v\u1EC1 shop ${oauthShopId}, KH\xD4NG ph\u1EA3i shop b\u1EA1n y\xEAu c\u1EA7u ${expected}. Token KH\xD4NG th\u1EC3 d\xF9ng cho shop kh\xE1c \u2014 h\xE3y \u0111\u0103ng xu\u1EA5t Shopee Seller Center, \u0111\u0103ng nh\u1EADp \u0111\xFAng shop ${expected}, r\u1ED3i b\u1EA5m OAuth l\u1EA1i.` : tokenResult.message || (verified ? `OAuth th\xE0nh c\xF4ng. Token \u0111\xE3 l\u01B0u cho: [${savedIds.join(", ")}].` : "Token kh\xF4ng ghi \u0111\u01B0\u1EE3c v\xE0o shopee_tokens.json"),
    shopee_response: tokenResult.access_token ? { shop_id_list: tokenResult.shop_id_list || [], expire_in: tokenResult.expire_in } : tokenResult
  };
}
function buildShopeeAuthPartnerUrl(shopId) {
  const apiPath = "/api/v2/shop/auth_partner";
  const timestamp = Math.floor(Date.now() / 1e3);
  const sign = shopeeSign(apiPath, timestamp);
  const sid = normalizeShopIdKey(shopId);
  const redirectTarget = sid ? `${SHOPEE_CALLBACK_URL}?redirect=1&expected_shop=${sid}` : `${SHOPEE_CALLBACK_URL}?redirect=1`;
  const redirect = encodeURIComponent(redirectTarget);
  let url = `${SHOPEE_HOST}${apiPath}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&sign=${sign}&redirect=${redirect}`;
  if (sid) url += `&shop_id=${sid}`;
  console.log(`[Shopee OAuth] auth_partner URL cho shop_id=${sid || "(none)"}: ${url.replace(/sign=[^&]+/, "sign=***")}`);
  return url;
}
function saveShopeeTokenForShop(shopId, record) {
  const key = normalizeShopIdKey(shopId);
  if (!key) return;
  let tokens = normalizeTokenStore(loadShopeeTokens());
  const existing = tokens[key];
  tokens[key] = buildShopeeTokenRecord(
    key,
    { ...existing, ...record, obtained_at: record.obtained_at ?? Math.floor(Date.now() / 1e3) },
    existing?.oauth_shop_id || key,
    existing
  );
  saveShopeeTokens(tokens);
  console.log(`[Shopee Tokens] Saved token for shop_id=${key}. All shops: [${Object.keys(tokens).join(", ")}]`);
}
function listShopeeOAuthShopIds() {
  return Object.keys(loadShopeeTokens()).map(normalizeShopIdKey).filter(Boolean).sort();
}
function shopeeSign(apiPath, timestamp, accessToken, shopId) {
  const baseString = accessToken && shopId ? `${SHOPEE_PARTNER_ID}${apiPath}${timestamp}${accessToken}${shopId}` : `${SHOPEE_PARTNER_ID}${apiPath}${timestamp}`;
  return import_crypto.default.createHmac("sha256", SHOPEE_PARTNER_KEY).update(baseString).digest("hex");
}
async function exchangeShopeeCodeForToken(code, opts) {
  const shopId = normalizeShopIdKey(opts.shopId);
  const mainAccountId = normalizeShopIdKey(opts.mainAccountId);
  if (!isShopeeConfigValid()) {
    const error = {
      error: "invalid_partner_config",
      message: `SHOPEE_PARTNER_ID/"${SHOPEE_PARTNER_ID}" ho\u1EB7c SHOPEE_PARTNER_KEY trong .env ch\u01B0a ph\u1EA3i gi\xE1 tr\u1ECB Live th\u1EF1c. Vui l\xF2ng \u0111i\u1EC1n \u0111\xFAng Partner ID (s\u1ED1 nguy\xEAn) v\xE0 Partner Key t\u1EEB App PRODUCTION tr\xEAn open.shopee.com r\u1ED3i th\u1EED l\u1EA1i.`
    };
    console.error(`[Shopee OAuth] \u274C Kh\xF4ng th\u1EC3 \u0111\u1ED5i code: ${error.message}`);
    return error;
  }
  if (!shopId && !mainAccountId) {
    return {
      error: "missing_shop_or_main_account",
      message: "Shopee token/get c\u1EA7n shop_id HO\u1EB6C main_account_id (kh\xF4ng \u0111\u01B0\u1EE3c thi\u1EBFu c\u1EA3 hai)."
    };
  }
  const apiPath = "/api/v2/auth/token/get";
  const timestamp = Math.floor(Date.now() / 1e3);
  const sign = shopeeSign(apiPath, timestamp);
  const url = `${SHOPEE_HOST}${apiPath}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&sign=${sign}`;
  const body = {
    code,
    partner_id: Number(SHOPEE_PARTNER_ID)
  };
  if (mainAccountId) {
    body.main_account_id = Number(mainAccountId);
  } else if (shopId) {
    body.shop_id = Number(shopId);
  }
  console.log(
    "[Shopee OAuth] token/get request",
    JSON.stringify({ shop_id: shopId || null, main_account_id: mainAccountId || null })
  );
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const rawText = await res.text();
  console.log("DEBUG RAW RESPONSE:", rawText);
  let json;
  try {
    json = rawText ? JSON.parse(rawText) : {};
  } catch (parseErr) {
    console.error("[Shopee OAuth] Kh\xF4ng parse \u0111\u01B0\u1EE3c JSON t\u1EEB Shopee:", parseErr);
    return { error: "invalid_json", message: rawText.slice(0, 500) };
  }
  json = normalizeShopeeTokenResponse(json);
  console.log("DEBUG NORMALIZED RESPONSE:", JSON.stringify(json));
  console.log(`[Shopee API] POST ${apiPath} (env=${SHOPEE_ENV}) -> HTTP ${res.status}`);
  if (json.access_token && json.refresh_token) {
    console.log(
      "[Shopee OAuth] \u0110\xC3 L\u1EA4Y TOKEN T\u1EEA SHOPEE",
      JSON.stringify({
        shop_id: shopId || null,
        main_account_id: mainAccountId || null,
        access_token: `${String(json.access_token).slice(0, 16)}\u2026`,
        refresh_token: `${String(json.refresh_token).slice(0, 16)}\u2026`,
        expire_in: json.expire_in,
        shop_id_list: json.shop_id_list || []
      })
    );
  } else {
    console.error(
      "[Shopee OAuth] SHOPEE KH\xD4NG TR\u1EA2 \u0111\u1EE7 access_token/refresh_token",
      JSON.stringify({
        shop_id: shopId || null,
        main_account_id: mainAccountId || null,
        httpStatus: res.status,
        error: json.error || null,
        message: json.message || null,
        keys: Object.keys(json)
      })
    );
  }
  return json;
}
async function refreshShopeeToken(shopId, refreshToken) {
  const apiPath = "/api/v2/auth/access_token/get";
  const timestamp = Math.floor(Date.now() / 1e3);
  const sign = shopeeSign(apiPath, timestamp);
  const url = `${SHOPEE_HOST}${apiPath}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&sign=${sign}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken, shop_id: Number(shopId), partner_id: Number(SHOPEE_PARTNER_ID) })
  });
  const json = await res.json();
  console.log(`[Shopee API] POST ${apiPath} (refresh) -> HTTP ${res.status}:`, JSON.stringify(json));
  const normalized = normalizeShopeeTokenResponse(json);
  if (normalized.access_token) {
    saveShopeeTokenForShop(shopId, {
      access_token: normalized.access_token,
      refresh_token: normalized.refresh_token,
      expire_in: normalized.expire_in,
      obtained_at: Math.floor(Date.now() / 1e3)
    });
    return normalized;
  }
  console.error(
    `[Shopee API] Refresh token th\u1EA5t b\u1EA1i shop_id=${shopId}:`,
    normalized.error || json.error,
    normalized.message || json.message
  );
  return normalized;
}
function isShopeeInvalidTokenError(error, message) {
  const text = `${error || ""} ${message || ""}`.toLowerCase();
  return /invalid.*access_token|invalid_acceess_token|error_auth|invalid_token|token expired/.test(text);
}
async function getShopeeAccessTokenForApi(shopKey, opts) {
  const fileKey = normalizeShopIdKey(shopKey);
  if (!fileKey) return null;
  const tokens = loadShopeeTokens();
  const record = getShopeeTokenRecord(tokens, fileKey);
  if (!record?.refresh_token && !record?.access_token) return null;
  const apiShopId = resolveShopeeApiShopId(record, fileKey);
  if (opts?.forceRefresh && record.refresh_token) {
    console.log(`[Shopee API] Force refresh token shop_id=${apiShopId} (key=${fileKey})`);
    const refreshed = await refreshShopeeToken(apiShopId, record.refresh_token);
    if (refreshed.access_token) {
      if (fileKey !== apiShopId) {
        saveShopeeTokenForShop(fileKey, {
          access_token: refreshed.access_token,
          refresh_token: refreshed.refresh_token,
          expire_in: refreshed.expire_in,
          obtained_at: Math.floor(Date.now() / 1e3)
        });
      }
      return { token: refreshed.access_token, apiShopId, fileKey };
    }
    return null;
  }
  const token = await getValidShopeeAccessToken(fileKey);
  if (!token) return null;
  return { token, apiShopId, fileKey };
}
async function verifyShopeeShopToken(shopId, accessToken) {
  const key = normalizeShopIdKey(shopId);
  if (!key || !accessToken) return { ok: false, error: "missing_shop_or_token" };
  try {
    const apiPath = "/api/v2/shop/get_shop_info";
    const timestamp = Math.floor(Date.now() / 1e3);
    const sign = shopeeSign(apiPath, timestamp, accessToken, key);
    const url = `${SHOPEE_HOST}${apiPath}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&access_token=${accessToken}&shop_id=${key}&sign=${sign}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12e3);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    const json = await res.json();
    const err = String(json?.error || "").trim();
    if (err) return { ok: false, error: err };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}
function resolveShopeeApiShopId(record, configuredShopId) {
  const configured = normalizeShopIdKey(configuredShopId);
  const recordKey = normalizeShopIdKey(record?.shop_id);
  if (recordKey === configured) return configured;
  const oauth = normalizeShopIdKey(record?.oauth_shop_id);
  if (oauth) return oauth;
  return recordKey || configured;
}
async function getValidShopeeAccessToken(shopId) {
  const tokens = loadShopeeTokens();
  const key = normalizeShopIdKey(shopId);
  const record = getShopeeTokenRecord(tokens, key);
  if (!record) {
    const available = listShopeeOAuthShopIds();
    console.warn(
      `[Shopee API] Ch\u01B0a c\xF3 access_token cho shop_id=${key}. Token \u0111ang c\xF3: [${available.join(", ") || "kh\xF4ng c\xF3"}]`
    );
    return null;
  }
  const now = Math.floor(Date.now() / 1e3);
  const isExpired = now - record.obtained_at >= record.expire_in - 60;
  if (!isExpired) return record.access_token;
  console.log(`[Shopee API] access_token c\u1EE7a shop_id=${key} \u0111\xE3 h\u1EBFt h\u1EA1n, \u0111ang refresh...`);
  const apiShopId = resolveShopeeApiShopId(record, key);
  const refreshed = await refreshShopeeToken(apiShopId, record.refresh_token);
  return refreshed.access_token || null;
}
async function runShopeeConnectivityDiagnostics(shopIdInput) {
  const steps = [];
  const maskedPartnerKey = SHOPEE_PARTNER_KEY ? `${SHOPEE_PARTNER_KEY.slice(0, 4)}\u2026${SHOPEE_PARTNER_KEY.slice(-4)}` : "";
  steps.push({
    step: "env_partner_config",
    ok: isShopeeConfigValid(),
    code: isShopeeConfigValid() ? "OK" : "MISSING_PARTNER_CONFIG",
    detail: isShopeeConfigValid() ? "SHOPEE_PARTNER_ID / SHOPEE_PARTNER_KEY h\u1EE3p l\u1EC7 (tr\xEAn backend cPanel .env ho\u1EB7c SetEnv)." : `Thi\u1EBFu ho\u1EB7c sai Partner credentials. partner_id="${SHOPEE_PARTNER_ID || "(r\u1ED7ng)"}", key=${SHOPEE_PARTNER_KEY ? "\u0111\xE3 set" : "(r\u1ED7ng)"}`,
    data: {
      shopee_env: SHOPEE_ENV,
      shopee_host: SHOPEE_HOST,
      partner_id: SHOPEE_PARTNER_ID || null,
      partner_key_preview: SHOPEE_PARTNER_KEY ? maskedPartnerKey : null,
      note: "Bi\u1EBFn SHOPEE_* ph\u1EA3i c\u1EA5u h\xECnh tr\xEAn cPanel backend \u2014 KH\xD4NG ch\u1EC9 tr\xEAn Vercel frontend."
    }
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
    detail: availableShopIds.length > 0 ? `C\xF3 token OAuth cho shop: ${availableShopIds.join(", ")}` : "Ch\u01B0a c\xF3 shop n\xE0o trong data/shopee_tokens.json \u2014 c\u1EA7n OAuth l\u1EA1i qua /api/shopee/callback",
    data: { availableShopIds, tokensPath: SHOPEE_TOKENS_PATH }
  });
  const shopId = String(shopIdInput || availableShopIds[0] || "").trim();
  if (!shopId) {
    steps.push({
      step: "shop_id",
      ok: false,
      code: "MISSING_OAUTH_TOKEN",
      detail: "Kh\xF4ng c\xF3 shop_id \u0111\u1EC3 ki\u1EC3m tra. Truy\u1EC1n ?shop_id= ho\u1EB7c OAuth shop tr\u01B0\u1EDBc."
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
      detail: accessToken ? `L\u1EA5y \u0111\u01B0\u1EE3c access_token cho shop_id=${shopId}` : `Kh\xF4ng l\u1EA5y \u0111\u01B0\u1EE3c token h\u1EE3p l\u1EC7 cho shop_id=${shopId} (h\u1EBFt h\u1EA1n / refresh fail)`,
      data: { shopId }
    });
  } catch (error) {
    steps.push({
      step: "access_token",
      ok: false,
      code: "INVALID_TOKEN",
      detail: error?.message || String(error)
    });
    return { ok: false, code: "INVALID_TOKEN", steps };
  }
  if (!accessToken) {
    return { ok: false, code: "INVALID_TOKEN", steps };
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12e3);
    const apiPath = "/api/v2/shop/get_shop_info";
    const timestamp = Math.floor(Date.now() / 1e3);
    const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);
    const url = `${SHOPEE_HOST}${apiPath}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&access_token=${accessToken}&shop_id=${shopId}&sign=${sign}`;
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    const json = await res.json();
    const shopeeErr = String(json?.error || "").trim();
    const ok = res.ok && !shopeeErr;
    let code = "OK";
    let detail = `HTTP ${res.status} \u2014 g\u1ECDi ${SHOPEE_HOST} th\xE0nh c\xF4ng`;
    if (!ok) {
      const errLower = shopeeErr.toLowerCase();
      if (/invalid.*token|error_auth|refresh/.test(errLower)) code = "INVALID_TOKEN";
      else if (/error_param|invalid.*partner|sign/.test(errLower)) code = "MISSING_PARTNER_CONFIG";
      else code = "SHOPEE_API_ERROR";
      detail = shopeeErr ? `Shopee tr\u1EA3 l\u1ED7i: ${shopeeErr} \u2014 ${json?.message || ""}`.trim() : `HTTP ${res.status} t\u1EEB Shopee API`;
    }
    steps.push({
      step: "shopee_api_ping",
      ok,
      code,
      detail,
      data: { httpStatus: res.status, shopeeResponse: json }
    });
    return { ok, code, steps, shopId };
  } catch (error) {
    const isTimeout = error?.name === "AbortError";
    const code = isTimeout ? "TIMEOUT" : error?.cause?.code === "ENOTFOUND" ? "NETWORK_ERROR" : "UNKNOWN_ERROR";
    steps.push({
      step: "shopee_api_ping",
      ok: false,
      code,
      detail: isTimeout ? "Timeout 12s khi g\u1ECDi partner.shopeemobile.com" : error?.message || String(error)
    });
    return { ok: false, code, steps, shopId };
  }
}
async function shopeeGetOrderList(shopId, accessToken, opts) {
  const apiPath = "/api/v2/order/get_order_list";
  const timestamp = Math.floor(Date.now() / 1e3);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);
  const timeTo = opts?.timeTo ?? timestamp;
  const timeFrom = opts?.timeFrom ?? timeTo - 15 * 24 * 60 * 60;
  const params = new URLSearchParams({
    partner_id: SHOPEE_PARTNER_ID,
    timestamp: String(timestamp),
    access_token: accessToken,
    shop_id: shopId,
    sign,
    time_range_field: opts?.timeRangeField || "create_time",
    time_from: String(timeFrom),
    time_to: String(timeTo),
    page_size: "100",
    response_optional_fields: "order_status"
  });
  if (opts?.orderStatus) params.set("order_status", opts.orderStatus);
  if (opts?.cursor !== void 0 && opts.cursor !== "") params.set("cursor", opts.cursor);
  const url = `${SHOPEE_HOST}${apiPath}?${params.toString()}`;
  const res = await fetch(url);
  const json = await res.json();
  console.log(
    `[Shopee API] GET ${apiPath} (shop_id=${shopId}, status=${opts?.orderStatus || "ALL"}, field=${opts?.timeRangeField || "create_time"}, from=${timeFrom}, to=${timeTo}, cursor=${opts?.cursor || ""}) -> HTTP ${res.status}:`,
    JSON.stringify(json)
  );
  if (json.error) {
    console.error(`[Shopee API] L\u1ED7i t\u1EEB Shopee khi l\u1EA5y danh s\xE1ch \u0111\u01A1n: ${json.error} - ${json.message}`);
  }
  return json;
}
function extractShopeeOrderListRows(result) {
  const rows = result?.response?.order_list ?? result?.order_list;
  return Array.isArray(rows) ? rows : [];
}
function parseShopeeOrderListPagination(result) {
  const body = result?.response ?? result ?? {};
  const more = body.more === true || body.more === 1 || body.more === "true" || body.has_more === true || body.has_more === 1 || body.has_more === "true" || result?.more === true || result?.more === 1;
  const nextCursor = String(
    body.next_cursor ?? body.cursor ?? result?.next_cursor ?? result?.cursor ?? ""
  ).trim();
  return { more, nextCursor };
}
var SHOPEE_ORDER_LIST_WINDOW_SEC = 15 * 24 * 60 * 60;
var SHOPEE_ORDER_LIST_MAX_WINDOWS = 8;
async function shopeeFetchAllOrderSnsByStatus(shopId, accessToken, orderStatus) {
  const orderSnSet = /* @__PURE__ */ new Set();
  const now = Math.floor(Date.now() / 1e3);
  for (let windowIdx = 0; windowIdx < SHOPEE_ORDER_LIST_MAX_WINDOWS; windowIdx++) {
    const timeTo = now - windowIdx * SHOPEE_ORDER_LIST_WINDOW_SEC;
    const timeFrom = timeTo - SHOPEE_ORDER_LIST_WINDOW_SEC;
    let cursor;
    let page = 0;
    let windowCount = 0;
    while (page < 500) {
      page++;
      const listResult = await shopeeGetOrderList(shopId, accessToken, {
        orderStatus,
        cursor,
        timeRangeField: "create_time",
        timeFrom,
        timeTo
      });
      if (listResult.error) {
        throw new Error(`${listResult.error}${listResult.message ? ` - ${listResult.message}` : ""}`);
      }
      const pageList = extractShopeeOrderListRows(listResult);
      for (const row of pageList) {
        if (row?.order_sn) orderSnSet.add(String(row.order_sn));
      }
      windowCount += pageList.length;
      const { more, nextCursor } = parseShopeeOrderListPagination(listResult);
      console.log(
        `[Shopee Sync] shop_id=${shopId} status=${orderStatus} window=${windowIdx + 1} page=${page}: +${pageList.length} (c\u1EEDa s\u1ED5 ${windowCount}, t\u1ED5ng ${orderSnSet.size}), more=${more}`
      );
      if (!more) break;
      if (!nextCursor) {
        console.warn(
          `[Shopee Sync] shop_id=${shopId} status=${orderStatus} window=${windowIdx + 1}: more=true nh\u01B0ng thi\u1EBFu next_cursor \u2014 d\u1EEBng sau trang ${page}.`
        );
        break;
      }
      cursor = nextCursor;
      await new Promise((r) => setTimeout(r, 120));
    }
    if (windowCount === 0 && windowIdx > 0) break;
  }
  return Array.from(orderSnSet);
}
async function shopeeFetchAllOrderSns(shopId, accessToken) {
  const orderSnSet = /* @__PURE__ */ new Set();
  const now = Math.floor(Date.now() / 1e3);
  for (let windowIdx = 0; windowIdx < SHOPEE_ORDER_LIST_MAX_WINDOWS; windowIdx++) {
    const timeTo = now - windowIdx * SHOPEE_ORDER_LIST_WINDOW_SEC;
    const timeFrom = timeTo - SHOPEE_ORDER_LIST_WINDOW_SEC;
    let cursor;
    let page = 0;
    let windowCount = 0;
    while (page < 500) {
      page++;
      const listResult = await shopeeGetOrderList(shopId, accessToken, {
        cursor,
        timeRangeField: "create_time",
        timeFrom,
        timeTo
      });
      if (listResult.error) {
        throw new Error(`${listResult.error}${listResult.message ? ` - ${listResult.message}` : ""}`);
      }
      const pageList = extractShopeeOrderListRows(listResult);
      for (const row of pageList) {
        if (row?.order_sn) orderSnSet.add(String(row.order_sn));
      }
      windowCount += pageList.length;
      const { more, nextCursor } = parseShopeeOrderListPagination(listResult);
      console.log(
        `[Shopee API] shop_id=${shopId} window=${windowIdx + 1} page=${page}: +${pageList.length} (t\u1ED5ng ${orderSnSet.size}), more=${more}`
      );
      if (!more) break;
      if (!nextCursor) break;
      cursor = nextCursor;
      await new Promise((r) => setTimeout(r, 120));
    }
    if (windowCount === 0 && windowIdx > 0) break;
  }
  return Array.from(orderSnSet);
}
async function shopeeGetOrderDetail(shopId, accessToken, orderSnList) {
  const apiPath = "/api/v2/order/get_order_detail";
  const timestamp = Math.floor(Date.now() / 1e3);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);
  const params = new URLSearchParams({
    partner_id: SHOPEE_PARTNER_ID,
    timestamp: String(timestamp),
    access_token: accessToken,
    shop_id: shopId,
    sign,
    order_sn_list: orderSnList.join(","),
    // Note: `image_info` is nested inside item_list automatically — not a top-level field.
    // `order_status` / `create_time` are NOT valid values here (they're returned by default);
    // passing them causes Shopee to reject the whole request with response_optional_fields error.
    response_optional_fields: "buyer_user_id,item_list,total_amount,shipping_carrier,package_list"
  });
  const url = `${SHOPEE_HOST}${apiPath}?${params.toString()}`;
  const res = await fetch(url);
  const json = await res.json();
  console.log(`[Shopee API] GET ${apiPath} (shop_id=${shopId}, ${orderSnList.length} orders) -> HTTP ${res.status}:`, JSON.stringify(json));
  if (json.error) {
    console.error(`[Shopee API] L\u1ED7i t\u1EEB Shopee khi l\u1EA5y chi ti\u1EBFt \u0111\u01A1n: ${json.error} - ${json.message}`);
  }
  return json;
}
async function shopeeGetItemList(shopId, accessToken, offset) {
  const apiPath = "/api/v2/product/get_item_list";
  const timestamp = Math.floor(Date.now() / 1e3);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);
  const params = new URLSearchParams({
    partner_id: SHOPEE_PARTNER_ID,
    timestamp: String(timestamp),
    access_token: accessToken,
    shop_id: shopId,
    sign,
    offset: String(offset),
    page_size: "100",
    item_status: "NORMAL"
  });
  const url = `${SHOPEE_HOST}${apiPath}?${params.toString()}`;
  const res = await fetch(url);
  const json = await res.json();
  console.log(`[Shopee API] GET ${apiPath} (offset=${offset}) -> HTTP ${res.status}:`, JSON.stringify(json));
  if (json.error) {
    console.error(`[Shopee API] L\u1ED7i t\u1EEB Shopee khi l\u1EA5y danh s\xE1ch s\u1EA3n ph\u1EA9m: ${json.error} - ${json.message}`);
  }
  return json;
}
async function shopeeGetItemBaseInfo(shopId, accessToken, itemIds) {
  const apiPath = "/api/v2/product/get_item_base_info";
  const timestamp = Math.floor(Date.now() / 1e3);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);
  const params = new URLSearchParams({
    partner_id: SHOPEE_PARTNER_ID,
    timestamp: String(timestamp),
    access_token: accessToken,
    shop_id: shopId,
    sign,
    item_id_list: itemIds.join(","),
    need_tax_info: "false",
    need_complaint_policy: "false"
  });
  const url = `${SHOPEE_HOST}${apiPath}?${params.toString()}`;
  const res = await fetch(url);
  const json = await res.json();
  console.log(`[Shopee API] GET ${apiPath} (${itemIds.length} items) -> HTTP ${res.status}:`, JSON.stringify(json));
  if (json.error) {
    console.error(`[Shopee API] L\u1ED7i t\u1EEB Shopee khi l\u1EA5y th\xF4ng tin s\u1EA3n ph\u1EA9m: ${json.error} - ${json.message}`);
  }
  return json;
}
async function shopeeGetModelList(shopId, accessToken, itemId) {
  const apiPath = "/api/v2/product/get_model_list";
  const timestamp = Math.floor(Date.now() / 1e3);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);
  const params = new URLSearchParams({
    partner_id: SHOPEE_PARTNER_ID,
    timestamp: String(timestamp),
    access_token: accessToken,
    shop_id: shopId,
    sign,
    item_id: String(itemId)
  });
  const url = `${SHOPEE_HOST}${apiPath}?${params.toString()}`;
  const res = await fetch(url);
  const json = await res.json();
  console.log(`[Shopee API] GET ${apiPath} (item_id=${itemId}) -> HTTP ${res.status}:`, JSON.stringify(json));
  return json;
}
async function shopeeGetModelListWithRetry(shopId, accessToken, itemId, retries = 2) {
  let last = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 500 * attempt));
    last = await shopeeGetModelList(shopId, accessToken, itemId);
    if (!last?.error) return last;
  }
  return last;
}
async function shopeeUpdateStock(shopId, accessToken, itemId, stockList) {
  const apiPath = "/api/v2/product/update_stock";
  const timestamp = Math.floor(Date.now() / 1e3);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);
  const url = `${SHOPEE_HOST}${apiPath}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&access_token=${accessToken}&shop_id=${shopId}&sign=${sign}`;
  const body = { item_id: itemId, stock_list: stockList };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const json = await res.json();
  console.log(`[Shopee API] POST ${apiPath} (item_id=${itemId}) -> HTTP ${res.status}:`, JSON.stringify(json));
  return json;
}
async function shopeeUpdatePrice(shopId, accessToken, itemId, priceList) {
  const apiPath = "/api/v2/product/update_price";
  const timestamp = Math.floor(Date.now() / 1e3);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);
  const url = `${SHOPEE_HOST}${apiPath}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&access_token=${accessToken}&shop_id=${shopId}&sign=${sign}`;
  const body = { item_id: itemId, price_list: priceList };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const json = await res.json();
  console.log(`[Shopee API] POST ${apiPath} (item_id=${itemId}) -> HTTP ${res.status}:`, JSON.stringify(json));
  return json;
}
function parseShopeeApiResult(result, product, action) {
  const failures = result?.response?.failure_list || [];
  if (result?.error) {
    return {
      productId: product.id,
      sku: product.sku,
      channel: "shopee",
      action,
      success: false,
      message: `${result.error}${result.message ? ` \u2014 ${result.message}` : ""}`
    };
  }
  if (failures.length > 0) {
    const f = failures[0];
    return {
      productId: product.id,
      sku: product.sku,
      channel: "shopee",
      action,
      success: false,
      message: String(f.failed_reason || f.error || JSON.stringify(f))
    };
  }
  return {
    productId: product.id,
    sku: product.sku,
    channel: "shopee",
    action,
    success: true,
    message: `C\u1EADp nh\u1EADt ${action} Shopee th\xE0nh c\xF4ng`
  };
}
async function syncProductToShopee(product, shopId, accessToken) {
  const itemId = Number(product.shopeeItemId);
  if (!Number.isFinite(itemId)) {
    const base = {
      productId: product.id,
      sku: product.sku,
      channel: "shopee",
      success: false,
      message: "Thi\u1EBFu shopeeItemId \u2014 SKU ch\u01B0a li\xEAn k\u1EBFt Shopee"
    };
    return [
      { ...base, action: "update_stock" },
      { ...base, action: "update_price" }
    ];
  }
  const stockEntry = {
    seller_stock: [{ stock: Math.max(0, Math.round(Number(product.stock) || 0)) }]
  };
  const priceEntry = {
    original_price: Math.max(0, Math.round(Number(product.sellingPrice) || 0))
  };
  if (product.shopeeModelId) {
    stockEntry.model_id = Number(product.shopeeModelId);
    priceEntry.model_id = Number(product.shopeeModelId);
  }
  const stockResult = await shopeeUpdateStock(shopId, accessToken, itemId, [stockEntry]);
  await new Promise((r) => setTimeout(r, 120));
  const priceResult = await shopeeUpdatePrice(shopId, accessToken, itemId, [priceEntry]);
  return [
    parseShopeeApiResult(stockResult, product, "update_stock"),
    parseShopeeApiResult(priceResult, product, "update_price")
  ];
}
async function syncProductToWoo(product, shop) {
  const base = {
    productId: product.id,
    sku: product.sku,
    channel: "woocommerce",
    action: "update_product"
  };
  if (!shop?.wooUrl || !shop?.apiKey) {
    return [{ ...base, success: false, message: "Ch\u01B0a c\u1EA5u h\xECnh WooCommerce (URL/API Key)" }];
  }
  if (!product.wooId) {
    return [{ ...base, success: false, message: "Thi\u1EBFu wooId \u2014 SKU ch\u01B0a li\xEAn k\u1EBFt WooCommerce" }];
  }
  const baseUrl = String(shop.wooUrl).replace(/\/$/, "");
  const url = `${baseUrl}/wp-json/wc/v3/products/${product.wooId}`;
  const auth = Buffer.from(`${shop.apiKey}:${shop.apiSecret || ""}`).toString("base64");
  try {
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        regular_price: String(Math.round(Number(product.sellingPrice) || 0)),
        stock_quantity: Math.max(0, Math.round(Number(product.stock) || 0)),
        manage_stock: true
      })
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const errMsg = json?.message || json?.code || `HTTP ${res.status}`;
      return [{ ...base, success: false, message: `WooCommerce t\u1EEB ch\u1ED1i: ${errMsg}` }];
    }
    return [{ ...base, success: true, message: `C\u1EADp nh\u1EADt gi\xE1 & t\u1ED3n kho WooCommerce th\xE0nh c\xF4ng (ID: ${product.wooId})` }];
  } catch (e) {
    return [{ ...base, success: false, message: `L\u1ED7i k\u1EBFt n\u1ED1i WooCommerce: ${e?.message || "network error"}` }];
  }
}
async function syncProductToTikTok(product) {
  const base = {
    productId: product.id,
    sku: product.sku,
    channel: "tiktok",
    action: "update_product"
  };
  if (!product.tiktokId) {
    return [{ ...base, success: false, message: "Thi\u1EBFu tiktokId \u2014 SKU ch\u01B0a li\xEAn k\u1EBFt TikTok Shop" }];
  }
  return [{ ...base, success: false, message: "API TikTok Shop ch\u01B0a \u0111\u01B0\u1EE3c t\xEDch h\u1EE3p tr\xEAn server" }];
}
async function pushStockUpdatesToShopee(updatedProducts, requestedShopId) {
  const shopeeRows = updatedProducts.filter((p) => p.shopeeItemId);
  if (shopeeRows.length === 0) {
    return { ok: true, errors: [], pushed: 0 };
  }
  const shopId = resolveShopeeTokenShopId(requestedShopId);
  if (!shopId) {
    return { ok: false, errors: ["Ch\u01B0a c\xF3 shop Shopee \u0111\u01B0\u1EE3c \u1EE7y quy\u1EC1n."], pushed: 0 };
  }
  const accessToken = await getValidShopeeAccessToken(shopId);
  if (!accessToken) {
    return { ok: false, errors: [`Ch\u01B0a c\xF3 access_token h\u1EE3p l\u1EC7 cho shop_id=${shopId}.`], pushed: 0 };
  }
  const byItem = /* @__PURE__ */ new Map();
  for (const p of shopeeRows) {
    const itemId = Number(p.shopeeItemId);
    if (!Number.isFinite(itemId)) continue;
    if (!byItem.has(itemId)) byItem.set(itemId, []);
    byItem.get(itemId).push(p);
  }
  const errors = [];
  let pushed = 0;
  for (const [itemId, rows] of byItem) {
    const stockList = rows.map((p) => {
      const entry = {
        seller_stock: [{ stock: Math.max(0, Math.round(Number(p.stock) || 0)) }]
      };
      if (p.shopeeModelId) entry.model_id = Number(p.shopeeModelId);
      return entry;
    });
    const result = await shopeeUpdateStock(shopId, accessToken, itemId, stockList);
    const failures = result?.response?.failure_list || result?.response?.stock_list?.filter?.((s) => s.failed_reason) || [];
    if (result?.error) {
      const skus = rows.map((r) => r.sku).join(", ");
      errors.push(`item_id=${itemId} (SKU: ${skus}): ${result.error}${result.message ? ` \u2014 ${result.message}` : ""}`);
    }
    if (Array.isArray(failures) && failures.length > 0) {
      for (const f of failures) {
        if (f.failed_reason || f.error) {
          errors.push(`item_id=${itemId} model_id=${f.model_id ?? "?"}: ${f.failed_reason || f.error}`);
        }
      }
    }
    if (!result?.error && (!failures.length || failures.every((f) => !f.failed_reason && !f.error))) {
      pushed += rows.length;
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  return { ok: errors.length === 0, errors, pushed };
}
function getItemAvatarUrl(item) {
  const list = item?.image?.image_url_list;
  return Array.isArray(list) && list.length > 0 ? String(list[0]) : void 0;
}
function resolveShopeeTokenShopId(requested) {
  const tokens = loadShopeeTokens();
  const keys = Object.keys(tokens);
  if (!keys.length) return null;
  const req = String(requested || "").trim();
  if (req && tokens[req]) return req;
  if (req) {
    const digits = req.match(/(\d{5,})/)?.[1];
    if (digits && tokens[digits]) return digits;
  }
  return keys[0];
}
function parseModelListFromResponse(modelResult) {
  const resp = modelResult?.response || {};
  return {
    tierVariations: resp.tier_variation || resp.standardise_tier_variation || [],
    models: resp.model || resp.model_list || []
  };
}
function getModelDisplayName(model, tierVariations) {
  if (model?.model_name) return String(model.model_name).trim();
  const tierIndex = Array.isArray(model?.tier_index) ? model.tier_index : [];
  const parts = [];
  tierIndex.forEach((optIdx, tierPos) => {
    const tier = tierVariations?.[tierPos];
    let opt = tier?.option_list?.[optIdx]?.option;
    if (!opt && tier?.variation_option_list?.[optIdx]?.variation_option_name) {
      opt = tier.variation_option_list[optIdx].variation_option_name;
    }
    if (!opt && Array.isArray(tier?.options)) opt = tier.options[optIdx];
    if (opt) parts.push(String(opt).trim());
  });
  if (parts.length > 0) return parts.join(" / ");
  const sku = String(model?.model_sku || "").trim();
  if (sku) return sku;
  return model?.model_id != null ? `Ph\xE2n lo\u1EA1i #${model.model_id}` : "Ph\xE2n lo\u1EA1i";
}
function parseModelStock(model) {
  const s2 = model?.stock_info_v2;
  if (s2?.seller_stock?.[0]?.stock != null) return Math.max(0, Number(s2.seller_stock[0].stock) || 0);
  if (s2?.summary_info?.total_available_stock != null) return Math.max(0, Number(s2.summary_info.total_available_stock) || 0);
  if (model?.stock != null) return Math.max(0, Number(model.stock) || 0);
  if (model?.normal_stock != null) return Math.max(0, Number(model.normal_stock) || 0);
  return Math.max(0, Number(model?.stock_info?.[0]?.current_stock) || 0);
}
function parseModelPrice(model) {
  const pi = model?.price_info;
  if (Array.isArray(pi) && pi.length > 0) {
    return Math.max(0, Number(pi[0].current_price ?? pi[0].original_price) || 0);
  }
  if (pi && typeof pi === "object") {
    return Math.max(0, Number(pi.current_price ?? pi.original_price) || 0);
  }
  return Math.max(0, Number(model?.price) || 0);
}
function buildSingleWarehouseRow(item) {
  const itemId = item.item_id;
  const avatarUrl = getItemAvatarUrl(item);
  const sku = String(item.item_sku || "").trim() || String(itemId);
  const stock = Number(item.stock_info_v2?.summary_info?.total_available_stock) || 0;
  const price = Number(item.price_info?.[0]?.current_price ?? item.price_info?.[0]?.original_price) || 0;
  return {
    id: `shopee-item-${itemId}`,
    title: item.item_name || `S\u1EA3n ph\u1EA9m Shopee ${itemId}`,
    sku,
    barcode: sku,
    category: item.category_id ? String(item.category_id) : "Ch\u01B0a ph\xE2n lo\u1EA1i",
    stock,
    importPrice: 0,
    sellingPrice: price,
    channels: ["shopee"],
    imageUrl: avatarUrl,
    avatarUrl,
    description: item.description || "",
    status: item.item_status !== "NORMAL" ? "draft" : stock > 0 ? "active" : "out_of_stock",
    shopeeId: String(itemId),
    shopeeItemId: String(itemId),
    lastSynced: (/* @__PURE__ */ new Date()).toISOString()
  };
}
function getModelImageUrl(item, model, tierVariations) {
  const tierIndex = Array.isArray(model?.tier_index) ? model.tier_index : [];
  for (let tierPos = 0; tierPos < tierIndex.length; tierPos++) {
    const optIdx = tierIndex[tierPos];
    const tier = tierVariations?.[tierPos];
    const opt = tier?.option_list?.[optIdx] || tier?.variation_option_list?.[optIdx];
    const url = opt?.image?.image_url || opt?.image_url;
    if (url) return url;
  }
  return getItemAvatarUrl(item);
}
function buildVariantWarehouseRow(item, model, tierVariations, modelIndex) {
  const itemId = item.item_id;
  const modelId = model.model_id != null ? model.model_id : `idx${modelIndex}`;
  const modelName = getModelDisplayName(model, tierVariations);
  const baseName = item.item_name || `S\u1EA3n ph\u1EA9m Shopee ${itemId}`;
  const avatarUrl = getModelImageUrl(item, model, tierVariations);
  const parentSku = String(item.item_sku || "").trim() || void 0;
  const sku = String(model.model_sku || "").trim() || `${itemId}-M${modelId}`;
  const stock = parseModelStock(model);
  const price = parseModelPrice(model);
  return {
    id: `shopee-item-${itemId}-model-${modelId}`,
    title: `${baseName} - ${modelName}`,
    sku,
    barcode: sku,
    modelName,
    parentSku,
    category: item.category_id ? String(item.category_id) : "Ch\u01B0a ph\xE2n lo\u1EA1i",
    stock,
    importPrice: 0,
    sellingPrice: price,
    channels: ["shopee"],
    imageUrl: avatarUrl,
    avatarUrl,
    description: item.description || "",
    status: item.item_status !== "NORMAL" ? "draft" : stock > 0 ? "active" : "out_of_stock",
    shopeeId: `${itemId}:${modelId}`,
    shopeeItemId: String(itemId),
    shopeeModelId: String(modelId),
    tierLabels: model.tier_index?.map(
      (optIdx, tierPos) => tierVariations?.[tierPos]?.option_list?.[optIdx]?.option
    ).filter(Boolean),
    lastSynced: (/* @__PURE__ */ new Date()).toISOString()
  };
}
async function syncShopeeItemToWarehouseRows(shopId, accessToken, item, opts) {
  const inlineModels = Array.isArray(item?.model_list) ? item.model_list : Array.isArray(item?.model) ? item.model : [];
  const inlineTiers = item?.tier_variation || item?.standardise_tier_variation || [];
  let tierVariations = inlineTiers;
  let models = inlineModels;
  if (models.length > 0) {
    const rows = models.map((model, idx) => buildVariantWarehouseRow(item, model, tierVariations, idx));
    console.log(`[Shopee Sync] item_id=${item.item_id} -> ${rows.length} phan loai`);
    return { rows, modelCount: rows.length };
  }
  if (item?.has_model === false) {
    return { rows: [buildSingleWarehouseRow(item)], modelCount: 0 };
  }
  const modelResult = await shopeeGetModelListWithRetry(shopId, accessToken, item.item_id, 3);
  if (modelResult?.error) {
    const err = `${modelResult.error}${modelResult.message ? `: ${modelResult.message}` : ""}`;
    console.error(`[Shopee Sync] get_model_list item_id=${item.item_id}: ${err}`);
    if (opts?.strict) return { rows: [], modelCount: 0, error: err };
    return { rows: [buildSingleWarehouseRow(item)], modelCount: 0, error: err };
  }
  const parsed = parseModelListFromResponse(modelResult);
  tierVariations = parsed.tierVariations;
  models = parsed.models;
  if (models.length > 0) {
    const rows = models.map((model, idx) => buildVariantWarehouseRow(item, model, tierVariations, idx));
    console.log(`[Shopee Sync] item_id=${item.item_id} -> ${rows.length} phan loai (get_model_list)`);
    return { rows, modelCount: rows.length };
  }
  return { rows: [buildSingleWarehouseRow(item)], modelCount: 0 };
}
async function fetchAllShopeeItemIds(shopId, accessToken) {
  const allItemIds = [];
  let offset = 0;
  let hasNext = true;
  let pageGuard = 0;
  while (hasNext && pageGuard < 100) {
    const listResult = await shopeeGetItemList(shopId, accessToken, offset);
    if (listResult.error) throw new Error(`${listResult.error}: ${listResult.message || ""}`);
    const items = listResult.response?.item || [];
    allItemIds.push(...items.map((it) => it.item_id));
    hasNext = !!listResult.response?.has_next_page && items.length > 0;
    offset = listResult.response?.next_offset ?? offset + items.length;
    pageGuard++;
  }
  return allItemIds;
}
async function fetchShopeeBaseItemsByIds(shopId, accessToken, itemIds) {
  const allItems = [];
  for (let i = 0; i < itemIds.length; i += 50) {
    const batch = itemIds.slice(i, i + 50);
    const baseInfoResult = await shopeeGetItemBaseInfo(shopId, accessToken, batch);
    if (baseInfoResult.error) {
      console.error(`[Shopee Sync] get_item_base_info batch ${i}: ${baseInfoResult.error}`);
      continue;
    }
    allItems.push(...baseInfoResult.response?.item_list || []);
  }
  return allItems;
}
async function runFullShopeeWarehouseSync(shopId, accessToken) {
  const itemIds = await fetchAllShopeeItemIds(shopId, accessToken);
  console.log(`[Shopee Product Sync] get_item_list: ${itemIds.length} item_id`);
  const allItems = await fetchShopeeBaseItemsByIds(shopId, accessToken, itemIds);
  console.log(`[Shopee Product Sync] get_item_base_info: ${allItems.length} item`);
  const products = [];
  const EXPAND_CONCURRENCY = 6;
  const startedAt = Date.now();
  let variantItems = 0;
  for (let i = 0; i < allItems.length; i += EXPAND_CONCURRENCY) {
    const chunk = allItems.slice(i, i + EXPAND_CONCURRENCY);
    const results = await Promise.all(
      chunk.map((item) => syncShopeeItemToWarehouseRows(shopId, accessToken, item))
    );
    results.forEach((r) => {
      if (r.modelCount > 0) variantItems++;
      products.push(...r.rows);
    });
    if (i % 30 === 0 || i + EXPAND_CONCURRENCY >= allItems.length) {
      console.log(`[Shopee Product Sync] ${Math.min(i + EXPAND_CONCURRENCY, allItems.length)}/${allItems.length} item -> ${products.length} dong kho`);
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  const cleaned = dedupeShopeeParentVariantRows(products);
  saveProducts(cleaned);
  console.log(`[Shopee Product Sync] HOAN TAT ${allItems.length} item -> ${cleaned.length} dong (${variantItems} co phan loai) ${Date.now() - startedAt}ms`);
  return {
    shopId,
    products: cleaned,
    stats: {
      itemCount: allItems.length,
      rowCount: cleaned.length,
      variantItemCount: variantItems
    }
  };
}
async function fetchShopeeItemVariants(shopId, accessToken, itemId) {
  const baseInfoResult = await shopeeGetItemBaseInfo(shopId, accessToken, [itemId]);
  if (baseInfoResult.error) {
    return { item: null, variantProducts: [], modelCount: 0, error: `${baseInfoResult.error}: ${baseInfoResult.message}` };
  }
  const item = baseInfoResult.response?.item_list?.[0];
  if (!item) {
    return { item: null, variantProducts: [], modelCount: 0, error: "item_not_found" };
  }
  const { rows, modelCount, error } = await syncShopeeItemToWarehouseRows(shopId, accessToken, item, { strict: true });
  if (error && rows.length === 0) {
    return { item, variantProducts: [], modelCount: 0, error };
  }
  return { item, variantProducts: rows, modelCount, error };
}
function mergeShopeeRowPreservingLocal(existing, incoming) {
  if (!existing) return incoming;
  return {
    ...existing,
    ...incoming,
    importPrice: existing.importPrice ?? incoming.importPrice,
    wholesalePrice: existing.wholesalePrice ?? incoming.wholesalePrice,
    weight: existing.weight ?? incoming.weight,
    unit: existing.unit ?? incoming.unit,
    description: existing.description || incoming.description
  };
}
function replaceProductsForShopeeItem(products, itemId, variantProducts) {
  const key = String(itemId);
  const byId = new Map(products.map((p) => [p.id, p]));
  const without = products.filter((p) => {
    const pItemId = p.shopeeItemId || String(p.id || "").match(/^shopee-item-(\d+)/)?.[1];
    return String(pItemId) !== key;
  });
  const mergedVariants = variantProducts.map(
    (row) => mergeShopeeRowPreservingLocal(byId.get(row.id), row)
  );
  return [...mergedVariants, ...without];
}
function dedupeShopeeParentVariantRows(products) {
  const groups = /* @__PURE__ */ new Map();
  for (const p of products) {
    const itemId = p.shopeeItemId || String(p.id || "").match(/^shopee-item-(\d+)/)?.[1];
    if (!itemId) continue;
    if (!groups.has(itemId)) groups.set(itemId, []);
    groups.get(itemId).push(p);
  }
  const removeIds = /* @__PURE__ */ new Set();
  for (const group of groups.values()) {
    const hasVariantChild = group.some(
      (p) => p.shopeeModelId || String(p.id).includes("-model-")
    );
    if (!hasVariantChild) continue;
    for (const p of group) {
      if (/^shopee-item-\d+$/.test(String(p.id))) removeIds.add(p.id);
    }
  }
  return removeIds.size > 0 ? products.filter((p) => !removeIds.has(p.id)) : products;
}
async function shopeeGetShippingParameter(shopId, accessToken, orderSn, packageNumber) {
  const apiPath = "/api/v2/logistics/get_shipping_parameter";
  const timestamp = Math.floor(Date.now() / 1e3);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);
  const params = new URLSearchParams({
    partner_id: SHOPEE_PARTNER_ID,
    timestamp: String(timestamp),
    access_token: accessToken,
    shop_id: shopId,
    sign,
    order_sn: orderSn
  });
  if (packageNumber) params.set("package_number", packageNumber);
  const url = `${SHOPEE_HOST}${apiPath}?${params.toString()}`;
  const res = await fetch(url);
  const json = await res.json();
  console.log(`[Shopee API] GET ${apiPath} (order_sn=${orderSn}) -> HTTP ${res.status}:`, JSON.stringify(json));
  return json;
}
async function shopeeShipOrder(shopId, accessToken, orderSn, shipmentBody) {
  const apiPath = "/api/v2/logistics/ship_order";
  const timestamp = Math.floor(Date.now() / 1e3);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);
  const url = `${SHOPEE_HOST}${apiPath}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&access_token=${accessToken}&shop_id=${shopId}&sign=${sign}`;
  const body = { order_sn: orderSn, ...shipmentBody };
  delete body.package_number;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const json = await res.json();
  console.log(`[Shopee API] POST ${apiPath} (order_sn=${orderSn}) body=${JSON.stringify(body)} -> HTTP ${res.status}:`, JSON.stringify(json));
  return json;
}
async function shipShopeeOrderReal(order, method) {
  const shopId = resolveOrderShopId(order);
  if (!shopId) {
    return { success: false, error: "missing_shop_id", message: "\u0110\u01A1n h\xE0ng thi\u1EBFu shop_id, kh\xF4ng x\xE1c \u0111\u1ECBnh \u0111\u01B0\u1EE3c shop Shopee \u0111\u1EC3 g\u1ECDi API." };
  }
  const accessToken = await getValidShopeeAccessToken(shopId);
  if (!accessToken) {
    return { success: false, error: "no_valid_access_token", message: `Ch\u01B0a c\xF3 access_token h\u1EE3p l\u1EC7 cho shop_id=${shopId}. C\u1EA7n \u1EE7y quy\u1EC1n l\u1EA1i qua /api/shopee/callback.` };
  }
  const paramResult = await shopeeGetShippingParameter(shopId, accessToken, order.orderSn);
  console.log(`D\u1EEE LI\u1EC6U SHOPEE TR\u1EA2 V\u1EC0 (get_shipping_parameter) - \u0111\u01A1n ${order.orderSn}:`, JSON.stringify(paramResult));
  if (paramResult.error) {
    console.error(`[Shopee L\u1ED6I] get_shipping_parameter th\u1EA5t b\u1EA1i cho \u0111\u01A1n ${order.orderSn} -> error="${paramResult.error}" message="${paramResult.message}"`);
    return { success: false, error: paramResult.error, message: paramResult.message };
  }
  const infoNeeded = paramResult.response?.info_needed || {};
  let shipmentBody = {};
  if (method === "dropoff") {
    if (!Object.prototype.hasOwnProperty.call(infoNeeded, "dropoff")) {
      console.error(`[Shopee L\u1ED6I] \u0110\u01A1n ${order.orderSn} kh\xF4ng h\u1ED7 tr\u1EE3 dropoff. info_needed=${JSON.stringify(infoNeeded)}`);
      return { success: false, error: "dropoff_not_supported", message: '\u0110\u01A1n v\u1ECB v\u1EADn chuy\u1EC3n c\u1EE7a \u0111\u01A1n n\xE0y KH\xD4NG h\u1ED7 tr\u1EE3 h\xECnh th\u1EE9c "T\u1EF1 mang h\xE0ng ra b\u01B0u c\u1EE5c". Vui l\xF2ng ch\u1ECDn "L\u1EA5y h\xE0ng" (pickup) thay th\u1EBF.' };
    }
    const branch = paramResult.response?.dropoff?.branch_list?.[0];
    shipmentBody = { dropoff: branch ? { branch_id: branch.branch_id } : {} };
  } else {
    if (!Object.prototype.hasOwnProperty.call(infoNeeded, "pickup")) {
      console.error(`[Shopee L\u1ED6I] \u0110\u01A1n ${order.orderSn} kh\xF4ng h\u1ED7 tr\u1EE3 pickup. info_needed=${JSON.stringify(infoNeeded)}`);
      return { success: false, error: "pickup_not_supported", message: '\u0110\u01A1n v\u1ECB v\u1EADn chuy\u1EC3n c\u1EE7a \u0111\u01A1n n\xE0y KH\xD4NG h\u1ED7 tr\u1EE3 h\xECnh th\u1EE9c "L\u1EA5y h\xE0ng". Vui l\xF2ng ch\u1ECDn "T\u1EF1 mang h\xE0ng ra b\u01B0u c\u1EE5c" (dropoff) thay th\u1EBF.' };
    }
    const address = paramResult.response?.pickup?.address_list?.[0];
    const timeSlot = address?.time_slot_list?.[0];
    if (!address || !timeSlot) {
      console.error(`[Shopee L\u1ED6I] \u0110\u01A1n ${order.orderSn} kh\xF4ng c\xF3 address/time_slot pickup kh\u1EA3 d\u1EE5ng. pickup=${JSON.stringify(paramResult.response?.pickup)}`);
      return { success: false, error: "no_pickup_slot_available", message: "Shopee kh\xF4ng tr\u1EA3 v\u1EC1 \u0111\u1ECBa ch\u1EC9/l\u1ECBch h\u1EB9n l\u1EA5y h\xE0ng (pickup) kh\u1EA3 d\u1EE5ng cho \u0111\u01A1n n\xE0y." };
    }
    shipmentBody = { pickup: { address_id: address.address_id, pickup_time_id: timeSlot.pickup_time_id } };
  }
  const shipResult = await shopeeShipOrder(shopId, accessToken, order.orderSn, shipmentBody);
  console.log(`D\u1EEE LI\u1EC6U SHOPEE TR\u1EA2 V\u1EC0 (ship_order) - \u0111\u01A1n ${order.orderSn}:`, JSON.stringify(shipResult));
  if (shipResult.error) {
    console.error(`[Shopee L\u1ED6I] ship_order th\u1EA5t b\u1EA1i cho \u0111\u01A1n ${order.orderSn} -> error="${shipResult.error}" message="${shipResult.message}" request_id="${shipResult.request_id || ""}"`);
    return { success: false, error: shipResult.error, message: shipResult.message, mode: method, shopId };
  }
  return { success: true, mode: method, shopId };
}
function arrangeShipmentLocal(order, method) {
  const prefix = order.channel === "tiktok" ? "TTS" : "DIRECT";
  const trackingNumber = order.trackingNumber || `${prefix}-${method === "dropoff" ? "DROPOFF" : "PICKUP"}-${Math.floor(1e7 + Math.random() * 9e7)}`;
  return { success: true, mode: method, trackingNumber };
}
async function arrangeShipment(order, method) {
  if (order.channel === "shopee") {
    return shipShopeeOrderReal(order, method);
  }
  return arrangeShipmentLocal(order, method);
}
var SHOPEE_SHIPPING_DOCUMENT_TYPE = "NORMAL_AIR_WAYBILL";
async function shopeeGetTrackingNumber(shopId, accessToken, orderSn, packageNumber) {
  const apiPath = "/api/v2/logistics/get_tracking_number";
  const timestamp = Math.floor(Date.now() / 1e3);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);
  const params = new URLSearchParams({
    partner_id: SHOPEE_PARTNER_ID,
    timestamp: String(timestamp),
    access_token: accessToken,
    shop_id: shopId,
    sign,
    order_sn: orderSn,
    response_optional_fields: "first_mile_tracking_number,last_mile_tracking_number"
  });
  if (packageNumber) params.set("package_number", packageNumber);
  const url = `${SHOPEE_HOST}${apiPath}?${params.toString()}`;
  const res = await fetch(url);
  const json = await res.json();
  console.log(`[Shopee API] GET ${apiPath} (order_sn=${orderSn}) -> HTTP ${res.status}:`, JSON.stringify(json));
  return json;
}
async function shopeeCreateShippingDocument(shopId, accessToken, orderList) {
  const apiPath = "/api/v2/logistics/create_shipping_document";
  const timestamp = Math.floor(Date.now() / 1e3);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);
  const url = `${SHOPEE_HOST}${apiPath}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&access_token=${accessToken}&shop_id=${shopId}&sign=${sign}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ order_list: orderList, shipping_document_type: SHOPEE_SHIPPING_DOCUMENT_TYPE })
  });
  const json = await res.json();
  console.log(`[Shopee API] POST ${apiPath} (${orderList.length} orders) -> HTTP ${res.status}:`, JSON.stringify(json));
  return json;
}
async function shopeeGetShippingDocumentResult(shopId, accessToken, orderList) {
  const apiPath = "/api/v2/logistics/get_shipping_document_result";
  const timestamp = Math.floor(Date.now() / 1e3);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);
  const url = `${SHOPEE_HOST}${apiPath}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&access_token=${accessToken}&shop_id=${shopId}&sign=${sign}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ order_list: orderList, shipping_document_type: SHOPEE_SHIPPING_DOCUMENT_TYPE })
  });
  const json = await res.json();
  console.log(`[Shopee API] POST ${apiPath} -> HTTP ${res.status}:`, JSON.stringify(json));
  return json;
}
async function shopeeDownloadShippingDocument(shopId, accessToken, orderList) {
  const apiPath = "/api/v2/logistics/download_shipping_document";
  const timestamp = Math.floor(Date.now() / 1e3);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);
  const url = `${SHOPEE_HOST}${apiPath}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&access_token=${accessToken}&shop_id=${shopId}&sign=${sign}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ order_list: orderList, shipping_document_type: SHOPEE_SHIPPING_DOCUMENT_TYPE })
  });
  const contentType = res.headers.get("content-type") || "";
  console.log(`[Shopee API] POST ${apiPath} (${orderList.length} orders) -> HTTP ${res.status}, content-type=${contentType}`);
  if (contentType.includes("application/json")) {
    const json = await res.json();
    console.log(`[Shopee API] ${apiPath} tr\u1EA3 v\u1EC1 l\u1ED7i JSON (kh\xF4ng c\xF3 file):`, JSON.stringify(json));
    return { error: json.error || "download_failed", message: json.message || "Shopee kh\xF4ng tr\u1EA3 v\u1EC1 file v\u1EAD n \u0111\u01A1n." };
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, contentType: contentType || "application/pdf" };
}
function extractShopeeOrderModelName(it) {
  const directCandidates = [
    it.model_name,
    it.variation_name,
    it.model_display_name,
    it.item_model_name,
    it.sku_model_name
  ];
  for (const c of directCandidates) {
    const s = String(c || "").trim();
    if (s) return s;
  }
  const tierParts = [];
  const tierSources = [
    it.model_tier_variation,
    it.tier_variation,
    it.standardise_tier_variation
  ];
  for (const src of tierSources) {
    if (!Array.isArray(src)) continue;
    for (const tier of src) {
      if (typeof tier === "string" && tier.trim()) tierParts.push(tier.trim());
      else if (tier?.option) tierParts.push(String(tier.option).trim());
      else if (tier?.variation_option_name) tierParts.push(String(tier.variation_option_name).trim());
    }
  }
  if (tierParts.length > 0) return tierParts.join(" / ");
  if (Array.isArray(it.variation_list)) {
    const parts = it.variation_list.map((v) => String(v?.variation_name || v?.option || v?.name || "").trim()).filter(Boolean);
    if (parts.length > 0) return parts.join(" / ");
  }
  return void 0;
}
function extractShopeeOrderModelId(it) {
  const candidates = [it.model_id, it.variation_id, it.modelId, it.variationId];
  for (const raw of candidates) {
    if (raw != null && raw !== "" && Number(raw) !== 0) {
      return String(raw);
    }
  }
  return "0";
}
function extractShopeeOrderModelSku(it) {
  const candidates = [
    it.model_sku,
    it.variation_sku,
    it.item_sku,
    it.sku,
    it.modelSku,
    it.variationSku
  ];
  for (const raw of candidates) {
    const s = String(raw || "").trim();
    if (s) return s;
  }
  return void 0;
}
function mapShopeeOrderLineItem(it) {
  const itemId = String(it.item_id || "");
  const modelId = extractShopeeOrderModelId(it);
  const modelSku = extractShopeeOrderModelSku(it);
  const modelName = extractShopeeOrderModelName(it);
  const itemName = String(it.item_name || "S\u1EA3n ph\u1EA9m Shopee").trim();
  const productTitle = modelName ? `${itemName} - ${modelName}` : itemName;
  const productImage = it.image_info?.image_url || it.image_url || it.variation_image_url || void 0;
  return {
    productId: itemId,
    productTitle,
    productImage,
    quantity: Number(it.model_quantity_purchased || it.model_quantity || it.quantity || 1),
    price: Number(it.model_discounted_price || it.model_original_price || it.item_price || 0),
    modelId: modelId === "0" ? void 0 : modelId,
    modelSku,
    modelName
  };
}
function isShopeeInternalTrackingCode(code) {
  return /^0FG/i.test(String(code || "").trim());
}
function isCarrierTrackingCode(code) {
  const k = String(code || "").trim().toUpperCase();
  if (!k || isShopeeInternalTrackingCode(k)) return false;
  return /^(SPX(VN)?|GHN|GHTK|JNT|JT|NINJA|VTP|VNPOST|LEX|NJV|GRB|MY|SG|TH|ID|PH)/.test(k);
}
function applyShopeeTrackingCode(order, rawCode) {
  const code = String(rawCode || "").trim();
  if (!code) return;
  if (isCarrierTrackingCode(code)) {
    order.trackingNumber = code;
    return;
  }
  if (isShopeeInternalTrackingCode(code)) {
    order.internalTrackingCode = code;
    return;
  }
  if (isCarrierTrackingCode(code)) {
    order.trackingNumber = code;
  }
}
function repairMisassignedTracking(order) {
  if (!order || typeof order !== "object") return order;
  if (order.trackingNumber && isShopeeInternalTrackingCode(order.trackingNumber)) {
    if (!order.internalTrackingCode) order.internalTrackingCode = order.trackingNumber;
    order.trackingNumber = void 0;
  }
  return order;
}
function mergeShopeeTrackingFields(merged, existing, incoming) {
  repairMisassignedTracking(merged);
  const pickCarrier = (...candidates) => {
    for (const c of candidates) {
      const s = String(c || "").trim();
      if (s && isCarrierTrackingCode(s)) return s;
    }
    return void 0;
  };
  const pickInternal = (...candidates) => {
    for (const c of candidates) {
      const s = String(c || "").trim();
      if (s && isShopeeInternalTrackingCode(s)) return s;
    }
    return void 0;
  };
  merged.trackingNumber = pickCarrier(
    incoming.trackingNumber,
    existing.trackingNumber,
    incoming.lastMileTrackingNumber,
    existing.lastMileTrackingNumber
  );
  merged.internalTrackingCode = pickInternal(
    incoming.internalTrackingCode,
    existing.internalTrackingCode,
    incoming.trackingNumber,
    existing.trackingNumber,
    incoming.firstMileTrackingNumber,
    existing.firstMileTrackingNumber
  );
}
function applyShopeeGetTrackingResponse(order, trackResult) {
  const resp = trackResult?.response;
  if (!resp) return;
  if (resp.tracking_number) applyShopeeTrackingCode(order, resp.tracking_number);
  if (resp.last_mile_tracking_number) applyShopeeTrackingCode(order, resp.last_mile_tracking_number);
  if (resp.first_mile_tracking_number) {
    if (isShopeeInternalTrackingCode(resp.first_mile_tracking_number)) {
      order.internalTrackingCode = resp.first_mile_tracking_number;
    } else {
      applyShopeeTrackingCode(order, resp.first_mile_tracking_number);
    }
  }
  repairMisassignedTracking(order);
}
function trackingForShopeeShippingDoc(order) {
  return order.trackingNumber || order.internalTrackingCode || void 0;
}
function needsShopeeTrackingEnrichment(order) {
  if (order.channel !== "shopee") return false;
  const status = String(order.status || "");
  if (!["processed", "shipping", "completed", "return_pending"].includes(status)) return false;
  if (order.trackingNumber && isCarrierTrackingCode(order.trackingNumber)) return false;
  return true;
}
async function enrichShopeeOrderTrackingFromApi(shopId, accessToken, order) {
  repairMisassignedTracking(order);
  if (!needsShopeeTrackingEnrichment(order)) return order;
  try {
    const result = await shopeeGetTrackingNumber(shopId, accessToken, order.orderSn, order.packageNumber);
    applyShopeeGetTrackingResponse(order, result);
  } catch (err) {
    console.warn(`[Shopee Tracking] enrich ${order.orderSn} failed:`, err);
  }
  return order;
}
function normalizeShopeeOrderDetail(shopId, shopName, item) {
  const statusMap = {
    UNPAID: "pending_confirm",
    READY_TO_SHIP: "unprocessed",
    PROCESSED: "processed",
    RETRY_SHIP: "unprocessed",
    SHIPPED: "shipping",
    TO_CONFIRM_RECEIVE: "shipping",
    IN_CANCEL: "cancelled",
    CANCELLED: "cancelled",
    TO_RETURN: "return_pending",
    COMPLETED: "completed"
  };
  const rawStatus = String(item.order_status || "READY_TO_SHIP").toUpperCase();
  const pkg = item.package_list?.[0];
  const order = {
    id: `shopee-${item.order_sn}`,
    orderSn: String(item.order_sn),
    channel: "shopee",
    shopId: String(shopId),
    shopName: shopName || "Shopee Shop",
    totalAmount: Number(item.total_amount || 0),
    revenue: Number(item.total_amount || 0) * 0.88,
    status: statusMap[rawStatus] || "unprocessed",
    date: item.create_time ? new Date(item.create_time * 1e3).toISOString() : (/* @__PURE__ */ new Date()).toISOString(),
    packageNumber: pkg?.package_number || void 0,
    isPrepared: rawStatus === "PROCESSED" || rawStatus === "SHIPPED" || rawStatus === "TO_CONFIRM_RECEIVE",
    isPrinted: false,
    items: Array.isArray(item.item_list) ? item.item_list.map((it) => mapShopeeOrderLineItem(it)) : []
  };
  if (pkg?.tracking_number) applyShopeeTrackingCode(order, pkg.tracking_number);
  repairMisassignedTracking(order);
  return order;
}
function orderItemsHaveVariationData(items) {
  return Array.isArray(items) && items.some((i) => i?.modelId || i?.modelName || i?.modelSku);
}
function mergeShopeeOrderOnSync(existing, incoming) {
  if (!existing) return incoming;
  const merged = { ...existing, ...incoming, id: existing.id };
  merged.status = incoming.status;
  merged.isPrepared = incoming.status === "processed" || incoming.status === "shipping";
  merged.isPrinted = Boolean(existing.isPrinted);
  const incomingItems = Array.isArray(incoming.items) ? incoming.items : [];
  const existingItems = Array.isArray(existing.items) ? existing.items : [];
  if (incomingItems.length > 0) {
    if (orderItemsHaveVariationData(incomingItems) || !existingItems.length || !orderItemsHaveVariationData(existingItems)) {
      merged.items = incomingItems;
    } else {
      merged.items = existingItems;
    }
  } else if (existingItems.length) {
    merged.items = existingItems;
  }
  if (!incoming.packageNumber && existing.packageNumber) {
    merged.packageNumber = existing.packageNumber;
  }
  if (!incoming.shopId && existing.shopId) {
    merged.shopId = existing.shopId;
  }
  mergeShopeeTrackingFields(merged, existing, incoming);
  delete merged.customerName;
  delete merged.customerPhone;
  delete merged.customerAddress;
  return merged;
}
var SHOPEE_SYNC_STATUSES = ["READY_TO_SHIP", "PROCESSED", "RETRY_SHIP", "SHIPPED"];
var SHOPEE_SYNC_UI_STATUSES = /* @__PURE__ */ new Set(["pending_confirm", "unprocessed", "processed", "shipping"]);
async function syncShopeeOrdersFromApi(statuses = [...SHOPEE_SYNC_STATUSES]) {
  const tokens = loadShopeeTokens();
  const shopIds = Object.keys(tokens);
  let orders = loadOrders();
  let syncedCount = 0;
  let addedCount = 0;
  let updatedCount = 0;
  const errors = [];
  const statusCounts = {};
  const dedupeErrors = (list) => {
    const seen = /* @__PURE__ */ new Set();
    return list.filter((e) => {
      const k = `${e.shopId}:${e.error}:${e.message || ""}:${e.status || ""}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };
  for (const shopKey of shopIds) {
    let auth = await getShopeeAccessTokenForApi(shopKey);
    if (!auth) {
      errors.push({
        shopId: shopKey,
        error: "no_valid_access_token",
        message: "Token h\u1EBFt h\u1EA1n ho\u1EB7c refresh th\u1EA5t b\u1EA1i \u2014 h\xE3y OAuth l\u1EA1i shop tr\xEAn C\xE0i \u0111\u1EB7t."
      });
      continue;
    }
    const runShopPull = async (accessToken, apiShopId, fileKey) => {
      const shopErrors = [];
      const orderSnSet = /* @__PURE__ */ new Set();
      for (const status of statuses) {
        try {
          const sns = await shopeeFetchAllOrderSnsByStatus(apiShopId, accessToken, status);
          sns.forEach((sn) => orderSnSet.add(sn));
          statusCounts[`${fileKey}:${status}`] = sns.length;
          console.log(`[Shopee Sync] Shop ${fileKey} (api=${apiShopId}) / ${status}: ${sns.length} \u0111\u01A1n.`);
        } catch (statusErr) {
          const errMsg = statusErr?.message || String(statusErr);
          console.error(`[Shopee Sync] Shop ${fileKey} / ${status} l\u1ED7i:`, errMsg);
          shopErrors.push({ shopId: fileKey, status, error: statusErr?.error || "shopee_api_error", message: errMsg });
        }
      }
      const orderSnList = Array.from(orderSnSet);
      const syncedForShop = [];
      for (let i = 0; i < orderSnList.length; i += 50) {
        const batch = orderSnList.slice(i, i + 50);
        const detailResult = await shopeeGetOrderDetail(apiShopId, accessToken, batch);
        if (detailResult.error) {
          shopErrors.push({
            shopId: fileKey,
            error: detailResult.error,
            message: detailResult.message,
            batch: batch.length
          });
          continue;
        }
        const detailList = detailResult.response?.order_list || [];
        for (const detail of detailList) {
          let normalized = normalizeShopeeOrderDetail(fileKey, detail.shop_name, detail);
          if (needsShopeeTrackingEnrichment(normalized)) {
            normalized = await enrichShopeeOrderTrackingFromApi(apiShopId, accessToken, normalized);
          }
          syncedForShop.push(normalized);
        }
      }
      return { shopErrors, orderSnList, syncedForShop };
    };
    try {
      let { shopErrors, orderSnList, syncedForShop } = await runShopPull(auth.token, auth.apiShopId, auth.fileKey);
      if (shopErrors.some((e) => isShopeeInvalidTokenError(e.error, e.message)) && !shopErrors.every((e) => e.error === "no_valid_access_token")) {
        console.warn(`[Shopee Sync] shop_id=${shopKey} invalid access_token \u2014 \u0111ang refresh v\xE0 th\u1EED l\u1EA1i...`);
        auth = await getShopeeAccessTokenForApi(shopKey, { forceRefresh: true }) || auth;
        if (auth) {
          const retry = await runShopPull(auth.token, auth.apiShopId, auth.fileKey);
          if (!retry.shopErrors.some((e) => isShopeeInvalidTokenError(e.error, e.message)) || retry.syncedForShop.length > syncedForShop.length) {
            shopErrors = retry.shopErrors;
            orderSnList = retry.orderSnList;
            syncedForShop = retry.syncedForShop;
          } else {
            shopErrors = [
              {
                shopId: shopKey,
                error: "invalid_access_token",
                message: "Token kh\xF4ng h\u1EE3p l\u1EC7 sau khi refresh \u2014 v\xE0o C\xE0i \u0111\u1EB7t \u2192 OAuth l\u1EA1i shop n\xE0y."
              }
            ];
          }
        }
      }
      errors.push(...shopErrors);
      if (orderSnList.length === 0) continue;
      const syncedSnSet = new Set(syncedForShop.map((o) => o.orderSn));
      const fetchComplete = orderSnList.length > 0 && syncedForShop.length >= orderSnList.length;
      if (fetchComplete) {
        orders = orders.filter((o) => {
          if (o.channel !== "shopee" || String(o.shopId) !== String(auth.fileKey)) return true;
          if (syncedSnSet.has(o.orderSn)) return false;
          if (!SHOPEE_SYNC_UI_STATUSES.has(o.status)) return true;
          return false;
        });
      } else if (orderSnList.length > syncedForShop.length) {
        console.warn(
          `[Shopee Sync] shop_id=${shopKey}: get_order_detail thi\u1EBFu ${orderSnList.length - syncedForShop.length}/${orderSnList.length} \u0111\u01A1n \u2014 gi\u1EEF \u0111\u01A1n c\u0169, kh\xF4ng x\xF3a.`
        );
      }
      for (const normalized of syncedForShop) {
        const existingIndex = orders.findIndex((o) => o.orderSn === normalized.orderSn);
        if (existingIndex >= 0) {
          orders[existingIndex] = mergeShopeeOrderOnSync(orders[existingIndex], normalized);
          updatedCount++;
        } else {
          orders.unshift(normalized);
          addedCount++;
        }
        syncedCount++;
      }
    } catch (error) {
      console.error(`[Shopee Sync] L\u1ED7i shop_id=${shopKey}:`, error);
      errors.push({ shopId: shopKey, error: error.message || "unknown_error" });
    }
  }
  for (const shopKey of shopIds) {
    const auth = await getShopeeAccessTokenForApi(shopKey);
    if (!auth) continue;
    for (let i = 0; i < orders.length; i++) {
      const o = orders[i];
      if (o.channel !== "shopee" || String(o.shopId) !== String(auth.fileKey)) continue;
      if (!needsShopeeTrackingEnrichment(o)) continue;
      orders[i] = await enrichShopeeOrderTrackingFromApi(auth.apiShopId, auth.token, { ...o });
    }
  }
  const products = loadProducts();
  orders = enrichOrdersFromCatalog(orders, products);
  saveOrders(orders);
  const validOrders = orders.filter(isValidOrder);
  const uiStatusCounts = {
    unprocessed: validOrders.filter((o) => o.status === "unprocessed").length,
    processed: validOrders.filter((o) => o.status === "processed").length,
    shipping: validOrders.filter((o) => o.status === "shipping").length,
    pending_confirm: validOrders.filter((o) => o.status === "pending_confirm").length
  };
  console.log(`[Shopee Sync] UI counts sau \u0111\u1ED3ng b\u1ED9:`, JSON.stringify(uiStatusCounts));
  const uniqueErrors = dedupeErrors(errors);
  return {
    synced: syncedCount,
    added: addedCount,
    updated: updatedCount,
    orders: validOrders,
    statusCounts,
    uiStatusCounts,
    errors: uniqueErrors.length ? uniqueErrors : void 0,
    warning: uniqueErrors.some((e) => isShopeeInvalidTokenError(e.error, e.message)) ? "M\u1ED9t s\u1ED1 shop c\xF3 token Shopee h\u1EBFt h\u1EA1n \u2014 v\xE0o C\xE0i \u0111\u1EB7t b\u1EA5m OAuth l\u1EA1i shop b\u1ECB l\u1ED7i." : void 0
  };
}
var ORDERS_DB_PATH = import_path.default.join(APP_ROOT, "data", "orders.json");
var orderLookupIndex = null;
function normalizeOrderIndexKey(raw) {
  return String(raw || "").trim().toUpperCase().replace(/[\s\-_#./\\|:;,]+/g, "");
}
function rebuildOrderLookupIndex(orders) {
  const byId = /* @__PURE__ */ new Map();
  const byOrderSn = /* @__PURE__ */ new Map();
  const byTracking = /* @__PURE__ */ new Map();
  const byInternal = /* @__PURE__ */ new Map();
  const byPackage = /* @__PURE__ */ new Map();
  orders.forEach((order, index) => {
    const put = (map, value) => {
      const key = normalizeOrderIndexKey(String(value || ""));
      if (key) map.set(key, index);
    };
    put(byId, order.id);
    put(byId, String(order.id || "").replace(/^shopee-/i, ""));
    put(byOrderSn, order.orderSn);
    put(byTracking, order.trackingNumber);
    put(byInternal, order.internalTrackingCode);
    put(byPackage, order.packageNumber);
  });
  return { byId, byOrderSn, byTracking, byInternal, byPackage };
}
function getOrderLookupIndex(orders) {
  if (!orderLookupIndex) {
    orderLookupIndex = rebuildOrderLookupIndex(orders);
  }
  return orderLookupIndex;
}
function loadOrders() {
  try {
    if (!import_fs.default.existsSync(ORDERS_DB_PATH)) {
      orderLookupIndex = rebuildOrderLookupIndex([]);
      return [];
    }
    const raw = import_fs.default.readFileSync(ORDERS_DB_PATH, "utf-8");
    const parsed = raw.trim() ? JSON.parse(raw) : [];
    const orders = Array.isArray(parsed) ? parsed.map(repairMisassignedTracking) : [];
    orderLookupIndex = rebuildOrderLookupIndex(orders);
    return orders;
  } catch (error) {
    console.error("[Orders DB] Failed to read orders.json:", error);
    orderLookupIndex = rebuildOrderLookupIndex([]);
    return [];
  }
}
function saveOrders(orders) {
  try {
    import_fs.default.mkdirSync(import_path.default.dirname(ORDERS_DB_PATH), { recursive: true });
    const sanitized = orders.map(repairMisassignedTracking);
    import_fs.default.writeFileSync(ORDERS_DB_PATH, JSON.stringify(sanitized, null, 2), "utf-8");
    orderLookupIndex = rebuildOrderLookupIndex(sanitized);
  } catch (error) {
    console.error("[Orders DB] Failed to write orders.json:", error);
  }
}
function toDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function parseDashboardOrderDate(dateStr) {
  const raw = String(dateStr || "").trim();
  if (!raw) return /* @__PURE__ */ new Date(NaN);
  const datePart = raw.split("T")[0];
  const [y, m, d] = datePart.split("-").map(Number);
  if (!y || !m || !d) return /* @__PURE__ */ new Date(NaN);
  return new Date(y, m - 1, d);
}
function isDashboardOrder(order) {
  const sn = String(order?.orderSn || order?.id || "");
  if (!sn) return false;
  const hasAmount = Number(order?.totalAmount) > 0;
  const hasItems = Array.isArray(order?.items) && order.items.length > 0;
  if (!hasAmount && !hasItems && sn.startsWith("260709")) return false;
  return true;
}
function getDashboardDateRange(rangeKey) {
  const now = /* @__PURE__ */ new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  switch (rangeKey) {
    case "this_month":
      return { start: new Date(y, m, 1), end, key: "this_month", label: "Th\xE1ng n\xE0y" };
    case "last_month":
      return {
        start: new Date(y, m - 1, 1),
        end: new Date(y, m, 0, 23, 59, 59, 999),
        key: "last_month",
        label: "Th\xE1ng tr\u01B0\u1EDBc"
      };
    case "this_quarter": {
      const qStart = Math.floor(m / 3) * 3;
      return { start: new Date(y, qStart, 1), end, key: "this_quarter", label: "Qu\xFD n\xE0y" };
    }
    case "this_year":
      return { start: new Date(y, 0, 1), end, key: "this_year", label: "N\u0103m nay" };
    case "today": {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      return { start, end, key: "today", label: "H\xF4m nay" };
    }
    case "last_7_days":
    default: {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      start.setDate(start.getDate() - 6);
      return { start, end, key: "last_7_days", label: "7 ng\xE0y qua" };
    }
  }
}
function isDateInRange(dateStr, start, end) {
  const d = parseDashboardOrderDate(dateStr);
  if (Number.isNaN(d.getTime())) return false;
  const s = new Date(start);
  s.setHours(0, 0, 0, 0);
  const e = new Date(end);
  e.setHours(23, 59, 59, 999);
  return d >= s && d <= e;
}
function findOrderItemMeta(orders, productId) {
  for (const order of orders) {
    const items = Array.isArray(order?.items) ? order.items : [];
    const hit = items.find((i) => String(i.productId) === productId);
    if (hit) {
      return {
        title: hit.productTitle ? String(hit.productTitle) : null,
        image: hit.productImage ? String(hit.productImage) : null
      };
    }
  }
  return { title: null, image: null };
}
function buildDashboardChart(orders, range) {
  const buckets = /* @__PURE__ */ new Map();
  if (range.key === "this_year" || range.key === "this_quarter") {
    const cursor = new Date(range.start.getFullYear(), range.start.getMonth(), 1);
    const endMonth = new Date(range.end.getFullYear(), range.end.getMonth(), 1);
    while (cursor <= endMonth) {
      const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`;
      buckets.set(key, {
        key,
        label: `T${cursor.getMonth() + 1}`,
        amount: 0
      });
      cursor.setMonth(cursor.getMonth() + 1);
    }
  } else {
    const cursor = new Date(range.start);
    cursor.setHours(0, 0, 0, 0);
    const endDay = new Date(range.end);
    endDay.setHours(0, 0, 0, 0);
    while (cursor <= endDay) {
      const key = toDateKey(cursor);
      buckets.set(key, {
        key,
        label: `${String(cursor.getDate()).padStart(2, "0")}/${String(cursor.getMonth() + 1).padStart(2, "0")}`,
        amount: 0
      });
      cursor.setDate(cursor.getDate() + 1);
    }
  }
  for (const order of orders) {
    const dateStr = String(order.date || "").split("T")[0];
    let bucketKey = dateStr;
    if (range.key === "this_year" || range.key === "this_quarter") {
      const d = parseDashboardOrderDate(dateStr);
      bucketKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    }
    const bucket = buckets.get(bucketKey);
    if (bucket) {
      bucket.amount += Number(order.totalAmount) || 0;
    }
  }
  return Array.from(buckets.values());
}
var PRODUCTS_DB_PATH = import_path.default.join(APP_ROOT, "data", "products.json");
function loadProducts() {
  try {
    if (!import_fs.default.existsSync(PRODUCTS_DB_PATH)) return [];
    const raw = import_fs.default.readFileSync(PRODUCTS_DB_PATH, "utf-8");
    return raw.trim() ? JSON.parse(raw) : [];
  } catch (error) {
    console.error("[Products DB] Failed to read products.json:", error);
    return [];
  }
}
function saveProducts(products) {
  try {
    import_fs.default.mkdirSync(import_path.default.dirname(PRODUCTS_DB_PATH), { recursive: true });
    import_fs.default.writeFileSync(PRODUCTS_DB_PATH, JSON.stringify(products, null, 2), "utf-8");
  } catch (error) {
    console.error("[Products DB] Failed to write products.json:", error);
  }
}
var SUPPLIERS_DB_PATH = import_path.default.join(APP_ROOT, "data", "suppliers.json");
function normalizeSupplier(raw) {
  const totalOrderValue = Number(raw?.totalOrderValue) || 0;
  const totalPaid = Number(raw?.totalPaid) || 0;
  return {
    id: String(raw?.id || `sup-${Date.now()}`),
    name: String(raw?.name || "").trim(),
    supplierCode: String(raw?.supplierCode || raw?.supplier_code || "").trim().toUpperCase(),
    totalOrderValue,
    totalPaid,
    totalDebt: Number(raw?.totalDebt ?? totalOrderValue - totalPaid) || 0,
    status: raw?.status === "inactive" ? "inactive" : "active"
  };
}
function loadSuppliers() {
  try {
    if (!import_fs.default.existsSync(SUPPLIERS_DB_PATH)) return [];
    const raw = import_fs.default.readFileSync(SUPPLIERS_DB_PATH, "utf-8");
    const parsed = raw.trim() ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.map(normalizeSupplier) : [];
  } catch (error) {
    console.error("[Suppliers DB] Failed to read suppliers.json:", error);
    return [];
  }
}
function saveSuppliers(suppliers) {
  try {
    import_fs.default.mkdirSync(import_path.default.dirname(SUPPLIERS_DB_PATH), { recursive: true });
    import_fs.default.writeFileSync(SUPPLIERS_DB_PATH, JSON.stringify(suppliers, null, 2), "utf-8");
  } catch (error) {
    console.error("[Suppliers DB] Failed to write suppliers.json:", error);
  }
}
var IMPORTS_DB_PATH = import_path.default.join(APP_ROOT, "data", "imports.json");
function loadImports() {
  try {
    if (!import_fs.default.existsSync(IMPORTS_DB_PATH)) return [];
    const raw = import_fs.default.readFileSync(IMPORTS_DB_PATH, "utf-8");
    const parsed = raw.trim() ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error("[Imports DB] Failed to read imports.json:", error);
    return [];
  }
}
function saveImports(imports) {
  try {
    import_fs.default.mkdirSync(import_path.default.dirname(IMPORTS_DB_PATH), { recursive: true });
    import_fs.default.writeFileSync(IMPORTS_DB_PATH, JSON.stringify(imports, null, 2), "utf-8");
  } catch (error) {
    console.error("[Imports DB] Failed to write imports.json:", error);
  }
}
var EXPENSES_DB_PATH = import_path.default.join(APP_ROOT, "data", "expenses.json");
var EXPENSES_CLEAR_MARKER = import_path.default.join(APP_ROOT, "data", ".expenses-cleared-v2");
function loadExpenses() {
  try {
    if (!import_fs.default.existsSync(EXPENSES_DB_PATH)) return [];
    const raw = import_fs.default.readFileSync(EXPENSES_DB_PATH, "utf-8");
    const parsed = raw.trim() ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error("[Expenses DB] Failed to read expenses.json:", error);
    return [];
  }
}
function saveExpenses(expenses) {
  try {
    import_fs.default.mkdirSync(import_path.default.dirname(EXPENSES_DB_PATH), { recursive: true });
    import_fs.default.writeFileSync(EXPENSES_DB_PATH, JSON.stringify(expenses, null, 2), "utf-8");
  } catch (error) {
    console.error("[Expenses DB] Failed to write expenses.json:", error);
  }
}
function migrateExpensesStorageOnce() {
  if (import_fs.default.existsSync(EXPENSES_CLEAR_MARKER)) return;
  saveExpenses([]);
  try {
    import_fs.default.mkdirSync(import_path.default.dirname(EXPENSES_CLEAR_MARKER), { recursive: true });
    import_fs.default.writeFileSync(EXPENSES_CLEAR_MARKER, (/* @__PURE__ */ new Date()).toISOString(), "utf-8");
    console.log("[Expenses] \u0110\xE3 x\xF3a s\u1EA1ch d\u1EEF li\u1EC7u chi ph\xED c\u0169 (migration m\u1ED9t l\u1EA7n).");
  } catch (error) {
    console.error("[Expenses] Failed to write clear marker:", error);
  }
}
migrateExpensesStorageOnce();
function applyBulkProductUpdate(product, opts) {
  let stock = Number(product.stock) || 0;
  let sellingPrice = Number(product.sellingPrice) || 0;
  if (opts.stock) {
    const v = Number(opts.stock.value) || 0;
    if (opts.stock.mode === "set") stock = v;
    else if (opts.stock.mode === "delta") stock = stock + v;
    else if (opts.stock.mode === "increase") stock = stock + v;
    else if (opts.stock.mode === "decrease") stock = stock - v;
  }
  if (opts.price) {
    const v = Number(opts.price.value) || 0;
    switch (opts.price.mode) {
      case "set":
        sellingPrice = v;
        break;
      case "percent_up":
        sellingPrice = Math.round(sellingPrice * (1 + v / 100));
        break;
      case "percent_down":
        sellingPrice = Math.round(sellingPrice * (1 - v / 100));
        break;
      case "fixed_up":
        sellingPrice = sellingPrice + v;
        break;
      case "fixed_down":
        sellingPrice = Math.max(Number(product.importPrice) || 0, sellingPrice - v);
        break;
    }
  }
  stock = Math.max(0, Math.round(stock));
  sellingPrice = Math.max(0, Math.round(sellingPrice));
  return {
    ...product,
    stock,
    sellingPrice,
    status: stock <= 0 ? "out_of_stock" : product.status === "draft" ? "draft" : "active",
    lastSynced: (/* @__PURE__ */ new Date()).toISOString()
  };
}
function mergeProductPatch(product, patch) {
  const merged = { ...product };
  if (patch.title !== void 0) merged.title = String(patch.title);
  if (patch.sku !== void 0) merged.sku = String(patch.sku);
  if (patch.stock !== void 0) merged.stock = Math.max(0, Math.round(Number(patch.stock)));
  if (patch.sellingPrice !== void 0) merged.sellingPrice = Math.max(0, Math.round(Number(patch.sellingPrice)));
  if (patch.wholesalePrice !== void 0) merged.wholesalePrice = Math.max(0, Math.round(Number(patch.wholesalePrice)));
  if (patch.importPrice !== void 0) merged.importPrice = Math.max(0, Math.round(Number(patch.importPrice)));
  if (patch.weight !== void 0) merged.weight = Math.max(0, Number(patch.weight));
  if (patch.brand !== void 0) merged.brand = String(patch.brand);
  if (patch.supplierId !== void 0) merged.supplierId = patch.supplierId ? String(patch.supplierId) : void 0;
  if (patch.barcode !== void 0) merged.barcode = String(patch.barcode);
  if (patch.stockMin !== void 0) merged.stockMin = Math.max(0, Math.round(Number(patch.stockMin)));
  if (patch.stockMax !== void 0) merged.stockMax = Math.max(0, Math.round(Number(patch.stockMax)));
  if (patch.description !== void 0) merged.description = String(patch.description);
  if (patch.category !== void 0) merged.category = String(patch.category);
  if (patch.unit !== void 0) merged.unit = String(patch.unit).trim();
  if (patch.status !== void 0) merged.status = patch.status;
  if (merged.stock <= 0 && merged.status !== "draft") merged.status = "out_of_stock";
  else if (merged.stock > 0 && merged.status === "out_of_stock") merged.status = "active";
  merged.lastSynced = (/* @__PURE__ */ new Date()).toISOString();
  return merged;
}
function resolveOrderShopId(order) {
  if (order?.shopId) return String(order.shopId);
  if (order?.channel !== "shopee") return void 0;
  const shopIds = Object.keys(loadShopeeTokens());
  return shopIds.length === 1 ? shopIds[0] : void 0;
}
function findOrderRecord(orders, idOrSn) {
  const key = String(idOrSn || "").trim();
  if (!key) return null;
  const idx = getOrderLookupIndex(orders);
  const normalized = normalizeOrderIndexKey(key);
  let index = idx.byId.get(normalized) ?? idx.byOrderSn.get(normalized);
  if (index === void 0 && !key.startsWith("shopee-")) {
    index = idx.byId.get(normalizeOrderIndexKey(`shopee-${key}`));
  }
  if (index === void 0) return null;
  return { index, order: orders[index] };
}
function resolveOrdersFromRequest(orders, orderIds, orderSns) {
  const hits = [];
  const seen = /* @__PURE__ */ new Set();
  const tryAdd = (idOrSn) => {
    const hit = findOrderRecord(orders, idOrSn);
    if (hit && !seen.has(hit.index)) {
      seen.add(hit.index);
      hits.push(hit);
    }
  };
  for (const id of orderIds || []) tryAdd(String(id));
  for (const sn of orderSns || []) tryAdd(String(sn));
  return hits;
}
function isAlreadyShippedError(result) {
  const blob = `${result?.error || ""} ${result?.message || ""}`.toLowerCase();
  return blob.includes("already") || blob.includes("has been shipped") || blob.includes("logistics order is completed");
}
var shipOrderJobs = /* @__PURE__ */ new Map();
var SHIP_JOB_TTL_MS = 30 * 60 * 1e3;
function createShipOrderJobId() {
  return `ship-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
function pruneOldShipOrderJobs() {
  const cutoff = Date.now() - SHIP_JOB_TTL_MS;
  for (const [id, job] of shipOrderJobs) {
    if (job.updatedAt < cutoff) shipOrderJobs.delete(id);
  }
}
function isValidOrder(order) {
  const hasAmount = Number(order?.totalAmount) > 0;
  const hasItems = Array.isArray(order?.items) && order.items.length > 0;
  if (!hasAmount && !hasItems) return false;
  const sn = String(order?.orderSn || "");
  if (sn.startsWith("260709") && !hasItems && Number(order?.totalAmount) === 0) return false;
  return true;
}
function normalizeShopeeOrder(payload) {
  const data = payload?.data || payload || {};
  const orderSn = data.ordersn || data.order_sn || data.orderSn;
  if (!orderSn) return null;
  const shopId = payload?.shop_id ?? data.shop_id;
  const statusMap = {
    UNPAID: "pending_confirm",
    READY_TO_SHIP: "unprocessed",
    PROCESSED: "processed",
    RETRY_SHIP: "unprocessed",
    SHIPPED: "shipping",
    TO_CONFIRM_RECEIVE: "shipping",
    IN_CANCEL: "cancelled",
    CANCELLED: "cancelled",
    TO_RETURN: "return_pending",
    COMPLETED: "completed"
  };
  const rawStatus = String(data.status || data.order_status || "READY_TO_SHIP").toUpperCase();
  const order = {
    id: `shopee-${orderSn}`,
    orderSn: String(orderSn),
    channel: "shopee",
    shopId: shopId ? String(shopId) : void 0,
    shopName: data.shop_name || "Shopee Shop",
    totalAmount: Number(data.total_amount || 0),
    revenue: Number(data.total_amount || 0) * 0.88,
    status: statusMap[rawStatus] || "unprocessed",
    date: data.create_time ? new Date(data.create_time * 1e3).toISOString() : (/* @__PURE__ */ new Date()).toISOString(),
    packageNumber: data.package_number || void 0,
    isPrepared: false,
    isPrinted: false,
    items: Array.isArray(data.item_list) ? data.item_list.map((it) => mapShopeeOrderLineItem(it)) : []
  };
  const rawTrack = data.tracking_no || data.tracking_number;
  if (rawTrack) applyShopeeTrackingCode(order, rawTrack);
  repairMisassignedTracking(order);
  return order;
}
function processShopeeWebhookPayload(body) {
  try {
    const normalized = normalizeShopeeOrder(body);
    if (!normalized) return;
    const orders = loadOrders();
    const existingIndex = orders.findIndex((o) => o.orderSn === normalized.orderSn);
    if (existingIndex >= 0) {
      const merged = { ...orders[existingIndex], ...normalized };
      if (!normalized.items || normalized.items.length === 0) {
        merged.items = orders[existingIndex].items;
      }
      if (!normalized.totalAmount) {
        merged.totalAmount = orders[existingIndex].totalAmount;
        merged.revenue = orders[existingIndex].revenue;
      }
      if (!normalized.shopId) {
        merged.shopId = orders[existingIndex].shopId;
      }
      if (!normalized.packageNumber) {
        merged.packageNumber = orders[existingIndex].packageNumber;
      }
      mergeShopeeTrackingFields(merged, orders[existingIndex], normalized);
      orders[existingIndex] = merged;
    } else {
      orders.unshift(normalized);
    }
    saveOrders(orders);
    console.log(`[Shopee Webhook] Order ${normalized.orderSn} upserted into local orders database.`);
  } catch (error) {
    console.error("[Shopee Webhook] Async processing error:", error);
  }
}
var authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Y\xEAu c\u1EA7u cung c\u1EA5p Token x\xE1c th\u1EF1c h\u1EE3p l\u1EC7." });
  }
  const token = authHeader.split(" ")[1];
  try {
    const decoded = import_jsonwebtoken.default.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: "Token kh\xF4ng h\u1EE3p l\u1EC7 ho\u1EB7c \u0111\xE3 h\u1EBFt h\u1EA1n." });
  }
};
async function startServer() {
  const app = (0, import_express.default)();
  const PORT = process.env.PORT || 3e3;
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    const allowedOrigin = origin && (/^https:\/\/([a-z0-9-]+\.)*vercel\.app$/i.test(origin) || /^https:\/\/([a-z0-9-]+\.)*linhkienamthanh\.net$/i.test(origin) || /^http:\/\/localhost(:\d+)?$/i.test(origin));
    if (allowedOrigin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") {
      return res.status(204).end();
    }
    next();
  });
  app.use(import_express.default.json());
  app.post("/api/login", (req, res) => {
    const { username, password } = req.body;
    const expectedUsername = process.env.ADMIN_USERNAME || "admin";
    const expectedPassword = process.env.ADMIN_PASSWORD || "password123";
    if (username === expectedUsername && password === expectedPassword) {
      const token = import_jsonwebtoken.default.sign({ username }, JWT_SECRET, { expiresIn: "24h" });
      return res.json({ token, username });
    } else {
      return res.status(401).json({ error: "T\xEAn \u0111\u0103ng nh\u1EADp ho\u1EB7c m\u1EADt kh\u1EA9u kh\xF4ng ch\xEDnh x\xE1c." });
    }
  });
  app.get("/api/auth/verify", authMiddleware, (req, res) => {
    res.json({ valid: true, username: req.user.username });
  });
  app.get("/api/config/public", (_req, res) => {
    res.json({
      appUrl: APP_BASE_URL,
      apiBaseUrl: APP_BASE_URL,
      shopeeCallbackUrl: SHOPEE_CALLBACK_URL,
      shopeeWebhookUrl: SHOPEE_WEBHOOK_URL
    });
  });
  app.get("/api/health", (_req, res) => {
    const shopIds = listShopeeOAuthShopIds();
    let dataDirWritable = false;
    try {
      ensureDataDirs();
      import_fs.default.accessSync(import_path.default.join(APP_ROOT, "data"), import_fs.default.constants.W_OK);
      dataDirWritable = true;
    } catch {
      dataDirWritable = false;
    }
    res.status(200).json({
      ok: true,
      service: "cpanel-backend",
      host: APP_BASE_URL,
      appRoot: APP_ROOT,
      tokensPath: SHOPEE_TOKENS_PATH,
      tokensFileExists: import_fs.default.existsSync(SHOPEE_TOKENS_PATH),
      dataDirWritable,
      shopeeOAuthShopIds: shopIds,
      lastOAuth: loadLastOAuthAudit(),
      oauthHint: shopIds.length > 0 ? "V\xE0o C\xE0i \u0111\u1EB7t \u2192 shop Shopee \u2192 b\u1EA5m OAuth (shop_id ph\u1EA3i kh\u1EDBp). Sau OAuth ki\u1EC3m tra lastOAuth.success=true." : "Ch\u01B0a c\xF3 shop OAuth \u2014 b\u1EA5m n\xFAt OAuth trong C\xE0i \u0111\u1EB7t.",
      checkedAt: (/* @__PURE__ */ new Date()).toISOString()
    });
  });
  app.get("/api/public/labels/:filename", (req, res) => {
    const result = serveLabelPdfFromDisk(req.params.filename, res);
    if (result === "not_found") {
      res.status(404).type("text/plain").send("Kh\xF4ng t\xECm th\u1EA5y file v\u1EADn \u0111\u01A1n.");
    }
  });
  function logShopeeIngress(prefix, req) {
    console.log(
      prefix,
      JSON.stringify({
        at: (/* @__PURE__ */ new Date()).toISOString(),
        method: req.method,
        url: req.url,
        query: req.query || {},
        headers: req.headers || {},
        body: req.body ?? null
      })
    );
  }
  app.get("/api/shopee/oauth/complete", async (req, res) => {
    console.log("DEBUG RAW RESPONSE:", JSON.stringify(req.query));
    logShopeeIngress("[Shopee OAuth Complete]", req);
    const code = queryParamOne(req.query.code);
    const shopIdRaw = queryParamOne(req.query.shop_id);
    const mainAccountIdRaw = queryParamOne(req.query.main_account_id);
    const expectedShop = queryParamOne(req.query.expected_shop);
    console.log(
      "[Shopee OAuth Complete] REQUEST (Vercel proxy JSON)",
      JSON.stringify({
        code_present: Boolean(code),
        shop_id_raw: shopIdRaw || null,
        main_account_id_raw: mainAccountIdRaw || null,
        expected_shop: expectedShop || null,
        SHOPEE_TOKENS_PATH
      })
    );
    if (!code || !shopIdRaw && !mainAccountIdRaw) {
      return res.status(200).type("text/plain; charset=utf-8").send(SHOPEE_CALLBACK_IDLE_MSG);
    }
    try {
      const result = await completeShopeeOAuthFlow(code, {
        shopIdRaw: shopIdRaw || void 0,
        mainAccountIdRaw: mainAccountIdRaw || void 0,
        expectedShopId: expectedShop || void 0
      });
      console.log("[Shopee OAuth Complete] K\u1EBET QU\u1EA2", JSON.stringify(result));
      return res.status(result.success ? 200 : 400).json({
        ...result,
        message: result.success ? `OAuth th\xE0nh c\xF4ng. Token \u0111\xE3 l\u01B0u cho shop ${result.oauth_shop_id}.` : result.message || result.error || "OAuth th\u1EA5t b\u1EA1i",
        tokens_path: SHOPEE_TOKENS_PATH
      });
    } catch (error) {
      console.error("[Shopee OAuth Complete] L\u1ED6I", error);
      return res.status(500).json({
        success: false,
        error: error?.message || "unknown_error"
      });
    }
  });
  app.get("/api/shopee/callback", async (req, res) => {
    console.log("DEBUG RAW RESPONSE:", JSON.stringify(req.query));
    logShopeeIngress("[Shopee Callback]", req);
    const code = queryParamOne(req.query.code);
    const shopIdRaw = queryParamOne(req.query.shop_id);
    const mainAccountIdRaw = queryParamOne(req.query.main_account_id);
    const expectedShop = queryParamOne(req.query.expected_shop);
    console.log(
      "[Shopee Callback] REQUEST NH\u1EACN \u0110\u01AF\u1EE2C",
      JSON.stringify({
        at: (/* @__PURE__ */ new Date()).toISOString(),
        method: req.method,
        url: req.url,
        code_present: Boolean(code),
        code_length: code.length,
        shop_id_raw: shopIdRaw || null,
        main_account_id_raw: mainAccountIdRaw || null,
        expected_shop: expectedShop || null,
        query: req.query || {},
        SHOPEE_TOKENS_PATH,
        SHOPEE_CALLBACK_URL,
        APP_ROOT,
        cwd: process.cwd()
      })
    );
    if (!code || !shopIdRaw && !mainAccountIdRaw) {
      console.log("[Shopee Callback] Truy c\u1EADp tr\u1EF1c ti\u1EBFp \u2014 thi\u1EBFu code/shop_id");
      return res.status(200).type("text/plain; charset=utf-8").send(SHOPEE_CALLBACK_IDLE_MSG);
    }
    const oauthShopId = normalizeShopIdKey(shopIdRaw);
    const mainAccountId = normalizeShopIdKey(mainAccountIdRaw);
    if (!oauthShopId && !mainAccountId) {
      console.error(`[Shopee Callback] shop_id/main_account_id kh\xF4ng h\u1EE3p l\u1EC7: shop_id=${shopIdRaw}, main_account_id=${mainAccountIdRaw}`);
      return res.status(400).json({
        success: false,
        error: "invalid_shop_id",
        message: `Shop ID / Main Account ID kh\xF4ng h\u1EE3p l\u1EC7`,
        tokens_path: SHOPEE_TOKENS_PATH
      });
    }
    try {
      const result = await completeShopeeOAuthFlow(code, {
        shopIdRaw: shopIdRaw || void 0,
        mainAccountIdRaw: mainAccountIdRaw || void 0,
        expectedShopId: expectedShop || void 0
      });
      if (!result.success) {
        console.error(`[Shopee Callback] \u0110\u1ED5i code th\u1EA5t b\u1EA1i:`, result.error, result.message);
        if (shouldOAuthRedirectToFrontend(req)) {
          return res.redirect(302, buildOAuthFrontendRedirectUrl(req, result));
        }
        return res.status(400).json({
          ...result,
          message: result.message || result.error || "token_exchange_failed",
          tokens_path: SHOPEE_TOKENS_PATH
        });
      }
      console.log(
        `[Shopee Callback] OAuth OK. Token \u0111\xE3 l\u01B0u cho: [${result.saved_shop_ids.join(", ")}]. verified=${result.verified_in_file} File: ${SHOPEE_TOKENS_PATH}`
      );
      if (shouldOAuthRedirectToFrontend(req)) {
        return res.redirect(302, buildOAuthFrontendRedirectUrl(req, result));
      }
      return res.status(200).json({
        ...result,
        message: result.message || `OAuth th\xE0nh c\xF4ng. Token \u0111\xE3 l\u01B0u cho: [${result.saved_shop_ids.join(", ")}].`,
        tokens_path: SHOPEE_TOKENS_PATH,
        callback_url: SHOPEE_CALLBACK_URL
      });
    } catch (error) {
      console.error("[Shopee Callback] Exchange token error:", error);
      saveOAuthAudit({
        callback_shop_id: oauthShopId || mainAccountId || null,
        main_account_id: mainAccountId || null,
        success: false,
        error: error?.message || "unknown_error",
        tokens_path: SHOPEE_TOKENS_PATH,
        app_root: APP_ROOT
      });
      const failResult = {
        success: false,
        error: error?.message || "unknown_error",
        message: error?.message || "L\u1ED7i x\u1EED l\xFD OAuth callback",
        oauth_shop_id: oauthShopId
      };
      if (shouldOAuthRedirectToFrontend(req)) {
        return res.redirect(302, buildOAuthFrontendRedirectUrl(req, failResult));
      }
      return res.status(500).json({
        ...failResult,
        tokens_path: SHOPEE_TOKENS_PATH
      });
    }
  });
  app.get("/api/shopee/webhook", (req, res) => {
    logShopeeIngress("[Shopee Webhook]", req);
    console.log("[Shopee Webhook] GET verification probe \u2014 200 empty");
    res.status(200).end();
  });
  app.post("/api/shopee/webhook", (req, res) => {
    logShopeeIngress("[Shopee Webhook]", req);
    res.status(200).end();
    const payload = req.body;
    setImmediate(() => {
      try {
        processShopeeWebhookPayload(payload);
        console.log("[Shopee Webhook] \u0110\xE3 x\u1EED l\xFD v\xE0 l\u01B0u payload v\xE0o database.");
      } catch (error) {
        console.error("[Shopee Webhook] L\u1ED7i x\u1EED l\xFD payload:", error);
      }
    });
  });
  app.get("/api/products", authMiddleware, (_req, res) => {
    return res.json(loadProducts());
  });
  app.post("/api/products", authMiddleware, (req, res) => {
    const body = req.body || {};
    if (!body.title || !body.sku) {
      return res.status(400).json({ error: "title_and_sku_required" });
    }
    const products = loadProducts();
    const product = {
      id: body.id || `prod-${Date.now()}`,
      title: String(body.title),
      sku: String(body.sku),
      stock: Math.max(0, Math.round(Number(body.stock) || 0)),
      importPrice: Math.max(0, Math.round(Number(body.importPrice) || 0)),
      sellingPrice: Math.max(0, Math.round(Number(body.sellingPrice) || 0)),
      channels: Array.isArray(body.channels) ? body.channels : ["shopee"],
      category: body.category || "Ch\u01B0a ph\xE2n lo\u1EA1i",
      description: body.description || "",
      imageUrl: body.imageUrl || void 0,
      status: body.status || "active",
      shopeeId: body.shopeeId,
      tiktokId: body.tiktokId,
      wooId: body.wooId,
      lastSynced: (/* @__PURE__ */ new Date()).toISOString()
    };
    products.unshift(product);
    saveProducts(products);
    return res.status(201).json(product);
  });
  app.put("/api/products/replace", authMiddleware, (req, res) => {
    const incoming = req.body?.products;
    if (!Array.isArray(incoming)) {
      return res.status(400).json({ error: "products_array_required" });
    }
    saveProducts(incoming);
    return res.json({ count: incoming.length, products: incoming });
  });
  app.patch("/api/products/:id", authMiddleware, (req, res) => {
    const products = loadProducts();
    const index = products.findIndex((p) => p.id === req.params.id);
    if (index === -1) {
      return res.status(404).json({ error: "product_not_found" });
    }
    const patch = req.body || {};
    const merged = mergeProductPatch(products[index], patch);
    products[index] = merged;
    saveProducts(products);
    return res.json(merged);
  });
  app.post("/api/products/inventory-balance", authMiddleware, async (req, res) => {
    try {
      const items = req.body?.items;
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ success: false, message: "Ch\u01B0a c\xF3 d\xF2ng t\u1ED3n kho n\xE0o \u0111\u1EC3 c\xE2n b\u1EB1ng." });
      }
      const skuStockMap = /* @__PURE__ */ new Map();
      for (const item of items) {
        const sku = String(item?.sku || "").trim();
        if (!sku) continue;
        const actual = Math.max(0, Math.round(Number(item.actual_stock)));
        if (!Number.isFinite(actual)) continue;
        skuStockMap.set(sku, actual);
      }
      if (skuStockMap.size === 0) {
        return res.status(400).json({ success: false, message: "D\u1EEF li\u1EC7u c\xE2n b\u1EB1ng kho kh\xF4ng h\u1EE3p l\u1EC7." });
      }
      const products = loadProducts();
      let updatedCount = 0;
      const next = products.map((p) => {
        const sku = String(p.sku || "").trim();
        if (!skuStockMap.has(sku)) return p;
        updatedCount++;
        return mergeProductPatch(p, { stock: skuStockMap.get(sku) });
      });
      if (updatedCount === 0) {
        return res.status(404).json({ success: false, message: "Kh\xF4ng t\xECm th\u1EA5y SKU n\xE0o trong kho g\u1ED1c \u0111\u1EC3 c\u1EADp nh\u1EADt." });
      }
      const updatedProducts = next.filter((p) => skuStockMap.has(String(p.sku || "").trim()));
      const unlinkedShopee = updatedProducts.filter(
        (p) => p.channels?.includes("shopee") && !p.shopeeItemId
      );
      if (unlinkedShopee.length > 0) {
        return res.status(400).json({
          success: false,
          message: `SKU ch\u01B0a li\xEAn k\u1EBFt Shopee (thi\u1EBFu item_id): ${unlinkedShopee.map((p) => p.sku).join(", ")}`
        });
      }
      saveProducts(next);
      console.log(`[Inventory Balance] C\u1EADp nh\u1EADt kho g\u1ED1c ${updatedCount} SKU`);
      const shopeeResult = await pushStockUpdatesToShopee(updatedProducts, req.body?.shopId);
      if (!shopeeResult.ok) {
        return res.status(400).json({
          success: false,
          message: `Kho g\u1ED1c \u0111\xE3 c\u1EADp nh\u1EADt. \u0110\u1EA9y Shopee th\u1EA5t b\u1EA1i: ${shopeeResult.errors.join(" | ")}`,
          shopeeErrors: shopeeResult.errors
        });
      }
      const msg = shopeeResult.pushed > 0 ? `C\xE2n b\u1EB1ng kho th\xE0nh c\xF4ng (${shopeeResult.pushed} SKU \u0111\xE3 \u0111\u1ED3ng b\u1ED9 l\xEAn Shopee).` : "C\xE2n b\u1EB1ng kho th\xE0nh c\xF4ng";
      console.log(`[Inventory Balance] ${msg}`);
      return res.status(200).json({ success: true, message: msg });
    } catch (err) {
      console.error("[Inventory Balance] Exception:", err);
      return res.status(500).json({ success: false, message: err?.message || "L\u1ED7i server khi c\xE2n b\u1EB1ng kho." });
    }
  });
  app.post("/api/products/bulk-save", authMiddleware, (req, res) => {
    const updates = req.body?.updates;
    if (!Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({ error: "updates_required" });
    }
    const patchMap = /* @__PURE__ */ new Map();
    for (const u of updates) {
      if (u?.id) patchMap.set(String(u.id), u);
    }
    const products = loadProducts();
    let updatedCount = 0;
    const next = products.map((p) => {
      const patch = patchMap.get(p.id);
      if (!patch) return p;
      updatedCount++;
      return mergeProductPatch(p, patch);
    });
    saveProducts(next);
    return res.json({ updated: updatedCount, products: next });
  });
  app.delete("/api/products/:id", authMiddleware, (req, res) => {
    const products = loadProducts();
    const next = products.filter((p) => p.id !== req.params.id);
    if (next.length === products.length) {
      return res.status(404).json({ error: "product_not_found" });
    }
    saveProducts(next);
    return res.json({ deleted: req.params.id });
  });
  app.post("/api/products/clear-all", authMiddleware, (_req, res) => {
    saveProducts([]);
    return res.json({ success: true, cleared: true, products: [] });
  });
  app.post("/api/products/bulk-update", authMiddleware, (req, res) => {
    const { productIds, stock, price } = req.body || {};
    if (!Array.isArray(productIds) || productIds.length === 0) {
      return res.status(400).json({ error: "productIds_required" });
    }
    if (!stock && !price) {
      return res.status(400).json({ error: "stock_or_price_required" });
    }
    const idSet = new Set(productIds.map(String));
    const products = loadProducts();
    let updatedCount = 0;
    const next = products.map((p) => {
      if (!idSet.has(p.id)) return p;
      updatedCount++;
      return applyBulkProductUpdate(p, { stock, price });
    });
    saveProducts(next);
    return res.json({ updated: updatedCount, products: next });
  });
  app.post("/api/products/bulk-channel-sync", authMiddleware, async (req, res) => {
    try {
      const { productIds, channels, shopId, shops } = req.body || {};
      if (!Array.isArray(productIds) || productIds.length === 0) {
        return res.status(400).json({ error: "productIds_required" });
      }
      const channelList = Array.isArray(channels) && channels.length ? channels : ["shopee"];
      const idSet = new Set(productIds.map(String));
      const products = loadProducts().filter((p) => idSet.has(p.id));
      if (products.length === 0) {
        return res.status(404).json({ error: "Kh\xF4ng t\xECm th\u1EA5y s\u1EA3n ph\u1EA9m n\xE0o trong kho." });
      }
      const shopList = Array.isArray(shops) ? shops : [];
      const wooShop = shopList.find((s) => s.platform === "woocommerce" && s.connected !== false);
      const shopeeShopId = resolveShopeeTokenShopId(shopId || shopList.find((s) => s.platform === "shopee")?.shopId);
      let shopeeToken = null;
      if (channelList.includes("shopee")) {
        if (!shopeeShopId) {
          return res.status(400).json({
            error: "Ch\u01B0a c\xF3 shop Shopee \u0111\u01B0\u1EE3c \u1EE7y quy\u1EC1n.",
            logs: products.flatMap((p) => [
              {
                productId: p.id,
                sku: p.sku,
                channel: "shopee",
                action: "auth",
                success: false,
                message: "Ch\u01B0a c\xF3 shop Shopee \u0111\u01B0\u1EE3c \u1EE7y quy\u1EC1n"
              }
            ])
          });
        }
        shopeeToken = await getValidShopeeAccessToken(shopeeShopId);
        if (!shopeeToken) {
          return res.status(400).json({
            error: `Ch\u01B0a c\xF3 access_token h\u1EE3p l\u1EC7 cho shop_id=${shopeeShopId}.`,
            logs: products.flatMap((p) => [
              {
                productId: p.id,
                sku: p.sku,
                channel: "shopee",
                action: "auth",
                success: false,
                message: `Ch\u01B0a c\xF3 access_token h\u1EE3p l\u1EC7 cho shop_id=${shopeeShopId}`
              }
            ])
          });
        }
      }
      const logs = [];
      for (const product of products) {
        for (const channel of channelList) {
          if (channel === "shopee" && shopeeShopId && shopeeToken) {
            const lines = await syncProductToShopee(product, shopeeShopId, shopeeToken);
            logs.push(...lines);
            await new Promise((r) => setTimeout(r, 150));
          } else if (channel === "woocommerce") {
            const lines = await syncProductToWoo(product, wooShop);
            logs.push(...lines);
            await new Promise((r) => setTimeout(r, 100));
          } else if (channel === "tiktok") {
            const lines = await syncProductToTikTok(product);
            logs.push(...lines);
          }
        }
      }
      const successCount = logs.filter((l) => l.success).length;
      const failCount = logs.filter((l) => !l.success).length;
      const syncedProductIds = new Set(
        logs.filter((l) => l.success).map((l) => l.productId)
      );
      if (syncedProductIds.size > 0) {
        const allProducts = loadProducts();
        const now = (/* @__PURE__ */ new Date()).toISOString();
        const next = allProducts.map(
          (p) => syncedProductIds.has(p.id) ? { ...p, lastSynced: now } : p
        );
        saveProducts(next);
      }
      return res.json({
        success: failCount === 0,
        logs,
        successCount,
        failCount,
        total: logs.length,
        products: loadProducts()
      });
    } catch (error) {
      console.error("[Bulk Channel Sync]", error);
      return res.status(500).json({
        error: error?.message || "\u0110\u1ED3ng b\u1ED9 \u0111a k\xEAnh th\u1EA5t b\u1EA1i",
        logs: []
      });
    }
  });
  app.get("/api/suppliers", authMiddleware, (_req, res) => {
    return res.json(loadSuppliers());
  });
  app.post("/api/suppliers", authMiddleware, (req, res) => {
    const body = req.body || {};
    if (!body.name?.trim() || !body.supplierCode?.trim()) {
      return res.status(400).json({ error: "name_and_supplierCode_required" });
    }
    const suppliers = loadSuppliers();
    const code = String(body.supplierCode).trim().toUpperCase();
    if (suppliers.some((s) => s.supplierCode === code)) {
      return res.status(400).json({ error: "supplier_code_duplicate" });
    }
    const supplier = normalizeSupplier({
      id: `sup-${Date.now()}`,
      name: body.name,
      supplierCode: code,
      totalOrderValue: 0,
      totalPaid: 0,
      totalDebt: 0,
      status: body.status || "active"
    });
    suppliers.unshift(supplier);
    saveSuppliers(suppliers);
    return res.status(201).json({ supplier, suppliers });
  });
  app.put("/api/suppliers/:id", authMiddleware, (req, res) => {
    const suppliers = loadSuppliers();
    const index = suppliers.findIndex((s) => s.id === req.params.id);
    if (index === -1) {
      return res.status(404).json({ error: "supplier_not_found" });
    }
    const body = req.body || {};
    const code = body.supplierCode ? String(body.supplierCode).trim().toUpperCase() : suppliers[index].supplierCode;
    if (suppliers.some((s, i) => i !== index && s.supplierCode === code)) {
      return res.status(400).json({ error: "supplier_code_duplicate" });
    }
    const updated = normalizeSupplier({
      ...suppliers[index],
      ...body,
      id: suppliers[index].id,
      supplierCode: code
    });
    suppliers[index] = updated;
    saveSuppliers(suppliers);
    return res.json({ supplier: updated, suppliers });
  });
  app.delete("/api/suppliers/:id", authMiddleware, (req, res) => {
    const suppliers = loadSuppliers();
    const target = suppliers.find((s) => s.id === req.params.id);
    if (!target) {
      return res.status(404).json({ error: "supplier_not_found" });
    }
    if (target.totalDebt > 0) {
      return res.status(400).json({ error: "supplier_has_debt" });
    }
    const next = suppliers.filter((s) => s.id !== req.params.id);
    saveSuppliers(next);
    return res.json({ deleted: req.params.id, suppliers: next });
  });
  app.post("/api/suppliers/clear-all", authMiddleware, (_req, res) => {
    saveSuppliers([]);
    console.log("[Suppliers] \u0110\xE3 x\xF3a s\u1EA1ch to\xE0n b\u1ED9 d\u1EEF li\u1EC7u nh\xE0 cung c\u1EA5p.");
    return res.json({ success: true, cleared: true, suppliers: [] });
  });
  app.get("/api/imports", authMiddleware, (_req, res) => {
    return res.json(loadImports());
  });
  app.get("/api/imports/product-context/:productId", authMiddleware, (req, res) => {
    const productId = String(req.params.productId);
    const products = loadProducts();
    const product = products.find((p) => p.id === productId);
    if (!product) {
      return res.status(404).json({ error: "product_not_found" });
    }
    const imports = loadImports();
    const sku = String(product.sku || "");
    const history = imports.filter(
      (imp) => imp.productId === productId || sku && imp.productSku === sku
    );
    const latest = history.length > 0 ? [...history].sort((a, b) => {
      const tb = new Date(b.date || 0).getTime();
      const ta = new Date(a.date || 0).getTime();
      if (tb !== ta) return tb - ta;
      return String(b.id || "").localeCompare(String(a.id || ""));
    })[0] : null;
    return res.json({
      productId,
      oldPrice: Math.max(0, Math.round(Number(product.importPrice) || 0)),
      lastSupplierName: latest?.supplierName || null,
      lastSupplierId: latest?.supplierId || null,
      lastImportDate: latest?.date || null
    });
  });
  app.post("/api/imports", authMiddleware, (req, res) => {
    const body = req.body || {};
    if (!body.supplierId || !body.productId || !body.quantity || !body.newImportPrice) {
      return res.status(400).json({ error: "import_fields_required" });
    }
    const imports = loadImports();
    const qty = Math.max(1, Math.round(Number(body.quantity)));
    const unitPrice = Math.max(0, Math.round(Number(body.newImportPrice)));
    const importCost = Math.max(0, Math.round(Number(body.importCost) || 0));
    const computedTotal = qty * unitPrice + importCost;
    const entry = {
      id: body.id || `imp-${Date.now()}`,
      supplierId: String(body.supplierId),
      supplierName: String(body.supplierName || ""),
      date: body.date || (/* @__PURE__ */ new Date()).toISOString().split("T")[0],
      productId: String(body.productId),
      productTitle: String(body.productTitle || ""),
      productSku: String(body.productSku || ""),
      quantity: qty,
      oldImportPrice: Math.max(0, Math.round(Number(body.oldImportPrice) || 0)),
      newImportPrice: unitPrice,
      importCost,
      totalAmount: Math.max(0, Math.round(Number(body.totalAmount) || computedTotal)),
      paidAmount: Math.max(0, Math.round(Number(body.paidAmount) || 0)),
      status: body.status || "unpaid",
      notes: body.notes || void 0
    };
    imports.unshift(entry);
    saveImports(imports);
    return res.status(201).json({ import: entry, imports });
  });
  app.post("/api/imports/clear-all", authMiddleware, (_req, res) => {
    saveImports([]);
    console.log("[Imports] \u0110\xE3 x\xF3a s\u1EA1ch to\xE0n b\u1ED9 l\u1ECBch s\u1EED nh\u1EADp h\xE0ng.");
    return res.json({ success: true, cleared: true, imports: [] });
  });
  app.get("/api/expenses", authMiddleware, (_req, res) => {
    return res.json(loadExpenses());
  });
  app.post("/api/expenses", authMiddleware, (req, res) => {
    const body = req.body || {};
    if (!body.title?.trim() || !body.amount || !body.category || !body.date) {
      return res.status(400).json({ error: "expense_fields_required" });
    }
    const expenses = loadExpenses();
    const entry = {
      id: body.id || `exp-${Date.now()}`,
      title: String(body.title).trim(),
      amount: Math.max(0, Math.round(Number(body.amount))),
      category: String(body.category),
      date: String(body.date),
      notes: body.notes ? String(body.notes) : void 0
    };
    expenses.unshift(entry);
    saveExpenses(expenses);
    return res.status(201).json({ expense: entry, expenses });
  });
  app.delete("/api/expenses/:id", authMiddleware, (req, res) => {
    const expenses = loadExpenses();
    const next = expenses.filter((e) => e.id !== req.params.id);
    if (next.length === expenses.length) {
      return res.status(404).json({ error: "expense_not_found" });
    }
    saveExpenses(next);
    return res.json({ deleted: req.params.id, expenses: next });
  });
  app.post("/api/expenses/clear-all", authMiddleware, (_req, res) => {
    saveExpenses([]);
    console.log("[Expenses] \u0110\xE3 x\xF3a s\u1EA1ch to\xE0n b\u1ED9 chi ph\xED doanh nghi\u1EC7p.");
    return res.json({ success: true, cleared: true, expenses: [] });
  });
  app.get("/api/dashboard", authMiddleware, (req, res) => {
    try {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      const dateRange = String(req.query.date_range || "last_7_days");
      const range = getDashboardDateRange(dateRange);
      const allOrders = loadOrders();
      const orders = allOrders.filter(isDashboardOrder);
      const products = loadProducts();
      const ordersInRange = orders.filter(
        (o) => isDateInRange(String(o.date || ""), range.start, range.end)
      );
      const revenueOrders = ordersInRange.filter(
        (o) => o.status !== "cancelled" && Number(o.totalAmount) > 0
      );
      const totalRevenue = revenueOrders.reduce(
        (sum, o) => sum + (Number(o.totalAmount) || 0),
        0
      );
      const newOrderCount = ordersInRange.filter(
        (o) => o.status === "pending_confirm" || o.status === "unprocessed"
      ).length;
      const returnOrderCount = ordersInRange.filter(
        (o) => o.status === "return_pending" || o.status === "return_received"
      ).length;
      const cancelledOrderCount = ordersInRange.filter((o) => o.status === "cancelled").length;
      const pendingOrders = {
        pendingApproval: orders.filter((o) => o.status === "pending_confirm").length,
        pendingPayment: orders.filter(
          (o) => o.status === "pending_confirm" && o.channel === "manual"
        ).length,
        pendingPack: orders.filter(
          (o) => o.status === "unprocessed" && !o.isPrepared
        ).length,
        pendingPickup: orders.filter(
          (o) => o.status === "unprocessed" && o.isPrepared || o.status === "processed"
        ).length,
        shipping: orders.filter((o) => o.status === "shipping").length,
        returnPending: orders.filter((o) => o.status === "return_pending").length
      };
      const productSales = /* @__PURE__ */ new Map();
      for (const order of revenueOrders) {
        const items = Array.isArray(order.items) ? order.items : [];
        for (const item of items) {
          const pid = String(item.productId || "");
          if (!pid) continue;
          const prev = productSales.get(pid) || { productId: pid, quantitySold: 0 };
          prev.quantitySold += Math.max(0, Number(item.quantity) || 0);
          productSales.set(pid, prev);
        }
      }
      const topProducts = Array.from(productSales.values()).sort((a, b) => b.quantitySold - a.quantitySold).slice(0, 5).map((entry, idx) => {
        const prod = products.find((p) => p.id === entry.productId);
        const itemMeta = findOrderItemMeta(revenueOrders, entry.productId);
        return {
          rank: idx + 1,
          productId: entry.productId,
          title: prod?.title || itemMeta.title || entry.productId,
          sku: prod?.sku || "\u2014",
          imageUrl: prod?.avatarUrl || prod?.imageUrl || itemMeta.image || null,
          quantitySold: entry.quantitySold
        };
      });
      const LOW_STOCK_THRESHOLD = 5;
      const lowStockProducts = products.filter((p) => (Number(p.stock) || 0) < LOW_STOCK_THRESHOLD).map((p) => ({
        id: String(p.id),
        title: String(p.title || p.sku || p.id),
        sku: String(p.sku || ""),
        stock: Number(p.stock) || 0
      })).sort((a, b) => a.stock - b.stock);
      const chart = buildDashboardChart(revenueOrders, range);
      return res.json({
        dateRange: range.key,
        dateRangeLabel: range.label,
        startDate: toDateKey(range.start),
        endDate: toDateKey(range.end),
        meta: {
          totalOrdersInDb: allOrders.length,
          dashboardOrders: orders.length,
          ordersInRange: ordersInRange.length
        },
        kpi: {
          revenue: totalRevenue,
          newOrders: newOrderCount,
          returns: returnOrderCount,
          cancelled: cancelledOrderCount
        },
        pendingOrders,
        chart,
        topProducts,
        inventory: {
          lowStockThreshold: LOW_STOCK_THRESHOLD,
          lowStockProducts
        }
      });
    } catch (error) {
      console.error("[Dashboard API] Error:", error);
      return res.status(500).json({
        error: "dashboard_query_failed",
        message: error?.message || "Kh\xF4ng th\u1EC3 t\u1EA3i d\u1EEF li\u1EC7u dashboard."
      });
    }
  });
  app.get("/api/orders", authMiddleware, (req, res) => {
    const products = loadProducts();
    let rawOrders = loadOrders().filter(isValidOrder);
    let dirty = false;
    rawOrders = rawOrders.map((o) => {
      const before = `${o.trackingNumber || ""}|${o.internalTrackingCode || ""}`;
      repairMisassignedTracking(o);
      const after = `${o.trackingNumber || ""}|${o.internalTrackingCode || ""}`;
      if (before !== after) dirty = true;
      return o;
    });
    if (dirty) saveOrders(rawOrders);
    const orders = enrichOrdersFromCatalog(rawOrders, products);
    return res.json(orders);
  });
  function normalizeScanLookupKey(raw) {
    return String(raw || "").trim().toUpperCase().replace(/[\s\-_#./\\|:;,]+/g, "");
  }
  function buildScanLookupKeys(raw) {
    const text = String(raw || "").trim();
    if (!text) return [];
    const keys = /* @__PURE__ */ new Set();
    const add = (v) => {
      const normalized = normalizeScanLookupKey(String(v || ""));
      if (normalized.length >= 4) keys.add(normalized);
    };
    add(text);
    add(text.replace(/^#+/, ""));
    if (/^https?:\/\//i.test(text)) {
      try {
        const url = new URL(text);
        [
          "tracking",
          "tracking_no",
          "tracking_number",
          "tn",
          "order_sn",
          "ordersn",
          "order",
          "order_id",
          "package_number",
          "code",
          "sn"
        ].forEach((p) => {
          const v = url.searchParams.get(p);
          if (v) add(v);
        });
        url.pathname.split("/").filter(Boolean).forEach(add);
      } catch {
      }
    }
    if (text.startsWith("{") || text.startsWith("[")) {
      try {
        const parsed = JSON.parse(text);
        [
          "tracking_number",
          "trackingNumber",
          "tracking_no",
          "trackingNo",
          "order_sn",
          "orderSn",
          "package_number",
          "packageNumber"
        ].forEach((k) => {
          if (parsed?.[k]) add(parsed[k]);
        });
      } catch {
      }
    }
    return [...keys];
  }
  function flexibleScanCodeMatch(scanKey, fieldKey) {
    if (!scanKey || !fieldKey) return false;
    if (scanKey === fieldKey) return true;
    if (scanKey.length >= 10 && fieldKey.length >= 10) {
      return fieldKey.endsWith(scanKey) || scanKey.endsWith(fieldKey);
    }
    return false;
  }
  function findOrderByScanLookup(orders, raw) {
    const scanKeys = buildScanLookupKeys(raw);
    if (!scanKeys.length) return null;
    const idx = getOrderLookupIndex(orders);
    for (const sk of scanKeys) {
      for (const map of [idx.byTracking, idx.byInternal, idx.byOrderSn, idx.byPackage, idx.byId]) {
        const hit = map.get(sk);
        if (hit !== void 0) return orders[hit];
      }
    }
    const trackingLike = /^SPX(VN)?|^GHN|^GHTK|^JNT|^JT|^NINJA|^VTP|^VNPOST/.test(
      normalizeScanLookupKey(raw)
    );
    if (trackingLike) {
      for (const order of orders) {
        const trackingKey = order.trackingNumber ? normalizeScanLookupKey(order.trackingNumber) : "";
        const internalKey = order.internalTrackingCode ? normalizeScanLookupKey(order.internalTrackingCode) : "";
        if (trackingKey && scanKeys.some((sk) => flexibleScanCodeMatch(sk, trackingKey))) return order;
        if (internalKey && scanKeys.some((sk) => flexibleScanCodeMatch(sk, internalKey))) return order;
      }
    }
    const internalLike = /^0FG/.test(normalizeScanLookupKey(raw));
    if (internalLike) {
      for (const order of orders) {
        const internalKey = order.internalTrackingCode ? normalizeScanLookupKey(order.internalTrackingCode) : "";
        if (internalKey && scanKeys.some((sk) => flexibleScanCodeMatch(sk, internalKey))) return order;
      }
    }
    for (const order of orders) {
      const orderSnKey = normalizeScanLookupKey(order.orderSn);
      const trackingKey = order.trackingNumber ? normalizeScanLookupKey(order.trackingNumber) : "";
      const internalKey = order.internalTrackingCode ? normalizeScanLookupKey(order.internalTrackingCode) : "";
      const packageKey = order.packageNumber ? normalizeScanLookupKey(order.packageNumber) : "";
      const idKey = normalizeScanLookupKey(String(order.id || "").replace(/^shopee-/i, ""));
      const matched = scanKeys.some(
        (sk) => flexibleScanCodeMatch(sk, orderSnKey) || flexibleScanCodeMatch(sk, trackingKey) || flexibleScanCodeMatch(sk, internalKey) || flexibleScanCodeMatch(sk, packageKey) || flexibleScanCodeMatch(sk, idKey)
      );
      if (matched) return order;
    }
    return null;
  }
  app.get("/api/orders/lookup", authMiddleware, (req, res) => {
    const code = String(req.query.code || req.query.q || "").trim();
    if (!code) {
      return res.status(400).json({ error: "Thi\u1EBFu m\xE3 qu\xE9t (code)." });
    }
    const products = loadProducts();
    const orders = enrichOrdersFromCatalog(loadOrders().filter(isValidOrder), products);
    const found = findOrderByScanLookup(orders, code);
    if (!found) {
      return res.status(404).json({
        error: "Kh\xF4ng t\xECm th\u1EA5y \u0111\u01A1n h\xE0ng kh\u1EDBp m\xE3 qu\xE9t.",
        scannedCode: code
      });
    }
    return res.json(found);
  });
  app.post("/api/orders/cleanup-mock", authMiddleware, (req, res) => {
    const orders = loadOrders();
    const validOrders = orders.filter(isValidOrder);
    const removedOrders = orders.filter((o) => !isValidOrder(o));
    saveOrders(validOrders);
    console.log(
      `[Orders Cleanup] \u0110\xE3 x\xF3a ${removedOrders.length} \u0111\u01A1n h\xE0ng l\u1ED7i/mock (0\u0111 v\xE0 kh\xF4ng c\xF3 s\u1EA3n ph\u1EA9m). C\xF2n l\u1EA1i ${validOrders.length} \u0111\u01A1n th\u1EAD t.`,
      removedOrders.map((o) => o.orderSn || o.id)
    );
    return res.json({
      removed: removedOrders.length,
      remaining: validOrders.length,
      removedOrderSns: removedOrders.map((o) => o.orderSn || o.id)
    });
  });
  app.patch("/api/orders/:id", authMiddleware, (req, res) => {
    const orders = loadOrders();
    const index = orders.findIndex((o) => o.id === req.params.id);
    if (index === -1) {
      return res.status(404).json({ error: "Kh\xF4ng t\xECm th\u1EA5y \u0111\u01A1n h\xE0ng." });
    }
    orders[index] = { ...orders[index], ...req.body, id: orders[index].id };
    saveOrders(orders);
    return res.json(orders[index]);
  });
  const VN_ADDRESS_API = "https://provinces.open-api.vn/api";
  let vnProvincesCache = null;
  const vnDistrictsCache = /* @__PURE__ */ new Map();
  const vnWardsCache = /* @__PURE__ */ new Map();
  const fetchVnJson = async (url) => {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`VN address API ${res.status}`);
    return res.json();
  };
  app.get("/api/vietnam-address/provinces", authMiddleware, async (_req, res) => {
    try {
      if (!vnProvincesCache) {
        vnProvincesCache = await fetchVnJson(`${VN_ADDRESS_API}/p/`);
      }
      const list = (vnProvincesCache || []).map((p) => ({
        name: p.name,
        code: p.code
      }));
      return res.json(list);
    } catch (error) {
      console.error("[VN Address] provinces:", error);
      return res.status(502).json({ error: "Kh\xF4ng t\u1EA3i \u0111\u01B0\u1EE3c danh s\xE1ch T\u1EC9nh/Th\xE0nh" });
    }
  });
  app.get("/api/vietnam-address/districts/:provinceCode", authMiddleware, async (req, res) => {
    try {
      const provinceCode = Number(req.params.provinceCode);
      if (!provinceCode) return res.json([]);
      if (!vnDistrictsCache.has(provinceCode)) {
        const data = await fetchVnJson(`${VN_ADDRESS_API}/p/${provinceCode}?depth=2`);
        const districts = Array.isArray(data?.districts) ? data.districts : [];
        vnDistrictsCache.set(
          provinceCode,
          districts.map((d) => ({ name: d.name, code: d.code }))
        );
      }
      return res.json(vnDistrictsCache.get(provinceCode) || []);
    } catch (error) {
      console.error("[VN Address] districts:", error);
      return res.status(502).json({ error: "Kh\xF4ng t\u1EA3i \u0111\u01B0\u1EE3c danh s\xE1ch Qu\u1EADn/Huy\u1EC7n" });
    }
  });
  app.get("/api/vietnam-address/wards/:districtCode", authMiddleware, async (req, res) => {
    try {
      const districtCode = Number(req.params.districtCode);
      if (!districtCode) return res.json([]);
      if (!vnWardsCache.has(districtCode)) {
        const data = await fetchVnJson(`${VN_ADDRESS_API}/d/${districtCode}?depth=2`);
        const wards = Array.isArray(data?.wards) ? data.wards : [];
        vnWardsCache.set(
          districtCode,
          wards.map((w) => ({ name: w.name, code: w.code }))
        );
      }
      return res.json(vnWardsCache.get(districtCode) || []);
    } catch (error) {
      console.error("[VN Address] wards:", error);
      return res.status(502).json({ error: "Kh\xF4ng t\u1EA3i \u0111\u01B0\u1EE3c danh s\xE1ch Ph\u01B0\u1EDDng/X\xE3" });
    }
  });
  const buildCarrierLogisticsPayload = (carrier, customer, addr, extras) => {
    if (carrier === "ghn") {
      return {
        provider: "ghn",
        to_name: customer.name,
        to_phone: customer.phone,
        to_address: addr.street,
        to_ward_code: addr.wardCode,
        to_district_id: Number(addr.districtCode),
        to_province_id: Number(addr.provinceCode),
        to_ward_name: addr.ward,
        to_district_name: addr.district,
        to_province_name: addr.province,
        weight: extras.weight,
        note: extras.note,
        cod_amount: extras.codAmount
      };
    }
    if (carrier === "spx") {
      return {
        provider: "spx",
        deliver_info: {
          deliver_name: customer.name,
          deliver_phone: customer.phone,
          deliver_detail_address: addr.street,
          deliver_ward: addr.ward,
          deliver_district: addr.district,
          deliver_province: addr.province,
          deliver_ward_id: addr.wardCode,
          deliver_district_id: addr.districtCode,
          deliver_province_id: addr.provinceCode
        },
        parcel_weight: extras.weight,
        remark: extras.note,
        cod_amount: extras.codAmount
      };
    }
    return null;
  };
  const generateCarrierTracking = (carrier) => {
    if (carrier === "ghn") return `GHN-VN-${Math.floor(1e8 + Math.random() * 9e8)}`;
    if (carrier === "spx") return `SPX-VN-${Math.floor(1e8 + Math.random() * 9e8)}`;
    return `DIRECT-${Math.floor(1e5 + Math.random() * 9e5)}`;
  };
  app.post("/api/orders/manual", authMiddleware, (req, res) => {
    try {
      const body = req.body || {};
      const {
        shippingAddress,
        items,
        carrier = "self",
        packageWeight = 500,
        shippingFee = 0,
        orderDiscount = 0,
        carrierNotes = ""
      } = body;
      const addr = shippingAddress || {};
      if (!addr.provinceCode || !addr.districtCode || !addr.wardCode || !addr.street?.trim()) {
        return res.status(400).json({
          error: "\u0110\u1ECBa ch\u1EC9 ch\u01B0a \u0111\u1EA7y \u0111\u1EE7. Vui l\xF2ng ch\u1ECDn T\u1EC9nh, Qu\u1EADn/Huy\u1EC7n, Ph\u01B0\u1EDDng/X\xE3 v\xE0 nh\u1EADp \u0111\u1ECBa ch\u1EC9 chi ti\u1EBFt."
        });
      }
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: "\u0110\u01A1n h\xE0ng c\u1EA7n \xEDt nh\u1EA5t 1 s\u1EA3n ph\u1EA9m." });
      }
      const subtotal = items.reduce(
        (acc, it) => acc + Number(it.price || 0) * Number(it.quantity || 0),
        0
      );
      const totalAmount = subtotal + Number(shippingFee) - Number(orderDiscount);
      const fullAddress = [addr.street, addr.ward, addr.district, addr.province].filter(Boolean).join(", ");
      const trackingNumber = generateCarrierTracking(carrier);
      const logisticsPayload = carrier !== "self" ? buildCarrierLogisticsPayload(
        carrier,
        { name: "Kh\xE1ch s\u1EC9", phone: "0900000000" },
        {
          street: addr.street.trim(),
          province: addr.province,
          provinceCode: String(addr.provinceCode),
          district: addr.district,
          districtCode: String(addr.districtCode),
          ward: addr.ward,
          wardCode: String(addr.wardCode)
        },
        {
          weight: Number(packageWeight) || 500,
          note: carrierNotes || "",
          codAmount: totalAmount
        }
      ) : null;
      if (logisticsPayload) {
        console.log(
          `[Logistics ${carrier.toUpperCase()}] Payload \u0111\u1EA9y \u0111\u01A1n:`,
          JSON.stringify(logisticsPayload, null, 2)
        );
      }
      const newOrder = {
        id: `order-manual-${Date.now()}`,
        orderSn: `DON-NGOAI-${Math.floor(1e5 + Math.random() * 9e5)}`,
        channel: "manual",
        shippingAddress: {
          province: addr.province,
          provinceCode: String(addr.provinceCode),
          district: addr.district,
          districtCode: String(addr.districtCode),
          ward: addr.ward,
          wardCode: String(addr.wardCode),
          street: addr.street.trim(),
          fullAddress
        },
        carrier,
        totalAmount,
        revenue: totalAmount,
        status: "unprocessed",
        date: (/* @__PURE__ */ new Date()).toISOString(),
        trackingNumber,
        isPrepared: carrier !== "self",
        isPrinted: false,
        items: items.map((it) => ({
          productId: it.productId,
          productTitle: it.productTitle,
          productImage: it.productImage,
          quantity: Number(it.quantity),
          price: Number(it.price)
        })),
        logisticsPayload
      };
      const orders = loadOrders();
      orders.unshift(newOrder);
      saveOrders(orders);
      return res.json({
        success: true,
        order: newOrder,
        trackingNumber,
        logisticsPayload,
        orders: orders.filter(isValidOrder)
      });
    } catch (error) {
      console.error("[Orders manual]", error);
      return res.status(500).json({ error: error.message || "T\u1EA1o \u0111\u01A1n th\u1EE7 c\xF4ng th\u1EA5t b\u1EA1i" });
    }
  });
  app.post("/api/shopee/orders/sync", authMiddleware, async (req, res) => {
    if (!SHOPEE_PARTNER_ID || !SHOPEE_PARTNER_KEY) {
      return res.status(500).json({
        error: "Thi\u1EBFu SHOPEE_PARTNER_ID / SHOPEE_PARTNER_KEY (Live) trong file .env."
      });
    }
    const tokens = loadShopeeTokens();
    if (Object.keys(tokens).length === 0) {
      return res.json({ synced: 0, orders: [], warning: "Ch\u01B0a c\xF3 shop Shopee Live n\xE0o \u0111\u01B0\u1EE3c \u1EE7y quy\u1EC1n." });
    }
    console.log(`[Shopee Sync] B\u1EAFt \u0111\u1EA7u \u0111\u1ED3ng b\u1ED9 \u0111\u01A1n ${SHOPEE_SYNC_STATUSES.join(" + ")} (15 ng\xE0y, l\u1EADt trang cursor)...`);
    const result = await syncShopeeOrdersFromApi([...SHOPEE_SYNC_STATUSES]);
    console.log(`[Shopee Sync] Ho\xE0n t\u1EA5t: ${result.synced} \u0111\u01A1n (${result.added} m\u1EDBi, ${result.updated} c\u1EADp nh\u1EADt).`);
    return res.json({
      synced: result.synced,
      added: result.added,
      updated: result.updated,
      orders: result.orders,
      statusCounts: result.statusCounts,
      uiStatusCounts: result.uiStatusCounts,
      errors: result.errors,
      warning: result.synced === 0 && !result.errors ? `Kh\xF4ng t\xECm th\u1EA5y \u0111\u01A1n ${SHOPEE_SYNC_STATUSES.join("/")} n\xE0o trong 15 ng\xE0y g\u1EA7n nh\u1EA5t.` : void 0
    });
  });
  app.post("/api/orders/pull", authMiddleware, async (req, res) => {
    if (!SHOPEE_PARTNER_ID || !SHOPEE_PARTNER_KEY) {
      return res.status(500).json({
        error: "Thi\u1EBFu SHOPEE_PARTNER_ID / SHOPEE_PARTNER_KEY (Live) trong file .env. Vui l\xF2ng c\u1EA5u h\xECnh tr\u01B0\u1EDBc khi k\xE9o \u0111\u01A1n."
      });
    }
    const tokens = loadShopeeTokens();
    const shopIds = Object.keys(tokens);
    if (shopIds.length === 0) {
      console.warn("[Shopee API] Kh\xF4ng c\xF3 shop_id n\xE0o \u0111\xE3 li\xEAn k\u1EBFt OAuth th\u1EADt. H\xE3y li\xEAn k\u1EBFt shop qua /api/shopee/callback tr\u01B0\u1EDBc.");
      return res.json({ pulled: 0, orders: [], warning: "Ch\u01B0a c\xF3 shop Shopee Live n\xE0o \u0111\u01B0\u1EE3c \u1EE7y quy\u1EC1n." });
    }
    const orders = loadOrders();
    let pulledCount = 0;
    const errors = [];
    for (const shopId of shopIds) {
      try {
        const accessToken = await getValidShopeeAccessToken(shopId);
        if (!accessToken) {
          errors.push({ shopId, error: "no_valid_access_token" });
          continue;
        }
        const orderSnList = await shopeeFetchAllOrderSns(shopId, accessToken);
        console.log(`[Shopee API] Shop ${shopId}: t\xECm th\u1EA5y ${orderSnList.length} \u0111\u01A1n h\xE0ng trong 15 ng\xE0y g\u1EA7n nh\u1EA5t (\u0111\xE3 l\u1EADt trang \u0111\u1EE7).`);
        if (orderSnList.length === 0) continue;
        for (let i = 0; i < orderSnList.length; i += 50) {
          const batch = orderSnList.slice(i, i + 50);
          const detailResult = await shopeeGetOrderDetail(shopId, accessToken, batch);
          if (detailResult.error) {
            errors.push({ shopId, error: detailResult.error, message: detailResult.message });
            continue;
          }
          const detailList = detailResult.response?.order_list || [];
          for (const detail of detailList) {
            const normalized = normalizeShopeeOrderDetail(shopId, detail.shop_name, detail);
            const existingIndex = orders.findIndex((o) => o.orderSn === normalized.orderSn);
            if (existingIndex >= 0) {
              orders[existingIndex] = mergeShopeeOrderOnSync(orders[existingIndex], normalized);
            } else {
              orders.unshift(normalized);
            }
            pulledCount++;
          }
        }
      } catch (error) {
        console.error(`[Shopee API] L\u1ED7i khi k\xE9o \u0111\u01A1n cho shop_id=${shopId}:`, error);
        errors.push({ shopId, error: error.message || "unknown_error" });
      }
    }
    saveOrders(orders);
    console.log(`[Shopee API] Ho\xE0n t\u1EA5t k\xE9o \u0111\u01A1n: ${pulledCount} \u0111\u01A1n \u0111\xE3 \u0111\u01B0\u1EE3c c\u1EADp nh\u1EADt/th\xEAm m\u1EDBi.`);
    return res.json({ pulled: pulledCount, orders: orders.filter(isValidOrder), errors: errors.length ? errors : void 0 });
  });
  app.get("/api/shopee/diagnostics", authMiddleware, async (req, res) => {
    const shopId = req.query.shop_id ? String(req.query.shop_id) : void 0;
    console.log("[Shopee Diagnostics] B\u1EAFt \u0111\u1EA7u ki\u1EC3m tra...", shopId ? `shop_id=${shopId}` : "");
    const report = await runShopeeConnectivityDiagnostics(shopId);
    console.log("[Shopee Diagnostics] K\u1EBFt qu\u1EA3:", JSON.stringify(report, null, 2));
    return res.status(report.ok ? 200 : 502).json({
      success: report.ok,
      summary: report.code,
      ...report,
      checkedAt: (/* @__PURE__ */ new Date()).toISOString(),
      backend: "cpanel-node"
    });
  });
  app.get("/api/shopee/force-sync", authMiddleware, async (req, res) => {
    console.log("[Shopee Force-Sync] ==== B\u1EAFt \u0111\u1EA7u ki\u1EC3m tra th\u1EE7 c\xF4ng ====");
    if (!isShopeeConfigValid()) {
      const msg = `SHOPEE_PARTNER_ID/SHOPEE_PARTNER_KEY trong .env ch\u01B0a h\u1EE3p l\u1EC7 (hi\u1EC7n t\u1EA1i partner_id="${SHOPEE_PARTNER_ID}"). \u0110\xE2y ph\u1EA3i l\xE0 Live Partner ID (s\u1ED1 nguy\xEAn) v\xE0 Live Partner Key th\u1EF1c t\u1EEB open.shopee.com.`;
      console.error(`[Shopee Force-Sync] \u274C ${msg}`);
      return res.status(500).json({ step: "config_check", ok: false, error: msg });
    }
    const tokens = loadShopeeTokens();
    const availableShopIds = Object.keys(tokens);
    console.log(`[Shopee Force-Sync] C\xE1c shop_id \u0111\xE3 l\u01B0u token trong data/shopee_tokens.json: [${availableShopIds.join(", ") || "kh\xF4ng c\xF3"}]`);
    const shopId = String(req.query.shop_id || availableShopIds[0] || "");
    if (!shopId) {
      const msg = "Ch\u01B0a c\xF3 shop_id n\xE0o \u0111\u01B0\u1EE3c l\u01B0u trong data/shopee_tokens.json. Ngh\u0129a l\xE0 lu\u1ED3ng OAuth /api/shopee/callback ch\u01B0a t\u1EEBng \u0111\u1ED5i code th\xE0nh access_token th\xE0nh c\xF4ng. H\xE3y b\u1EA5m l\u1EA1i n\xFAt \u1EE7y quy\u1EC1n shop tr\xEAn Shopee v\xE0 xem log [Shopee OAuth] khi callback ch\u1EA1y.";
      console.error(`[Shopee Force-Sync] \u274C ${msg}`);
      return res.status(404).json({ step: "token_lookup", ok: false, error: msg, availableShopIds });
    }
    const tokenRecord = tokens[shopId];
    if (!tokenRecord) {
      const msg = `Kh\xF4ng t\xECm th\u1EA5y token \u0111\xE3 l\u01B0u cho shop_id=${shopId}.`;
      console.error(`[Shopee Force-Sync] \u274C ${msg}`);
      return res.status(404).json({ step: "token_lookup", ok: false, error: msg, availableShopIds });
    }
    console.log(`[Shopee Force-Sync] \u0110\xE3 t\xECm th\u1EA5y token cho shop_id=${shopId}. obtained_at=${tokenRecord.obtained_at}, expire_in=${tokenRecord.expire_in}s.`);
    try {
      const accessToken = await getValidShopeeAccessToken(shopId);
      if (!accessToken) {
        const msg = `Kh\xF4ng l\u1EA5y \u0111\u01B0\u1EE3c access_token h\u1EE3p l\u1EC7 cho shop_id=${shopId} (c\xF3 th\u1EC3 refresh_token \u0111\xE3 h\u1EBFt h\u1EA1n, c\u1EA7n \u1EE7y quy\u1EC1n l\u1EA1i t\u1EEB \u0111\u1EA7u).`;
        console.error(`[Shopee Force-Sync] \u274C ${msg}`);
        return res.status(401).json({ step: "access_token", ok: false, error: msg });
      }
      console.log(`[Shopee Force-Sync] access_token \u0111ang d\xF9ng: ${accessToken.slice(0, 8)}... (\u0111\xE3 r\xFAt g\u1ECDn \u0111\u1EC3 b\u1EA3o m\u1EADt)`);
      const listResult = await shopeeGetOrderList(shopId, accessToken);
      console.log("[Shopee Force-Sync] === RAW RESPONSE t\u1EEB v2.order.get_order_list ===");
      console.log(JSON.stringify(listResult, null, 2));
      return res.json({
        step: "get_order_list",
        ok: !listResult.error,
        shopId,
        rawResponse: listResult,
        orderCount: listResult.response?.order_list?.length ?? 0
      });
    } catch (error) {
      console.error("[Shopee Force-Sync] \u274C Exception:", error);
      return res.status(500).json({ step: "exception", ok: false, error: error.message || String(error) });
    }
  });
  app.post("/api/shopee/products/sync", authMiddleware, async (req, res) => {
    if (!isShopeeConfigValid()) {
      return res.status(500).json({ error: "invalid_partner_config", message: "SHOPEE_PARTNER_ID/SHOPEE_PARTNER_KEY trong .env ch\u01B0a h\u1EE3p l\u1EC7." });
    }
    const tokens = loadShopeeTokens();
    const shopId = resolveShopeeTokenShopId(req.body?.shopId);
    if (!shopId) {
      return res.status(404).json({ error: "no_shopee_shop_linked", message: "Ch\u01B0a c\xF3 shop Shopee n\xE0o \u0111\u01B0\u1EE3c \u1EE7y quy\u1EC1n." });
    }
    const accessToken = await getValidShopeeAccessToken(shopId);
    if (!accessToken) {
      return res.status(401).json({ error: "no_valid_access_token", message: `Ch\u01B0a c\xF3 access_token h\u1EE3p l\u1EC7 cho shop_id=${shopId}.` });
    }
    try {
      console.log(`[Shopee Product Sync] B\u1EAFt \u0111\u1EA7u \u0111\u1ED3ng b\u1ED9 kho cho shop_id=${shopId}...`);
      const result = await runFullShopeeWarehouseSync(shopId, accessToken);
      return res.json(result);
    } catch (error) {
      console.error("[Shopee Product Sync] Exception:", error);
      return res.status(500).json({ error: "exception", message: error.message || String(error) });
    }
  });
  app.post("/api/shopee/products/sync-item-variants", authMiddleware, async (req, res) => {
    if (!isShopeeConfigValid()) {
      return res.status(500).json({ error: "invalid_partner_config" });
    }
    const rawItemId = String(req.body?.itemId || req.body?.shopeeItemId || req.body?.productId || "");
    const itemIdMatch = rawItemId.match(/(\d{6,})/);
    if (!itemIdMatch) {
      return res.status(400).json({ error: "itemId_required", message: "Kh\xF4ng x\xE1c \u0111\u1ECBnh \u0111\u01B0\u1EE3c item_id Shopee." });
    }
    const itemId = Number(itemIdMatch[1]);
    const shopId = resolveShopeeTokenShopId(req.body?.shopId);
    if (!shopId) {
      return res.status(404).json({ error: "no_shopee_shop", message: "Ch\u01B0a c\xF3 shop Shopee \u0111\u01B0\u1EE3c \u1EE7y quy\u1EC1n." });
    }
    const accessToken = await getValidShopeeAccessToken(shopId);
    if (!accessToken) {
      return res.status(401).json({ error: "no_valid_access_token" });
    }
    try {
      const { variantProducts, error, modelCount } = await fetchShopeeItemVariants(shopId, accessToken, itemId);
      if (error && variantProducts.length === 0) {
        return res.status(400).json({ error, message: error });
      }
      if (variantProducts.length === 0) {
        return res.status(404).json({ error: "no_variants_found", message: "Kh\xF4ng l\u1EA5y \u0111\u01B0\u1EE3c ph\xE2n lo\u1EA1i t\u1EEB Shopee." });
      }
      const allProducts = loadProducts();
      const merged = replaceProductsForShopeeItem(allProducts, String(itemId), variantProducts);
      saveProducts(merged);
      console.log(`[Shopee Variant Sync] item_id=${itemId} -> ${variantProducts.length} dong (modelCount=${modelCount})`);
      return res.json({
        itemId: String(itemId),
        variantCount: variantProducts.length,
        modelCount,
        variants: variantProducts,
        products: merged
      });
    } catch (err) {
      console.error("[Shopee Variant Sync] Exception:", err);
      return res.status(500).json({ error: "exception", message: err.message || String(err) });
    }
  });
  async function processShipOrderBatch(orders, toShip, shipMethod, opts) {
    const results = [];
    const successfulShopeeOrders = [];
    for (let i = 0; i < toShip.length; i++) {
      const { index, order } = toShip[i];
      const resolvedShopId = resolveOrderShopId(order);
      if (resolvedShopId && !order.shopId) {
        orders[index].shopId = resolvedShopId;
        order.shopId = resolvedShopId;
      }
      console.log(`[Ship Order Bulk] \u0110ang x\u1EED l\xFD \u0111\u01A1n ${order.orderSn} (id=${order.id}, ${shipMethod})...`);
      const result = await arrangeShipment(order, shipMethod);
      const treatedAsSuccess = result.success || isAlreadyShippedError(result);
      if (!treatedAsSuccess) {
        console.error(`[Ship Order Bulk] TH\u1EA4T B\u1EA0I cho \u0111\u01A1n ${order.orderSn} -> error="${result.error || ""}" message="${result.message || ""}"`);
        if (opts?.optimistic) {
          orders[index] = {
            ...orders[index],
            status: "unprocessed",
            isPrepared: false,
            shopeeSyncPending: false,
            shopeeSyncError: result.message || result.error || "Kh\xF4ng \u0111\u1ED3ng b\u1ED9 \u0111\u01B0\u1EE3c Shopee"
          };
        }
      } else {
        orders[index] = {
          ...orders[index],
          isPrepared: true,
          status: "processed",
          trackingNumber: orders[index].trackingNumber || result.trackingNumber,
          shopId: orders[index].shopId || result.shopId || resolvedShopId,
          shopeeSyncPending: false,
          shopeeSyncError: void 0
        };
        if (orders[index].channel === "shopee") {
          successfulShopeeOrders.push(orders[index]);
        }
      }
      results.push({
        orderId: order.id,
        orderSn: order.orderSn,
        success: treatedAsSuccess,
        alreadyShipped: !result.success && isAlreadyShippedError(result),
        ...result
      });
      if (opts?.onProgress) opts.onProgress(i + 1, toShip.length);
      if (i < toShip.length - 1) {
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    return {
      results,
      successfulShopeeOrders,
      successCount: results.filter((r) => r.success).length
    };
  }
  app.post("/api/shopee/ship-order", authMiddleware, async (req, res) => {
    const { orderId, method } = req.body;
    const shipMethod = method === "dropoff" ? "dropoff" : "pickup";
    const orders = loadOrders();
    const order = orders.find((o) => o.id === orderId);
    if (!order) {
      return res.status(404).json({ error: "Kh\xF4ng t\xECm th\u1EA5y \u0111\u01A1n h\xE0ng." });
    }
    console.log(`[Ship Order] Y\xEAu c\u1EA7u chu\u1EA9n b\u1EB1 h\xE0ng (${shipMethod}) cho \u0111\u01A1n ${order.orderSn} (channel=${order.channel})...`);
    const result = await arrangeShipment(order, shipMethod);
    console.log("D\u1EEE LI\u1EC6U SHOPEE TR\u1EA2 V\u1EC0:", JSON.stringify(result));
    if (!result.success) {
      console.error(`[Ship Order] TH\u1EA4T B\u1EA0I cho \u0111\u01A1n ${order.orderSn} -> error="${result.error || ""}" message="${result.message || ""}"`);
    }
    if (result.success) {
      const index = orders.findIndex((o) => o.id === orderId);
      orders[index] = {
        ...orders[index],
        isPrepared: true,
        // Move the order into "Chờ lấy hàng (Đã xử lý)" the INSTANT ship_order
        // succeeds — no need to wait for the print step to flip this anymore.
        status: "processed",
        trackingNumber: orders[index].trackingNumber || result.trackingNumber,
        shopId: orders[index].shopId || result.shopId
        // self-heal orders that lost shop_id from an old webhook bug
      };
      saveOrders(orders);
      return res.json({ success: true, mode: result.mode, order: orders[index] });
    }
    return res.status(400).json({ success: false, ...result });
  });
  app.post("/api/shopee/ship-order/bulk", authMiddleware, async (req, res) => {
    const { orderIds, orderSns, method } = req.body;
    const shipMethod = method === "dropoff" ? "dropoff" : "pickup";
    const idList = Array.isArray(orderIds) ? orderIds : [];
    const snList = Array.isArray(orderSns) ? orderSns : [];
    if (idList.length === 0 && snList.length === 0) {
      return res.status(400).json({ error: "Thi\u1EBFu danh s\xE1ch orderIds ho\u1EB7c orderSns." });
    }
    const orders = loadOrders();
    const toShip = resolveOrdersFromRequest(orders, idList, snList);
    if (toShip.length === 0) {
      return res.status(404).json({
        error: "orders_not_found",
        message: "Kh\xF4ng t\xECm th\u1EA5y \u0111\u01A1n n\xE0o trong database kh\u1EDBp v\u1EDBi danh s\xE1ch g\u1EEDi l\xEAn.",
        successCount: 0,
        total: 0,
        results: [],
        orders: orders.filter(isValidOrder)
      });
    }
    const results = [];
    const successfulShopeeOrders = [];
    const batch = await processShipOrderBatch(orders, toShip, shipMethod);
    results.push(...batch.results);
    successfulShopeeOrders.push(...batch.successfulShopeeOrders);
    saveOrders(orders);
    const successCount = batch.successCount;
    console.log(`[Ship Order Bulk] Ho\xE0n t\u1EA5t: ${successCount}/${toShip.length} \u0111\u01A1n chu\u1EA9n b\u1EB1 h\xE0ng th\xE0nh c\xF4ng.`);
    console.log("D\u1EEE LI\u1EC6U SHOPEE TR\u1EA2 V\u1EC0 (ship-order/bulk response g\u1EEDi cho Frontend):", JSON.stringify({ successCount, total: toShip.length, results }));
    const failedResults = results.filter((r) => !r.success);
    if (failedResults.length > 0) {
      console.error(`[Ship Order Bulk] ${failedResults.length} \u0111\u01A1n L\u1ED6I chi ti\u1EBFt:`);
      for (const f of failedResults) {
        console.error(`   - \u0111\u01A1n ${f.orderSn || f.orderId}: error="${f.error || ""}" message="${f.message || ""}"`);
      }
    }
    let printDocument = null;
    if (successfulShopeeOrders.length > 0) {
      console.log(`[Ship Order Bulk] T\u1EF1 \u0111\u1ED9ng l\u1EA5y v\u1EAD n g\u1ED9p cho ${successfulShopeeOrders.length} \u0111\u01A1n Shopee v\u1EEBa chu\u1EA9n b\u1EB1...`);
      printDocument = await autoPrintLabelsForShopeeOrders(orders, successfulShopeeOrders);
      if (printDocument?.printedOrderSns?.length) {
        const printedSet = new Set(printDocument.printedOrderSns);
        for (let i = 0; i < orders.length; i++) {
          if (printedSet.has(orders[i].orderSn)) {
            orders[i] = { ...orders[i], isPrinted: true, status: "processed" };
          }
        }
        saveOrders(orders);
      }
    }
    return res.json({
      successCount,
      total: toShip.length,
      results,
      orders: orders.filter(isValidOrder),
      printDocument
    });
  });
  import_fs.default.mkdirSync(SHIPPING_DOCS_DIR, { recursive: true });
  app.get("/labels/:filename", (req, res, next) => {
    const result = serveLabelPdfFromDisk(req.params.filename, res);
    if (result === "not_found") return next();
  });
  app.use("/labels", import_express.default.static(SHIPPING_DOCS_DIR, {
    setHeaders(res, filePath) {
      if (filePath.endsWith(".pdf")) {
        const name = import_path.default.basename(filePath);
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `inline; filename="${name}"`);
      } else if (filePath.endsWith(".html")) {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
      }
      res.setHeader("Cache-Control", "no-store");
    }
  }));
  function extensionForContentType(contentType) {
    if (contentType.includes("zip")) return "zip";
    if (contentType.includes("html")) return "html";
    return "pdf";
  }
  async function mergePdfBuffers(buffers) {
    if (buffers.length === 0) throw new Error("No PDF buffers to merge.");
    if (buffers.length === 1) return buffers[0];
    const mergedPdf = await import_pdf_lib.PDFDocument.create();
    for (const buf of buffers) {
      const src = await import_pdf_lib.PDFDocument.load(buf);
      const pages = await mergedPdf.copyPages(src, src.getPageIndices());
      for (const page of pages) mergedPdf.addPage(page);
    }
    return Buffer.from(await mergedPdf.save());
  }
  function buildMergedLabelFilename(orderSns) {
    const safe = orderSns.map((sn) => String(sn).replace(/[^a-zA-Z0-9_-]/g, "")).filter(Boolean);
    const primarySn = safe[0] || "bulk";
    return safe.length > 1 ? `${primarySn}_gop_${safe.length}_don.pdf` : `${primarySn}.pdf`;
  }
  function findExistingLabelFile(orderSn) {
    const fname = buildMergedLabelFilename([orderSn]);
    const full = import_path.default.join(SHIPPING_DOCS_DIR, fname);
    if (!import_fs.default.existsSync(full)) return null;
    try {
      const buf = import_fs.default.readFileSync(full);
      if (isPdfBuffer(buf)) return fname;
    } catch {
    }
    return null;
  }
  function readExistingLabelBuffer(orderSn) {
    const fname = findExistingLabelFile(orderSn);
    if (!fname) return null;
    try {
      const buf = import_fs.default.readFileSync(import_path.default.join(SHIPPING_DOCS_DIR, fname));
      return isPdfBuffer(buf) ? buf : null;
    } catch {
      return null;
    }
  }
  function saveLabelFile(buffer, filename, contentType) {
    if (!isPdfBuffer(buffer, contentType)) {
      console.error(
        `[Shopee Print] T\u1EEB ch\u1ED1i l\u01B0u \u2014 d\u1EEF li\u1EC7u kh\xF4ng ph\u1EA3i PDF: ${filename}, size=${buffer.length}, type=${contentType || ""}`
      );
      throw new Error("D\u1EEF li\u1EC7u v\u1EADn \u0111\u01A1n t\u1EEB Shopee kh\xF4ng ph\u1EA3i PDF h\u1EE3p l\u1EC7.");
    }
    import_fs.default.mkdirSync(SHIPPING_DOCS_DIR, { recursive: true });
    import_fs.default.writeFileSync(import_path.default.join(SHIPPING_DOCS_DIR, filename), buffer);
    console.log(`[Shopee Print] \u0110\xE3 l\u01B0u v\u1EADn \u0111\u01A1n (${buffer.length} bytes) \u2192 storage/labels/${filename}`);
    return filename;
  }
  function saveLabelFileAsync(buffer, filename, contentType) {
    const copy = Buffer.from(buffer);
    setImmediate(() => {
      try {
        saveLabelFile(copy, filename, contentType);
      } catch (err) {
        console.warn(`[Shopee Print] L\u01B0u n\u1EC1n th\u1EA5t b\u1EA1i ${filename}:`, err);
      }
    });
  }
  async function downloadShippingDocumentsMerged(shopId, accessToken, cleanOrderList) {
    if (cleanOrderList.length === 0) {
      return { error: "empty_order_list", message: "Kh\xF4ng c\xF3 \u0111\u01A1n n\xE0o \u0111\u1EC3 t\u1EA3i v\u1EADn \u0111\u01A1n." };
    }
    if (cleanOrderList.length === 1) {
      const single = await shopeeDownloadShippingDocument(shopId, accessToken, cleanOrderList);
      if (single.error || !single.buffer) {
        return { error: single.error || "download_failed", message: single.message };
      }
      return { buffer: single.buffer, contentType: single.contentType || "application/pdf" };
    }
    const pdfBuffers = [];
    for (const order of cleanOrderList) {
      const one = await shopeeDownloadShippingDocument(shopId, accessToken, [order]);
      if (one.buffer && isPdfBuffer(one.buffer, one.contentType)) {
        pdfBuffers.push(one.buffer);
        console.log(`[Shopee Print] \u0110\xE3 t\u1EA3i PDF ri\xEAng cho \u0111\u01A1n ${order.order_sn} (${one.buffer.length} bytes).`);
      } else {
        console.warn(`[Shopee Print] Kh\xF4ng t\u1EA3i \u0111\u01B0\u1EE3c PDF ri\xEAng cho \u0111\u01A1n ${order.order_sn}: ${one.error || one.message || "unknown"}`);
      }
    }
    if (pdfBuffers.length === 0) {
      const batch = await shopeeDownloadShippingDocument(shopId, accessToken, cleanOrderList);
      if (batch.error || !batch.buffer) {
        return { error: batch.error || "download_failed", message: batch.message };
      }
      return { buffer: batch.buffer, contentType: batch.contentType || "application/pdf" };
    }
    if (pdfBuffers.length < cleanOrderList.length) {
      console.warn(`[Shopee Print] Ch\u1EC9 t\u1EA3i \u0111\u01B0\u1EE3c ${pdfBuffers.length}/${cleanOrderList.length} PDF ri\xEAng \u2014 v\u1EABn g\u1ED9p c\xE1c file \u0111\xE3 c\xF3.`);
    }
    const merged = await mergePdfBuffers(pdfBuffers);
    return { buffer: merged, contentType: "application/pdf" };
  }
  async function mergeLabelFilesToSingleUrl(filenames, orderSns) {
    const pdfBuffers = [];
    for (const name of filenames) {
      const full = import_path.default.join(SHIPPING_DOCS_DIR, name);
      if (!import_fs.default.existsSync(full)) continue;
      const buf = import_fs.default.readFileSync(full);
      if (isPdfBuffer(buf)) pdfBuffers.push(buf);
    }
    if (pdfBuffers.length === 0) return null;
    if (pdfBuffers.length === 1) return `/labels/${filenames[0]}`;
    const merged = await mergePdfBuffers(pdfBuffers);
    const mergedName = buildMergedLabelFilename(orderSns);
    saveLabelFile(merged, mergedName, "application/pdf");
    console.log(`[Shopee Print] \u0110\xE3 g\u1ED9p ${pdfBuffers.length} file PDF th\xE0nh 1 file duy nh\u1EA5t: ${mergedName}`);
    return `/labels/${mergedName}`;
  }
  async function generateShopeeShippingDocument(shopId, orderList) {
    const accessToken = await getValidShopeeAccessToken(shopId);
    if (!accessToken) {
      return { success: false, error: "no_valid_access_token", message: `Ch\u01B0a c\xF3 access_token h\u1EE3p l\u1EC7 cho shop_id=${shopId}.` };
    }
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 3e3;
    let lastError = {};
    for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
      const result = await tryGenerateShopeeShippingDocumentOnce(shopId, accessToken, orderList);
      if (result.success) return result;
      lastError = { error: result.error, message: result.message };
      console.error(`[Shopee Print] L\u1EA5y v\u1EAD n \u0111\u01A1n TH\u1EA4T B\u1EA0I (l\u1EA7n ${attempt}/${MAX_RETRIES + 1}) cho shop_id=${shopId}: error="${result.error}" message="${result.message}"`);
      if (result.permanent) {
        console.error(`[Shopee Print] L\u1ED7i "${result.error}" l\xE0 l\u1ED7i V\u0128NH VI\u1EC4N (\u0111\u01A1n ch\u01B0a th\u1EF1c s\u1EF1 \u0111\u01B0\u1EE3c "Chu\u1EA9n b\u1EB1 h\xE0ng"/ship_order th\xE0nh c\xF4ng tr\xEAn Shopee) \u2014 b\u1ECF qua c\xE1c l\u1EA7n th\u1EED l\u1EA1i.`);
        break;
      }
      if (attempt <= MAX_RETRIES) {
        console.log(`[Shopee Print] T\u1EF1 \u0111\u1ED9ng th\u1EED l\u1EA1i sau ${RETRY_DELAY_MS}ms...`);
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
    console.error(`[Shopee Print] \u0110\xE3 th\u1EED l\u1EA1i t\u1ED1i \u0111a (${MAX_RETRIES} l\u1EA7n) v\u1EABn th\u1EA5t b\u1EA1i cho shop_id=${shopId}. B\u1ECF cu\u1ED9c, \u0111\xE1nh d\u1EA5u \u0111\u01A1n l\xE0 "Ch\u01B0a in".`);
    return { success: false, error: lastError.error, message: lastError.message };
  }
  const PERMANENT_SHOPEE_DOC_ERRORS = /* @__PURE__ */ new Set([
    "logistics.tracking_number_invalid",
    "logistics.order_status_error",
    "error_param"
  ]);
  async function tryGenerateShopeeShippingDocumentOnce(shopId, accessToken, orderList) {
    const createResult = await shopeeCreateShippingDocument(shopId, accessToken, orderList);
    const createList = createResult.response?.result_list || [];
    const failedItems = createList.filter((it) => it.fail_error);
    const okItems = createList.filter((it) => it.package_number && !it.fail_error);
    if (createResult.error && okItems.length === 0) {
      if (failedItems.length > 0) {
        const first = failedItems[0];
        const detail = failedItems.map((it) => `${it.order_sn}: ${it.fail_message || it.fail_error}`).join("; ");
        return {
          success: false,
          error: first.fail_error || createResult.error,
          message: failedItems.length > 1 ? `${failedItems.length} \u0111\u01A1n l\u1ED7i: ${detail}` : first.fail_message || detail,
          permanent: PERMANENT_SHOPEE_DOC_ERRORS.has(first.fail_error)
        };
      }
      return { success: false, error: createResult.error, message: createResult.message, permanent: PERMANENT_SHOPEE_DOC_ERRORS.has(createResult.error) };
    }
    if (okItems.length === 0) {
      const detail = failedItems.map((it) => `${it.order_sn}: ${it.fail_message || it.fail_error}`).join("; ");
      return {
        success: false,
        error: failedItems[0]?.fail_error || "document_generation_failed",
        message: detail || "Kh\xF4ng c\xF3 \u0111\u01A1n n\xE0o t\u1EA1o v\u1EAD n th\xE0nh c\xF4ng trong l\u1EA7n g\u1ECDi n\xE0y.",
        permanent: PERMANENT_SHOPEE_DOC_ERRORS.has(failedItems[0]?.fail_error)
      };
    }
    const originalBySn = new Map(orderList.map((o) => [o.order_sn, o]));
    const cleanOrderList = okItems.map((it) => ({
      order_sn: it.order_sn,
      package_number: it.package_number,
      tracking_number: originalBySn.get(it.order_sn)?.tracking_number
    }));
    const skippedOrders = failedItems.map((it) => ({ orderSn: it.order_sn, error: it.fail_error, message: it.fail_message }));
    if (skippedOrders.length > 0) {
      console.warn(`[Shopee Print] ${skippedOrders.length}/${orderList.length} \u0111\u01A1n b\u1ECB lo\u1EB7i b\u1ECF kh\u1ECFi l\u1EA7n t\u1EA1o v\u1EAD n n\xE0y (kh\xF4ng \u1EA3nh h\u01B0\u1EDFng \u0111\u1EBFn ${cleanOrderList.length} \u0111\u01A1n c\xF2n l\u1EA1i): ${JSON.stringify(skippedOrders)}`);
    }
    let status = "PROCESSING";
    let attempts = 0;
    while (status === "PROCESSING" && attempts < 10) {
      await new Promise((r) => setTimeout(r, 2e3));
      const pollResult = await shopeeGetShippingDocumentResult(shopId, accessToken, cleanOrderList);
      const items = pollResult.response?.result_list || [];
      const anyProcessing = items.some((it) => it.status === "PROCESSING");
      const anyFailed = items.some((it) => it.status === "FAILED");
      status = anyProcessing ? "PROCESSING" : anyFailed && items.every((it) => it.status !== "READY") ? "FAILED" : "READY";
      if (status === "FAILED") {
        const item = items[0];
        return { success: false, error: item?.fail_error || "document_generation_failed", message: item?.fail_message || "Shopee kh\xF4ng th\u1EC3 t\u1EA1o v\u1EAD n \u0111\u01A1n cho \u0111\u01A1n h\xE0ng n\xE0y (c\xF3 th\u1EC3 \u0111\u01A1n ch\u01B0a \u1EDF tr\u1EA1ng th\xE1i \u0111\xE3 x\u1EED l\xFD)." };
      }
      attempts++;
    }
    if (status !== "READY") {
      return { success: false, error: "document_still_processing", message: "Shopee v\u1EABn \u0111ang x\u1EED l\xFD v\u1EAD n \u0111\u01A1n, vui l\xF2ng th\u1EED l\u1EA1i sau v\xE0i gi\xE2y." };
    }
    const downloadResult = await downloadShippingDocumentsMerged(shopId, accessToken, cleanOrderList);
    if ("error" in downloadResult || !downloadResult.buffer) {
      return { success: false, error: downloadResult.error, message: downloadResult.message };
    }
    if (downloadResult.buffer.length < 128) {
      return {
        success: false,
        error: "empty_label_file",
        message: "Shopee tr\u1EA3 v\u1EC1 file v\u1EADn \u0111\u01A1n r\u1ED7ng \u2014 vui l\xF2ng th\u1EED l\u1EA1i sau khi \u0111\u01A1n \u0111\xE3 c\xF3 m\xE3 v\u1EADn \u0111\u01A1n th\u1EADt (SPXVN...)."
      };
    }
    const ext = extensionForContentType(downloadResult.contentType);
    const orderSns = cleanOrderList.map((o) => o.order_sn);
    const filename = ext === "pdf" ? buildMergedLabelFilename(orderSns) : `${orderSns[0] || `shop-${shopId}`}.${ext}`;
    saveLabelFileAsync(downloadResult.buffer, filename, downloadResult.contentType);
    console.log(`[Shopee Print] Stream v\u1EADn \u0111\u01A1n Shopee (${cleanOrderList.length} \u0111\u01A1n \u2192 ${filename}, ${downloadResult.buffer.length} bytes) \u2014 l\u01B0u \u0111\u0129a n\u1EC1n.`);
    return {
      success: true,
      filename,
      buffer: downloadResult.buffer,
      contentType: downloadResult.contentType,
      orderSns,
      skippedOrders
    };
  }
  async function autoPrintLabelsForShopeeOrders(allOrders, shopeeOrders) {
    const candidates = shopeeOrders.filter((o) => o.channel === "shopee" && (o.shopId || resolveOrderShopId(o)));
    if (candidates.length === 0) return null;
    for (const o of candidates) {
      if (!o.shopId) {
        const resolved = resolveOrderShopId(o);
        if (resolved) {
          o.shopId = resolved;
          const idx = allOrders.findIndex((x) => x.orderSn === o.orderSn);
          if (idx >= 0) allOrders[idx].shopId = resolved;
        }
      }
    }
    const groups = {};
    for (const o of candidates) {
      if (!o.shopId) continue;
      groups[o.shopId] = groups[o.shopId] || [];
      groups[o.shopId].push(o);
    }
    for (const [shopId, groupOrders] of Object.entries(groups)) {
      const accessToken = await getValidShopeeAccessToken(shopId);
      if (!accessToken) continue;
      for (const o of groupOrders) {
        if (o.trackingNumber && isCarrierTrackingCode(o.trackingNumber)) continue;
        const trackResult = await shopeeGetTrackingNumber(shopId, accessToken, o.orderSn, o.packageNumber);
        applyShopeeGetTrackingResponse(o, trackResult);
        const idx = allOrders.findIndex((x) => x.orderSn === o.orderSn);
        if (idx >= 0) {
          allOrders[idx].trackingNumber = o.trackingNumber;
          allOrders[idx].internalTrackingCode = o.internalTrackingCode;
        }
      }
    }
    saveOrders(allOrders);
    console.log(`[Ship Order Bulk Auto-Print] Ch\u1EDD 4 gi\xE2y \u0111\u1EC3 Shopee kh\u1EDFi t\u1EA1o m\xE3 v\u1EADn \u0111\u01A1n cho ${candidates.length} \u0111\u01A1n...`);
    await new Promise((r) => setTimeout(r, 4e3));
    const printedOrderSns = [];
    const skippedOrders = [];
    const savedFilenames = [];
    const pdfBuffers = [];
    for (const [shopId, groupOrders] of Object.entries(groups)) {
      const orderList = groupOrders.map((o) => ({
        order_sn: o.orderSn,
        package_number: o.packageNumber,
        tracking_number: trackingForShopeeShippingDoc(o)
      }));
      console.log(`[Ship Order Bulk Auto-Print] T\u1EA1o v\u1EADn g\u1ED9p ${orderList.length} \u0111\u01A1n shop_id=${shopId}...`);
      const docResult = await generateShopeeShippingDocument(shopId, orderList);
      if (docResult.success && docResult.filename) {
        savedFilenames.push(docResult.filename);
        if (docResult.buffer && isPdfBuffer(docResult.buffer)) pdfBuffers.push(docResult.buffer);
        printedOrderSns.push(...docResult.orderSns || groupOrders.map((o) => o.orderSn));
        if (Array.isArray(docResult.skippedOrders)) skippedOrders.push(...docResult.skippedOrders);
      } else {
        console.error(`[Ship Order Bulk Auto-Print] Th\u1EA5t b\u1EA1i shop_id=${shopId}: ${docResult.error} - ${docResult.message}`);
        skippedOrders.push({ shopId, error: docResult.error, message: docResult.message });
      }
    }
    let primaryUrl = null;
    let pdfBase64 = null;
    let pdfFilename = null;
    if (pdfBuffers.length > 0) {
      const mergedBuf = pdfBuffers.length === 1 ? pdfBuffers[0] : await mergePdfBuffers(pdfBuffers);
      pdfFilename = buildMergedLabelFilename(printedOrderSns);
      pdfBase64 = mergedBuf.toString("base64");
      primaryUrl = `/labels/${pdfFilename}`;
      saveLabelFileAsync(mergedBuf, pdfFilename, "application/pdf");
    } else if (savedFilenames.length > 0) {
      primaryUrl = await mergeLabelFilesToSingleUrl(savedFilenames, printedOrderSns);
    }
    if (!primaryUrl && !pdfBase64) {
      return { url: null, printedOrderSns, skippedOrders, message: "Kh\xF4ng t\u1EA1o \u0111\u01B0\u1EE3c v\u1EAD n \u0111\u01A1n t\u1EF1 \u0111\u1ED9ng sau khi chu\u1EA9n b\u1EB1 h\xE0ng." };
    }
    return { url: primaryUrl, pdfBase64, pdfFilename, printedOrderSns, skippedOrders };
  }
  async function executeShipOrderBackgroundJob(jobId, shipMethod, idList, snList) {
    pruneOldShipOrderJobs();
    const job = shipOrderJobs.get(jobId);
    if (!job) return;
    try {
      job.status = "running";
      job.updatedAt = Date.now();
      const orders = loadOrders();
      const toShip = resolveOrdersFromRequest(orders, idList, snList);
      job.total = toShip.length;
      const batch = await processShipOrderBatch(orders, toShip, shipMethod, {
        optimistic: true,
        onProgress: (completed, total) => {
          job.completed = completed;
          job.total = total;
          job.updatedAt = Date.now();
        }
      });
      saveOrders(orders);
      job.results = batch.results;
      job.successCount = batch.successCount;
      job.orders = orders.filter(isValidOrder);
      if (batch.successfulShopeeOrders.length > 0) {
        job.status = "printing";
        job.updatedAt = Date.now();
        const printDocument = await autoPrintLabelsForShopeeOrders(orders, batch.successfulShopeeOrders);
        if (printDocument?.printedOrderSns?.length) {
          const printedSet = new Set(printDocument.printedOrderSns);
          for (let i = 0; i < orders.length; i++) {
            if (printedSet.has(orders[i].orderSn)) {
              orders[i] = { ...orders[i], isPrinted: true, status: "processed" };
            }
          }
          saveOrders(orders);
        }
        job.printDocument = printDocument;
        job.orders = orders.filter(isValidOrder);
      }
      job.status = "done";
    } catch (err) {
      job.status = "failed";
      job.error = err?.message || String(err);
      console.error(`[Ship Order Job ${jobId}] Failed:`, err);
    }
    job.updatedAt = Date.now();
  }
  app.post("/api/shopee/ship-order/bulk-async", authMiddleware, async (req, res) => {
    const { orderIds, orderSns, method } = req.body;
    const shipMethod = method === "dropoff" ? "dropoff" : "pickup";
    const idList = Array.isArray(orderIds) ? orderIds.map(String) : [];
    const snList = Array.isArray(orderSns) ? orderSns.map(String) : [];
    if (idList.length === 0 && snList.length === 0) {
      return res.status(400).json({ error: "Thi\u1EBFu danh s\xE1ch orderIds ho\u1EB7c orderSns." });
    }
    const orders = loadOrders();
    const toShip = resolveOrdersFromRequest(orders, idList, snList);
    if (toShip.length === 0) {
      return res.status(404).json({
        error: "orders_not_found",
        message: "Kh\xF4ng t\xECm th\u1EA5y \u0111\u01A1n n\xE0o trong database kh\u1EDBp v\u1EDBi danh s\xE1ch g\u1EEDi l\xEAn.",
        successCount: 0,
        total: 0,
        results: [],
        orders: orders.filter(isValidOrder)
      });
    }
    for (const { index } of toShip) {
      orders[index] = {
        ...orders[index],
        isPrepared: true,
        status: "processed",
        shopeeSyncPending: true,
        shopeeSyncError: void 0
      };
    }
    saveOrders(orders);
    const jobId = createShipOrderJobId();
    shipOrderJobs.set(jobId, {
      id: jobId,
      status: "pending",
      total: toShip.length,
      completed: 0,
      successCount: 0,
      results: [],
      printDocument: null,
      orders: orders.filter(isValidOrder),
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    setImmediate(() => {
      void executeShipOrderBackgroundJob(jobId, shipMethod, idList, snList);
    });
    return res.status(202).json({
      accepted: true,
      jobId,
      total: toShip.length,
      orders: orders.filter(isValidOrder)
    });
  });
  app.get("/api/shopee/ship-order/job/:jobId", authMiddleware, (req, res) => {
    const job = shipOrderJobs.get(String(req.params.jobId || ""));
    if (!job) {
      return res.status(404).json({
        error: "job_not_found",
        message: "Kh\xF4ng t\xECm th\u1EA5y ti\u1EBFn tr\xECnh x\u1EED l\xFD."
      });
    }
    return res.json(job);
  });
  app.post("/api/shopee/print-document", authMiddleware, async (req, res) => {
    const { orderIds } = req.body;
    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      return res.status(400).json({ error: "Thi\u1EBFu danh s\xE1ch orderIds." });
    }
    const orders = loadOrders();
    const idSet = new Set(orderIds.map(String));
    const targetOrders = orders.filter(
      (o) => idSet.has(String(o.id)) || idSet.has(String(o.orderSn)) || idSet.has(`shopee-${o.orderSn}`)
    );
    for (const o of targetOrders) {
      if (o.channel === "shopee" && !o.shopId) {
        const resolved = resolveOrderShopId(o);
        if (resolved) o.shopId = resolved;
      }
    }
    const shopeeCandidates = targetOrders.filter((o) => o.channel === "shopee" && o.shopId);
    if (shopeeCandidates.length === 0) {
      return res.status(400).json({ error: "Kh\xF4ng c\xF3 \u0111\u01A1n Shopee th\u1EADt n\xE0o (c\xF3 shop_id) trong danh s\xE1ch \u0111\u01B0\u1EE3c ch\u1ECDn \u0111\u1EC3 in v\u1EAD n." });
    }
    const groups = {};
    for (const o of shopeeCandidates) {
      groups[o.shopId] = groups[o.shopId] || [];
      groups[o.shopId].push(o);
    }
    for (const [shopId, groupOrders] of Object.entries(groups)) {
      const accessToken = await getValidShopeeAccessToken(shopId);
      if (!accessToken) continue;
      for (const o of groupOrders) {
        if (o.trackingNumber && isCarrierTrackingCode(o.trackingNumber)) continue;
        const trackResult = await shopeeGetTrackingNumber(shopId, accessToken, o.orderSn, o.packageNumber);
        applyShopeeGetTrackingResponse(o, trackResult);
        const idx = orders.findIndex((x) => x.orderSn === o.orderSn);
        if (idx >= 0) {
          orders[idx].trackingNumber = o.trackingNumber;
          orders[idx].internalTrackingCode = o.internalTrackingCode;
          console.log(`[Shopee Print] \u0110\xE3 l\u1EA5y tracking cho \u0111\u01A1n ${o.orderSn}: carrier=${o.trackingNumber || "\u2014"}, internal=${o.internalTrackingCode || "\u2014"}.`);
        } else if (!trackResult.response?.tracking_number) {
          console.error(`[Shopee Print] Kh\xF4ng l\u1EA5y \u0111\u01B0\u1EE3c tracking_number cho \u0111\u01A1n ${o.orderSn} (get_tracking_number tr\u1EA3 v\u1EC1: ${JSON.stringify(trackResult)}). create_shipping_document c\xF3 th\u1EC3 s\u1EBD b\u1ECB t\u1EEB ch\u1ED1i.`);
        }
      }
    }
    saveOrders(orders);
    const documents = [];
    const savedFilenames = [];
    const allPrintedSns = [];
    const pdfBuffers = [];
    for (const [shopId, groupOrders] of Object.entries(groups)) {
      const needsGenerate = [];
      for (const o of groupOrders) {
        const cachedBuf = readExistingLabelBuffer(o.orderSn);
        if (cachedBuf) {
          pdfBuffers.push(cachedBuf);
          const existing = buildMergedLabelFilename([o.orderSn]);
          savedFilenames.push(existing);
          allPrintedSns.push(o.orderSn);
          documents.push({
            shopId,
            orderSns: [o.orderSn],
            url: `/labels/${existing}`,
            contentType: "application/pdf",
            fromCache: true
          });
        } else {
          needsGenerate.push(o);
        }
      }
      if (needsGenerate.length === 0) continue;
      const orderList = needsGenerate.map((o) => ({
        order_sn: o.orderSn,
        package_number: o.packageNumber,
        tracking_number: trackingForShopeeShippingDoc(o)
      }));
      console.log(`[Shopee Print] \u0110ang t\u1EA1o v\u1EADn \u0111\u01A1n cho ${orderList.length} \u0111\u01A1n c\u1EE7a shop_id=${shopId}...`);
      const docResult = await generateShopeeShippingDocument(shopId, orderList);
      if (docResult.success && docResult.filename) {
        savedFilenames.push(docResult.filename);
        if (docResult.buffer && isPdfBuffer(docResult.buffer)) pdfBuffers.push(docResult.buffer);
        const sns = docResult.orderSns || needsGenerate.map((o) => o.orderSn);
        allPrintedSns.push(...sns);
        documents.push({
          shopId,
          orderSns: sns,
          url: `/labels/${docResult.filename}`,
          contentType: docResult.contentType
        });
        if (Array.isArray(docResult.skippedOrders) && docResult.skippedOrders.length > 0) {
          for (const skipped of docResult.skippedOrders) {
            documents.push({
              shopId,
              orderSns: [skipped.orderSn],
              success: false,
              error: skipped.error,
              message: skipped.message
            });
          }
        }
      } else {
        for (const o of needsGenerate) {
          const cachedBuf = readExistingLabelBuffer(o.orderSn);
          if (cachedBuf) {
            pdfBuffers.push(cachedBuf);
            const existing = buildMergedLabelFilename([o.orderSn]);
            savedFilenames.push(existing);
            allPrintedSns.push(o.orderSn);
            documents.push({
              shopId,
              orderSns: [o.orderSn],
              url: `/labels/${existing}`,
              contentType: "application/pdf",
              fromCache: true
            });
          } else {
            documents.push({
              shopId,
              orderSns: [o.orderSn],
              success: false,
              error: docResult.error,
              message: docResult.message
            });
          }
        }
      }
    }
    let primaryUrl = null;
    let pdfBase64 = null;
    let pdfFilename = null;
    if (pdfBuffers.length > 0) {
      const mergedBuf = pdfBuffers.length === 1 ? pdfBuffers[0] : await mergePdfBuffers(pdfBuffers);
      pdfFilename = buildMergedLabelFilename(allPrintedSns);
      pdfBase64 = mergedBuf.toString("base64");
      primaryUrl = `/labels/${pdfFilename}`;
      saveLabelFileAsync(mergedBuf, pdfFilename, "application/pdf");
    } else if (savedFilenames.length > 0) {
      primaryUrl = await mergeLabelFilesToSingleUrl(savedFilenames, allPrintedSns);
    } else {
      primaryUrl = documents.find((d) => d.url)?.url || null;
    }
    const printedOrderSns = new Set(allPrintedSns);
    const updatedOrders = orders.map((o) => {
      if (printedOrderSns.has(o.orderSn)) {
        return { ...o, isPrinted: true, status: o.isPrepared ? "processed" : o.status };
      }
      return o;
    });
    saveOrders(updatedOrders);
    console.log(`[Shopee Print] Ho\xE0n t\u1EA5t: ${documents.filter((d) => d.url).length}/${Object.keys(groups).length} nh\xF3m shop t\u1EA1o v\u1EAD n th\xE0nh c\xF4ng.`);
    return res.json({
      mergedUrl: primaryUrl,
      pdfBase64,
      pdfFilename,
      documents: documents.map(
        (d) => d.url ? { ...d, url: d.url.startsWith("/") ? d.url : `/${String(d.url).replace(/^\/+/, "")}` } : d
      ),
      orders: updatedOrders.filter(isValidOrder),
      shippingDocumentType: SHOPEE_SHIPPING_DOCUMENT_TYPE,
      openMode: pdfBase64 ? "inline_buffer" : "new_tab_pdf"
    });
  });
  let ai = null;
  if (process.env.GEMINI_API_KEY) {
    ai = new import_genai.GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build"
        }
      }
    });
  } else {
    console.warn("Warning: GEMINI_API_KEY is not configured in .env");
  }
  const initGeminiClient = (apiKey) => {
    return new import_genai.GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: { "User-Agent": "aistudio-build" }
      }
    });
  };
  app.get("/api/settings/gemini-status", authMiddleware, (_req, res) => {
    const key = process.env.GEMINI_API_KEY || "";
    const configured = Boolean(key && key !== "chua_co_key_tam_thoi");
    return res.json({
      success: true,
      configured,
      maskedKey: configured ? maskApiKey(key) : ""
    });
  });
  app.post("/api/settings/update-gemini-key", authMiddleware, (req, res) => {
    try {
      const { apiKey } = req.body || {};
      const trimmed = String(apiKey || "").trim();
      if (!trimmed) {
        return res.status(400).json({ success: false, error: "Vui l\xF2ng nh\u1EADp Gemini API Key." });
      }
      updateEnvVar("GEMINI_API_KEY", trimmed);
      ai = initGeminiClient(trimmed);
      return res.json({ success: true, message: "\u0110\xE3 c\u1EADp nh\u1EADt API Key th\xE0nh c\xF4ng!" });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message || "L\u01B0u API Key th\u1EA5t b\u1EA1i" });
    }
  });
  app.post("/api/settings/test-gemini-key", authMiddleware, async (req, res) => {
    try {
      const testKey = String(req.body?.apiKey || process.env.GEMINI_API_KEY || "").trim();
      if (!testKey || testKey === "chua_co_key_tam_thoi") {
        return res.status(400).json({ success: false, error: "API Key kh\xF4ng h\u1EE3p l\u1EC7" });
      }
      const testAi = initGeminiClient(testKey);
      await testAi.models.generateContent({
        model: "gemini-3.5-flash",
        contents: "Reply with exactly: OK"
      });
      return res.json({ success: true, message: "K\u1EBFt n\u1ED1i th\xE0nh c\xF4ng!" });
    } catch (error) {
      console.error("[Gemini test]", error);
      return res.status(400).json({ success: false, error: "API Key kh\xF4ng h\u1EE3p l\u1EC7" });
    }
  });
  async function checkShopConnectionStatus(shop) {
    if (!shop?.connected) {
      return { online: false, message: "\u0110\u1ED3ng b\u1ED9 \u0111ang t\u1EAFt" };
    }
    if (shop.platform === "shopee") {
      try {
        if (!isShopeeConfigValid()) {
          return { online: false, message: "Shopee Partner ID/Key ch\u01B0a c\u1EA5u h\xECnh" };
        }
        const configuredId = normalizeShopIdKey(String(shop.shopId || ""));
        const oauthShopIds = listShopeeOAuthShopIds();
        const tokens = loadShopeeTokens();
        const record = configuredId ? getShopeeTokenRecord(tokens, configuredId) : null;
        const token = configuredId ? await getValidShopeeAccessToken(configuredId) : null;
        if (token && record) {
          const apiShopId = resolveShopeeApiShopId(record, configuredId);
          const ping = await verifyShopeeShopToken(apiShopId, token);
          if (ping.ok) {
            return { online: true, message: `OAuth token h\u1EE3p l\u1EC7 (Shopee API OK, shop_id=${apiShopId})` };
          }
          return {
            online: false,
            message: `C\xF3 token trong file nh\u01B0ng Shopee t\u1EEB ch\u1ED1i shop_id=${apiShopId}: ${ping.error || "invalid_token"}. C\u1EA7n OAuth l\u1EA1i \u0111\xFAng shop ${configuredId}.`
          };
        }
        const lastOAuth = loadLastOAuthAudit();
        if (lastOAuth?.expected_shop_id === configuredId && lastOAuth?.shop_mismatch && lastOAuth?.callback_shop_id) {
          return {
            online: false,
            message: `OAuth g\u1EA7n nh\u1EA5t: Shopee tr\u1EA3 shop ${lastOAuth.callback_shop_id}, kh\xF4ng ph\u1EA3i ${configuredId}. \u0110\u0103ng xu\u1EA5t Shopee Seller, \u0111\u0103ng nh\u1EADp shop ${configuredId}, b\u1EA5m OAuth l\u1EA1i.`
          };
        }
        if (oauthShopIds.length > 0) {
          return {
            online: false,
            message: `Shop ID c\u1EA5u h\xECnh "${shop.shopId || "(tr\u1ED1ng)"}" ch\u01B0a c\xF3 token. OAuth \u0111\xE3 l\u01B0u: [${oauthShopIds.join(", ")}] \u2014 ki\u1EC3m tra Shop ID c\xF3 \u0111\xFAng tr\xEAn Shopee Seller Center kh\xF4ng.`
          };
        }
        return { online: false, message: "Ch\u01B0a OAuth ho\u1EB7c token h\u1EBFt h\u1EA1n" };
      } catch (error) {
        console.error("[Shop connection] Shopee check failed:", shop?.shopId, error);
        return { online: false, message: error?.message || "L\u1ED7i ki\u1EC3m tra k\u1EBFt n\u1ED1i Shopee" };
      }
    }
    if (shop.platform === "woocommerce") {
      const base = String(shop.wooUrl || "").replace(/\/$/, "");
      const key = String(shop.shopId || "").trim();
      const secret = String(shop.apiSecret || shop.apiKey || "").trim();
      if (!base || !key) {
        return { online: false, message: "Thi\u1EBFu URL ho\u1EB7c Consumer Key" };
      }
      try {
        const auth = Buffer.from(`${key}:${secret}`).toString("base64");
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8e3);
        const res = await fetch(`${base}/wp-json/wc/v3/system_status`, {
          headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
          signal: controller.signal
        });
        clearTimeout(timer);
        if (res.ok) {
          return { online: true, message: "WooCommerce REST API ph\u1EA3n h\u1ED3i OK" };
        }
        return { online: false, message: `WooCommerce tr\u1EA3 HTTP ${res.status}` };
      } catch (error) {
        return { online: false, message: error?.message || "Kh\xF4ng k\u1EBFt n\u1ED1i \u0111\u01B0\u1EE3c WooCommerce" };
      }
    }
    if (shop.platform === "tiktok") {
      if (shop.shopId && shop.apiKey) {
        return { online: true, message: "Credentials TikTok Shop \u0111\xE3 c\u1EA5u h\xECnh" };
      }
      return { online: false, message: "Thi\u1EBFu Seller ID ho\u1EB7c API Key" };
    }
    return { online: false, message: "N\u1EC1n t\u1EA3ng kh\xF4ng h\u1ED7 tr\u1EE3" };
  }
  app.get("/api/shopee/oauth-shops", authMiddleware, (_req, res) => {
    const tokens = loadShopeeTokens();
    const shopIds = listShopeeOAuthShopIds();
    const details = shopIds.map((id) => ({
      shop_id: id,
      obtained_at: tokens[id]?.obtained_at ?? null,
      expire_in: tokens[id]?.expire_in ?? null,
      oauth_shop_id: tokens[id]?.oauth_shop_id ?? null,
      shop_id_list: tokens[id]?.shop_id_list ?? []
    }));
    let lastOAuth = loadLastOAuthAudit();
    return res.json({
      success: true,
      shopIds,
      details,
      tokensPath: SHOPEE_TOKENS_PATH,
      appRoot: APP_ROOT,
      lastOAuth,
      count: shopIds.length
    });
  });
  app.get("/api/shopee/auth-url", authMiddleware, (req, res) => {
    if (!isShopeeConfigValid()) {
      return res.status(500).json({
        success: false,
        error: "invalid_partner_config",
        message: "SHOPEE_PARTNER_ID / SHOPEE_PARTNER_KEY ch\u01B0a c\u1EA5u h\xECnh tr\xEAn backend cPanel."
      });
    }
    const shopId = normalizeShopIdKey(String(req.query.shop_id || ""));
    if (!shopId) {
      return res.status(400).json({
        success: false,
        error: "shop_id_required",
        message: "C\u1EA7n shop_id (VD: 241215004) \u0111\u1EC3 t\u1EA1o link \u1EE7y quy\u1EC1n OAuth."
      });
    }
    return res.json({
      success: true,
      shop_id: shopId,
      url: buildShopeeAuthPartnerUrl(shopId),
      callback: SHOPEE_CALLBACK_URL
    });
  });
  app.post("/api/settings/shop-connection-status", authMiddleware, async (req, res) => {
    try {
      const shops = Array.isArray(req.body?.shops) ? req.body.shops : [];
      const statuses = {};
      for (const shop of shops) {
        if (!shop?.id) continue;
        try {
          statuses[shop.id] = await Promise.race([
            checkShopConnectionStatus(shop),
            new Promise((_, reject) => {
              setTimeout(() => reject(new Error("Timeout ki\u1EC3m tra k\u1EBFt n\u1ED1i (15s)")), 15e3);
            })
          ]);
        } catch (shopErr) {
          console.error("[Shop connection-status] shop failed:", shop?.id, shopErr);
          statuses[shop.id] = {
            online: false,
            message: shopErr?.message || "L\u1ED7i ki\u1EC3m tra k\u1EBFt n\u1ED1i gian h\xE0ng"
          };
        }
      }
      return res.json({ success: true, statuses });
    } catch (error) {
      console.error("[Shop connection-status] fatal:", error);
      return res.status(500).json({
        success: false,
        error: error?.message || "Ki\u1EC3m tra k\u1EBFt n\u1ED1i th\u1EA5t b\u1EA1i",
        message: "M\xE1y ch\u1EE7 \u0111ang qu\xE1 t\u1EA3i ho\u1EB7c l\u1ED7i, vui l\xF2ng th\u1EED l\u1EA1i sau"
      });
    }
  });
  app.post("/api/gemini/optimize", authMiddleware, async (req, res) => {
    try {
      const { action, text, context } = req.body;
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        return res.status(503).json({
          error: "Ch\u01B0a c\u1EA5u h\xECnh API Key c\u1EE7a Gemini AI. Vui l\xF2ng c\xE0i \u0111\u1EB7t trong m\u1EE5c Settings ho\u1EB7c Secrets."
        });
      }
      if (!ai) {
        ai = new import_genai.GoogleGenAI({
          apiKey,
          httpOptions: {
            headers: {
              "User-Agent": "aistudio-build"
            }
          }
        });
      }
      let prompt = "";
      if (action === "optimize-title") {
        prompt = `B\u1EA1n l\xE0 m\u1ED9t chuy\xEAn gia t\u1ED1i \u01B0u h\xF3a SEO tr\xEAn Shopee v\xE0 TikTok Shop t\u1EA1i Vi\u1EC7t Nam.
H\xE3y vi\u1EBFt l\u1EA1i ti\xEAu \u0111\u1EC1 s\u1EA3n ph\u1EA9m sau \u0111\xE2y \u0111\u1EC3 thu h\xFAt kh\xE1ch h\xE0ng, k\xEDch th\xEDch click, t\u0103ng t\u1EF7 l\u1EC7 chuy\u1EC3n \u0111\u1ED5i v\xE0 ch\u1EE9a c\xE1c t\u1EEB kh\xF3a t\xECm ki\u1EBFm ph\u1ED5 bi\u1EBFn (SEO).
Ti\xEAu \u0111\u1EC1 g\u1ED1c: "${text}"
${context ? `Y\xEAu c\u1EA7u th\xEAm: ${context}` : ""}

Quy t\u1EAFc vi\u1EBFt ti\xEAu \u0111\u1EC1:
- \u0110\u1ED9 d\xE0i t\u1EEB 50-120 k\xFD t\u1EF1.
- Vi\u1EBFt hoa ch\u1EEF c\xE1i \u0111\u1EA7u c\u1EE7a m\u1ED7i t\u1EEB quan tr\u1ECDng (nh\u01B0 t\xEAn th\u01B0\u01A1ng hi\u1EC7u, t\xEDnh n\u0103ng ch\xEDnh).
- Ch\u1EE9a th\u01B0\u01A1ng hi\u1EC7u, ch\u1EA5t li\u1EC7u, dung t\xEDch/k\xEDch th\u01B0\u1EDBc, c\xF4ng d\u1EE5ng n\u1ED5i b\u1EADt.
- KH\xD4NG d\xF9ng k\xFD t\u1EF1 \u0111\u1EB7c bi\u1EC7t g\xE2y l\u1ED7i t\xECm ki\u1EBFm.
- Ch\u1EC9 tr\u1EA3 v\u1EC1 danh s\xE1ch 3 ph\u01B0\u01A1ng \xE1n ti\xEAu \u0111\u1EC1 t\u1ED1i \u01B0u nh\u1EA5t d\u01B0\u1EDBi d\u1EA1ng danh s\xE1ch, m\u1ED7i ph\u01B0\u01A1ng \xE1n tr\xEAn 1 d\xF2ng. Kh\xF4ng gi\u1EA3i th\xEDch th\xEAm.`;
      } else if (action === "generate-description") {
        prompt = `B\u1EA1n l\xE0 m\u1ED9t chuy\xEAn gia Copywriter vi\u1EBFt b\xE0i m\xF4 t\u1EA3 s\u1EA3n ph\u1EA9m b\xE1n h\xE0ng (Product Description) \u0111\u1EC9nh cao tr\xEAn s\xE0n th\u01B0\u01A1ng m\u1EA1i \u0111i\u1EC7n t\u1EED Shopee v\xE0 TikTok Shop Vi\u1EC7t Nam.
H\xE3y vi\u1EBFt m\u1ED9t b\xE0i m\xF4 t\u1EA3 s\u1EA3n ph\u1EA9m chi ti\u1EBFt, chuy\xEAn nghi\u1EC7p, thu h\xFAt ng\u01B0\u1EDDi mua d\u1EF1a tr\xEAn th\xF4ng tin s\u1EA3n ph\u1EA9m sau \u0111\xE2y.
T\xEAn s\u1EA3n ph\u1EA9m: "${text}"
${context ? `Th\xF4ng tin b\u1ED5 sung / Gi\xE1 c\u1EA3 / T\xEDnh n\u0103ng: ${context}` : ""}

C\u1EA5u tr\xFAc b\xE0i vi\u1EBFt m\xF4 t\u1EA3 s\u1EA3n ph\u1EA9m c\u1EA7n c\xF3:
1. Slogan thu h\xFAt & Gi\u1EDBi thi\u1EC7u ng\u1EAFn v\u1EC1 s\u1EA3n ph\u1EA9m.
2. C\xE1c \u0111\u1EB7c \u0111i\u1EC3m n\u1ED5i b\u1EADt nh\u1EA5t (g\u1EA1ch \u0111\u1EA7u d\xF2ng d\u1EC5 \u0111\u1ECDc).
3. Th\xF4ng s\u1ED1 k\u1EF9 thu\u1EADt / H\u01B0\u1EDBng d\u1EABn s\u1EED d\u1EE5ng chi ti\u1EBFt.
4. Cam k\u1EBFt c\u1EE7a Shop (H\xE0ng ch\xEDnh h\xE3ng, b\u1EA3o h\xE0nh, \u0111\u1ED5i tr\u1EA3 1-1 trong 7 ng\xE0y).
5. Hashtag li\xEAn quan chu\u1EA9n SEO (8-12 hashtags \u1EDF cu\u1ED1i b\xE0i, v\xED d\u1EE5: #noichien #giadung).

Phong c\xE1ch vi\u1EBFt: Th\xE2n thi\u1EC7n, thuy\u1EBFt ph\u1EE5c, \u0111\xE1ng tin c\u1EADy. \u0110\u1ECBnh d\u1EA1ng Markdown \u0111\u1EB9p m\u1EAFt, ph\xE2n c\u1EA5p r\xF5 r\xE0ng. H\xE3y ch\u1EC9 tr\u1EA3 v\u1EC1 b\xE0i vi\u1EBFt m\xF4 t\u1EA3 b\u1EB1ng Markdown. Kh\xF4ng ch\xE0o h\u1ECFi hay gi\u1EA3i th\xEDch th\xEAm.`;
      } else if (action === "suggest-prices") {
        const importP = typeof context === "object" ? context.importPrice : 0;
        const sellP = typeof context === "object" ? context.sellingPrice : 0;
        prompt = `B\u1EA1n l\xE0 chuy\xEAn gia c\u1ED1 v\u1EA5n t\xE0i ch\xEDnh v\xE0 \u0111\u1ECBnh gi\xE1 s\u1EA3n ph\u1EA9m E-commerce tr\xEAn Shopee & TikTok Shop.
D\u1EF1a tr\xEAn th\xF4ng tin s\u1EA3n ph\u1EA9m n\xE0y:
T\xEAn s\u1EA3n ph\u1EA9m: "${text}"
Gi\xE1 nh\u1EADp g\u1ED1c: ${importP.toLocaleString("vi-VN")} VN\u0110.
Gi\xE1 b\xE1n d\u1EF1 ki\u1EBFn hi\u1EC7n t\u1EA1i: ${sellP.toLocaleString("vi-VN")} VN\u0110.

H\xE3y t\xEDnh to\xE1n v\xE0 ph\xE2n t\xEDch chi ti\u1EBFt b\u1EB1ng ti\u1EBFng Vi\u1EC7t:
1. T\u1EF7 su\u1EA5t l\u1EE3i nhu\u1EADn g\u1ED9p (Gross Profit Margin %) c\u1EE7a gi\xE1 b\xE1n d\u1EF1 ki\u1EBFn hi\u1EC7n t\u1EA1i.
2. \u0110\u1EC1 xu\u1EA5t 3 m\u1EE9c gi\xE1 b\xE1n t\u1ED1i \u01B0u (Gi\xE1 th\xE2m nh\u1EADp th\u1ECB tr\u01B0\u1EDDng, Gi\xE1 t\u1ED1i \u0111a h\xF3a l\u1EE3i nhu\u1EADn, Gi\xE1 khuy\u1EBFn m\xE3i Flash Sale) k\xE8m ph\xE2n t\xEDch l\u1EE3i nhu\u1EADn th\u1EF1c t\u1EBF (\u0111\xE3 tr\u1EEB kho\u1EA3ng 10-12% ph\xED s\xE0n Shopee/TikTok th\xF4ng th\u01B0\u1EDDng bao g\u1ED3m ph\xED thanh to\xE1n, ph\xED c\u1ED1 \u0111\u1ECBnh, ph\xED Freeship Xtra).
3. Ph\xE2n t\xEDch t\xEDnh c\u1EA1nh tranh c\u1EE7a gi\xE1 nh\u1EADp v\xE0 \u0111\u1EC1 xu\u1EA5t chi\u1EBFn l\u01B0\u1EE3c t\u1ED1i \u01B0u chi ph\xED hi\u1EC7u qu\u1EA3.

H\xE3y tr\u1EA3 v\u1EC1 k\u1EBFt qu\u1EA3 chi ti\u1EBFt b\u1EB1ng ti\u1EBFng Vi\u1EC7t, vi\u1EBFt ng\u1EAFn g\u1ECDn d\u01B0\u1EDBi d\u1EA1ng Markdown, s\u1EED d\u1EE5ng b\u1EA3ng \u0111\u1EC3 so s\xE1nh r\xF5 r\xE0ng c\xE1c m\u1EE9c gi\xE1 \u0111\u1EC1 xu\u1EA5t v\xE0 l\u1EE3i nhu\u1EADn th\u1EF1c nh\u1EADn.`;
      } else if (action === "bulk-tag") {
        prompt = `B\u1EA1n l\xE0 chuy\xEAn gia t\u1EEB kh\xF3a SEO cho Shopee v\xE0 TikTok Shop t\u1EA1i Vi\u1EC7t Nam.
H\xE3y g\u1EE3i \xFD m\u1ED9t danh s\xE1ch g\u1ED3m 10-15 hashtags b\xE1n ch\u1EA1y nh\u1EA5t li\xEAn quan \u0111\u1EBFn s\u1EA3n ph\u1EA9m: "${text}".
C\xE1c t\u1EEB kh\xF3a ph\u1EA3i ph\xF9 h\u1EE3p v\u1EDBi xu h\u01B0\u1EDBng t\xECm ki\u1EBFm h\xE0ng \u0111\u1EA7u c\u1EE7a ng\u01B0\u1EDDi Vi\u1EC7t.
Tr\u1EA3 v\u1EC1 k\u1EBFt qu\u1EA3 d\u01B0\u1EDBi d\u1EA1ng: c\xE1c hashtags c\xE1ch nhau b\u1EB1ng d\u1EA5u c\xE1ch, k\xE8m theo 3 g\u1EE3i \xFD c\u1EE5m t\u1EEB kh\xF3a t\xECm ki\u1EBFm ch\xEDnh (search volume cao) \u0111\u1EC3 ch\xE8n v\xE0o ph\u1EA7n \u0111\u1EA7u ti\xEAu \u0111\u1EC1 ho\u1EB7c m\xF4 t\u1EA3. Tr\u1EA3 v\u1EC1 d\u01B0\u1EDBi d\u1EA1ng v\u0103n b\u1EA3n Markdown ng\u1EAFn g\u1ECDn.`;
      } else if (action === "avoid-duplication-title") {
        prompt = `B\u1EA1n l\xE0 chuy\xEAn gia t\u01B0 v\u1EA5n SEO v\xE0 b\xE1n h\xE0ng th\u01B0\u01A1ng m\u1EA1i \u0111i\u1EC7n t\u1EED chuy\xEAn nghi\u1EC7p t\u1EA1i Vi\u1EC7t Nam.
Nhi\u1EC7m v\u1EE5 c\u1EE7a b\u1EA1n l\xE0 vi\u1EBFt l\u1EA1i t\xEAn s\u1EA3n ph\u1EA9m g\u1ED1c th\xE0nh 3 ph\u01B0\u01A1ng \xE1n ti\xEAu \u0111\u1EC1 kh\xE1c nhau ho\xE0n to\xE0n v\u1EC1 m\u1EB7t c\u1EA5u tr\xFAc ch\u1EEF vi\u1EBFt v\xE0 c\u1EE5m t\u1EEB b\u1ED5 tr\u1EE3, nh\u01B0ng v\u1EABn gi\u1EEF nguy\xEAn b\u1EA3n ch\u1EA5t s\u1EA3n ph\u1EA9m \u0111\u1EC3 \u0111\u0103ng l\xEAn nhi\u1EC1u gian h\xE0ng kh\xE1c nhau (Shopee, TikTok, Lazada) m\xE0 KH\xD4NG b\u1ECB qu\xE9t tr\xF9ng l\u1EB7p n\u1ED9i dung (tr\xE1nh thu\u1EADt to\xE1n spam/duplicate listings).

Ti\xEAu \u0111\u1EC1 g\u1ED1c: "${text}"
${context ? `T\u1EEB kh\xF3a/Y\xEAu c\u1EA7u th\xEAm: ${context}` : ""}

Quy t\u1EAFc t\u1ED1i \u01B0u h\xF3a ch\u1ED1ng tr\xF9ng l\u1EB7p:
- Ph\u01B0\u01A1ng \xE1n 1 (S\u1EED d\u1EE5ng c\u1EE5m t\u1EEB gi\u1EADt t\xEDt \u0111\u1EA7u trang, c\u1EA5u tr\xFAc k\u1EF9 thu\u1EADt): V\xED d\u1EE5: "[Ch\xEDnh H\xE3ng] + T\xEAn s\u1EA3n ph\u1EA9m + Th\xF4ng s\u1ED1 k\u1EF9 thu\u1EADt n\u1ED5i b\u1EADt + C\xF4ng d\u1EE5ng ch\xEDnh".
- Ph\u01B0\u01A1ng \xE1n 2 (\u0110\xE1nh v\xE0o gi\xE1 tr\u1ECB/m\xF4 t\u1EA3 c\u1EA3m x\xFAc ng\u01B0\u1EDDi mua, qu\xE0 t\u1EB7ng k\xE8m): V\xED d\u1EE5: "T\xEAn s\u1EA3n ph\u1EA9m + [T\u1EB7ng K\xE8m Qu\xE0 / Freeship Xtra] + Ph\xE2n lo\u1EA1i/M\xE0u s\u1EAFc hot + B\u1EA3o h\xE0nh 12T".
- Ph\u01B0\u01A1ng \xE1n 3 (T\u1EADp trung t\u1EEB kh\xF3a SEO ng\xE1ch, ph\xE2n kh\xFAc \u0111\u1ED1i t\u01B0\u1EE3ng): V\xED d\u1EE5: "T\xEAn s\u1EA3n ph\u1EA9m + Gi\u1EA3i ph\xE1p cho... + Ch\u1EA5t li\u1EC7u + [\u1EA2nh Th\u1EADt T\u1EF1 Ch\u1EE5p]".
- \u0110\u1EA3m b\u1EA3o \u0111\u1ED9 d\xE0i m\u1ED7i ti\xEAu \u0111\u1EC1 t\u1EEB 75 \u0111\u1EBFn 115 k\xFD t\u1EF1.
- Ch\u1EE9a c\xE1c t\u1EEB kh\xF3a \u0111\u1ED3ng ngh\u0129a phong ph\xFA \u0111\u1EC3 c\xF4ng c\u1EE5 t\xECm ki\u1EBFm kh\xF4ng nh\u1EADn d\u1EA1ng tr\xF9ng l\u1EB7p.
- Ch\u1EC9 tr\u1EA3 v\u1EC1 danh s\xE1ch \u0111\xFAng 3 d\xF2ng ti\xEAu \u0111\u1EC1 \u0111\xE3 ch\u1EC9nh s\u1EEDa, m\u1ED7i d\xF2ng m\u1ED9t ph\u01B0\u01A1ng \xE1n, kh\xF4ng c\xF3 s\u1ED1 th\u1EE9 t\u1EF1 \u1EDF \u0111\u1EA7u d\xF2ng, kh\xF4ng gi\u1EA3i th\xEDch th\xEAm b\u1EA5t k\u1EF3 \u0111i\u1EC1u g\xEC.`;
      } else {
        return res.status(400).json({ error: "H\xE0nh \u0111\u1ED9ng kh\xF4ng h\u1EE3p l\u1EC7." });
      }
      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: prompt
      });
      return res.json({ result: response.text });
    } catch (error) {
      console.error("Gemini API Error:", error);
      return res.status(500).json({ error: error.message || "L\u1ED7i x\u1EED l\xFD AI t\u1EEB server" });
    }
  });
  const LISTINGS_DB_PATH = import_path.default.join(APP_ROOT, "data", "multi_channel_listings.json");
  const readListingsDb = () => {
    try {
      if (!import_fs.default.existsSync(LISTINGS_DB_PATH)) return [];
      const raw = import_fs.default.readFileSync(LISTINGS_DB_PATH, "utf-8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };
  const writeListingsDb = (listings) => {
    const dir = import_path.default.dirname(LISTINGS_DB_PATH);
    if (!import_fs.default.existsSync(dir)) import_fs.default.mkdirSync(dir, { recursive: true });
    import_fs.default.writeFileSync(LISTINGS_DB_PATH, JSON.stringify(listings, null, 2), "utf-8");
  };
  const markdownToHtml = (text) => {
    if (!text) return "";
    if (/<[a-z][\s\S]*>/i.test(text)) return text;
    const lines = text.split("\n");
    const parts = [];
    let inList = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        if (inList) {
          parts.push("</ul>");
          inList = false;
        }
        continue;
      }
      if (trimmed.startsWith("### ")) {
        if (inList) {
          parts.push("</ul>");
          inList = false;
        }
        parts.push(`<h3>${trimmed.slice(4)}</h3>`);
      } else if (trimmed.startsWith("## ")) {
        if (inList) {
          parts.push("</ul>");
          inList = false;
        }
        parts.push(`<h2>${trimmed.slice(3)}</h2>`);
      } else if (trimmed.startsWith("# ")) {
        if (inList) {
          parts.push("</ul>");
          inList = false;
        }
        parts.push(`<h1>${trimmed.slice(2)}</h1>`);
      } else if (/^[-*]\s+/.test(trimmed)) {
        if (!inList) {
          parts.push("<ul>");
          inList = true;
        }
        parts.push(`<li>${trimmed.replace(/^[-*]\s+/, "")}</li>`);
      } else {
        if (inList) {
          parts.push("</ul>");
          inList = false;
        }
        parts.push(`<p>${trimmed}</p>`);
      }
    }
    if (inList) parts.push("</ul>");
    return parts.join("");
  };
  app.post("/api/ai/parse-address", authMiddleware, async (req, res) => {
    try {
      const { address } = req.body || {};
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        return res.status(503).json({
          error: "Ch\u01B0a c\u1EA5u h\xECnh API Key c\u1EE7a Gemini AI."
        });
      }
      if (!address?.trim()) {
        return res.status(400).json({ error: "Thi\u1EBFu chu\u1ED7i \u0111\u1ECBa ch\u1EC9 c\u1EA7n ph\xE2n t\xEDch." });
      }
      if (!ai) {
        ai = new import_genai.GoogleGenAI({
          apiKey,
          httpOptions: { headers: { "User-Agent": "aistudio-build" } }
        });
      }
      const prompt = `B\u1EA1n l\xE0 chuy\xEAn gia ph\xE2n t\xEDch \u0111\u1ECBa ch\u1EC9 giao h\xE0ng Vi\u1EC7t Nam.
Ph\xE2n t\xEDch chu\u1ED7i \u0111\u1ECBa ch\u1EC9 sau v\xE0 tr\u1EA3 v\u1EC1 JSON thu\u1EA7n (KH\xD4NG markdown, KH\xD4NG gi\u1EA3i th\xEDch):
{"province":"...","district":"...","ward":"...","street":"..."}

Y\xEAu c\u1EA7u:
- province: t\xEAn T\u1EC9nh/Th\xE0nh ph\u1ED1 chu\u1EA9n (VD: "Th\xE0nh ph\u1ED1 H\u1ED3 Ch\xED Minh", "H\xE0 N\u1ED9i")
- district: t\xEAn Qu\u1EADn/Huy\u1EC7n/Th\u1ECB x\xE3 chu\u1EA9n (VD: "Qu\u1EADn 1", "Huy\u1EC7n \u0110\xF4ng Anh")
- ward: t\xEAn Ph\u01B0\u1EDDng/X\xE3/Th\u1ECB tr\u1EA5n chu\u1EA9n
- street: ph\u1EA7n \u0111\u1ECBa ch\u1EC9 chi ti\u1EBFt c\xF2n l\u1EA1i (s\u1ED1 nh\xE0, t\xEAn \u0111\u01B0\u1EDDng, ng\xF5 ng\xE1ch)
- Chu\u1EA9n h\xF3a vi\u1EBFt t\u1EAFt: HCM/TPHCM -> Th\xE0nh ph\u1ED1 H\u1ED3 Ch\xED Minh, Q1 -> Qu\u1EADn 1, P. -> Ph\u01B0\u1EDDng

\u0110\u1ECBa ch\u1EC9 c\u1EA7n ph\xE2n t\xEDch: "${String(address).trim()}"`;
      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: prompt
      });
      const raw = (response.text || "").trim();
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return res.status(422).json({ error: "AI kh\xF4ng tr\u1EA3 v\u1EC1 JSON h\u1EE3p l\u1EC7." });
      }
      const parsed = JSON.parse(jsonMatch[0]);
      return res.json({
        success: true,
        parsed: {
          province: String(parsed.province || "").trim(),
          district: String(parsed.district || "").trim(),
          ward: String(parsed.ward || "").trim(),
          street: String(parsed.street || "").trim()
        }
      });
    } catch (error) {
      console.error("[AI parse-address]", error);
      return res.status(500).json({ error: error.message || "L\u1ED7i ph\xE2n t\xEDch \u0111\u1ECBa ch\u1EC9 AI" });
    }
  });
  app.post("/api/ai/generate-description", authMiddleware, async (req, res) => {
    try {
      const { title, keywords, context } = req.body || {};
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        return res.status(503).json({
          error: "Ch\u01B0a c\u1EA5u h\xECnh API Key c\u1EE7a Gemini AI."
        });
      }
      if (!ai) {
        ai = new import_genai.GoogleGenAI({
          apiKey,
          httpOptions: { headers: { "User-Agent": "aistudio-build" } }
        });
      }
      const prompt = `B\u1EA1n l\xE0 chuy\xEAn gia Copywriter vi\u1EBFt m\xF4 t\u1EA3 s\u1EA3n ph\u1EA9m b\xE1n h\xE0ng tr\xEAn Shopee, Lazada v\xE0 TikTok Shop Vi\u1EC7t Nam.
H\xE3y vi\u1EBFt m\xF4 t\u1EA3 s\u1EA3n ph\u1EA9m d\u1EA1ng HTML (d\xF9ng th\u1EBB h2, h3, p, ul, li, strong) \u2014 KH\xD4NG d\xF9ng markdown, KH\xD4NG b\u1ECDc trong \`\`\`html.
T\xEAn s\u1EA3n ph\u1EA9m: "${title || ""}"
T\u1EEB kh\xF3a / T\xEDnh n\u0103ng: "${keywords || ""}"
${context ? `Th\xF4ng tin th\xEAm: ${context}` : ""}

C\u1EA5u tr\xFAc: slogan ng\u1EAFn, \u0111\u1EB7c \u0111i\u1EC3m n\u1ED5i b\u1EADt (ul/li), th\xF4ng s\u1ED1, cam k\u1EBFt shop, hashtags cu\u1ED1i b\xE0i. Ch\u1EC9 tr\u1EA3 v\u1EC1 HTML thu\u1EA7n.`;
      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: prompt
      });
      const raw = (response.text || "").trim();
      const html = markdownToHtml(raw.replace(/^```html\s*/i, "").replace(/```\s*$/i, ""));
      return res.json({ success: true, html });
    } catch (error) {
      console.error("[AI generate-description]", error);
      return res.status(500).json({ error: error.message || "L\u1ED7i t\u1EA1o m\xF4 t\u1EA3 AI" });
    }
  });
  app.get("/api/multi-channel/listing", authMiddleware, (_req, res) => {
    return res.json({ success: true, listings: readListingsDb() });
  });
  app.post("/api/multi-channel/listing", authMiddleware, (req, res) => {
    try {
      const payload = req.body || {};
      const listings = readListingsDb();
      const entry = {
        id: `listing-${Date.now()}`,
        ...payload,
        savedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      listings.unshift(entry);
      writeListingsDb(listings.slice(0, 200));
      return res.json({ success: true, id: entry.id, message: "L\u01B0u nh\xE1p \u0111\u0103ng b\xE1n \u0111a s\xE0n th\xE0nh c\xF4ng" });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message || "L\u01B0u th\u1EA5t b\u1EA1i" });
    }
  });
  const PRODUCT_LISTINGS_DB_PATH = import_path.default.join(APP_ROOT, "data", "product_listings.json");
  const readProductListingsDb = () => {
    try {
      if (!import_fs.default.existsSync(PRODUCT_LISTINGS_DB_PATH)) return [];
      const raw = import_fs.default.readFileSync(PRODUCT_LISTINGS_DB_PATH, "utf-8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };
  const writeProductListingsDb = (rows) => {
    const dir = import_path.default.dirname(PRODUCT_LISTINGS_DB_PATH);
    if (!import_fs.default.existsSync(dir)) import_fs.default.mkdirSync(dir, { recursive: true });
    import_fs.default.writeFileSync(PRODUCT_LISTINGS_DB_PATH, JSON.stringify(rows, null, 2), "utf-8");
  };
  const computeOverallListingStatus = (statuses) => {
    if (!statuses.length) return "pending";
    const hasSuccess = statuses.includes("success");
    const hasFailed = statuses.includes("failed");
    const hasPending = statuses.includes("pending");
    if (hasPending && !hasSuccess && !hasFailed) return "pending";
    if (hasSuccess && hasFailed) return "partial";
    if (hasSuccess) return "success";
    if (hasFailed) return "failed";
    return "pending";
  };
  app.get("/api/product-listings", authMiddleware, (_req, res) => {
    try {
      const rows = readProductListingsDb();
      const products = loadProducts();
      const byProduct = /* @__PURE__ */ new Map();
      for (const row of rows) {
        const pid = row.product_id || "unknown";
        if (!byProduct.has(pid)) byProduct.set(pid, []);
        byProduct.get(pid).push(row);
      }
      const groups = Array.from(byProduct.entries()).map(([productId, children]) => {
        const sorted = [...children].sort(
          (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
        );
        const product = products.find((p) => p.id === productId);
        const statuses = sorted.map((c) => c.status);
        const created = sorted.reduce((min, c) => c.created_at < min ? c.created_at : min, sorted[0].created_at);
        const updated = sorted.reduce((max, c) => c.updated_at > max ? c.updated_at : max, sorted[0].updated_at);
        const platforms = Array.from(new Set(sorted.map((c) => c.platform)));
        return {
          product_id: productId,
          product_title: product?.title || sorted[0]?.listing_title || "S\u1EA3n ph\u1EA9m kh\xF4ng x\xE1c \u0111\u1ECBnh",
          product_image: product?.imageUrl || product?.avatarUrl || sorted[0]?.product_image,
          product_sku: product?.sku,
          created_at: created,
          updated_at: updated,
          overall_status: computeOverallListingStatus(statuses),
          platform_labels: platforms,
          children: sorted
        };
      });
      groups.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
      return res.json({ success: true, groups });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  });
  app.post("/api/product-listings/clear-all", authMiddleware, (_req, res) => {
    writeProductListingsDb([]);
    return res.json({ success: true, cleared: true, groups: [] });
  });
  app.post("/api/catalog/wipe-all", authMiddleware, (_req, res) => {
    saveProducts([]);
    saveImports([]);
    writeListingsDb([]);
    writeProductListingsDb([]);
    console.log("[Catalog] \u0110\xE3 x\xF3a s\u1EA1ch products, imports, multi_channel_listings, product_listings.");
    return res.json({
      success: true,
      cleared: true,
      products: [],
      imports: [],
      listings: [],
      productListings: []
    });
  });
  app.post("/api/multi-channel/publish", authMiddleware, (req, res) => {
    try {
      const payload = req.body || {};
      const {
        warehouseProductId,
        title,
        images = [],
        shops = [],
        selectedShops = []
      } = payload;
      const productId = warehouseProductId || payload.product_id || "unknown";
      const product = loadProducts().find((p) => p.id === productId);
      const batchId = `batch-${Date.now()}`;
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const allRows = readProductListingsDb();
      const newRows = [];
      const shopList = Array.isArray(shops) && shops.length ? shops : selectedShops.map((id) => ({ id, name: id, platform: "shopee" }));
      for (let i = 0; i < shopList.length; i++) {
        const shop = shopList[i];
        const platform = String(shop.platform || "shopee").toLowerCase();
        if (!["shopee", "lazada", "tiktok"].includes(platform)) continue;
        const existingIdx = allRows.findIndex(
          (r) => r.product_id === productId && r.shop_id === shop.id && r.platform === platform
        );
        const simulateFail = platform === "lazada" && i % 3 === 2;
        const status = simulateFail ? "failed" : "success";
        const platformProductId = status === "success" ? `${platform}-${productId}-${Date.now().toString(36)}` : void 0;
        const row = {
          id: existingIdx >= 0 ? allRows[existingIdx].id : `pl-${Date.now()}-${i}`,
          product_id: productId,
          publish_batch_id: batchId,
          platform,
          shop_id: shop.id,
          shop_name: shop.name || shop.shopName || shop.id,
          status,
          platform_product_id: platformProductId,
          error_message: status === "failed" ? "L\u1ED7i x\xE1c th\u1EF1c danh m\u1EE5c ho\u1EB7c t\u1EEB kh\xF3a b\u1ECB c\u1EA5m tr\xEAn s\xE0n" : void 0,
          listing_title: payload.shopTitles && payload.shopTitles[shop.id] || title || product?.title,
          product_image: images[0] || product?.imageUrl || product?.avatarUrl,
          created_at: existingIdx >= 0 ? allRows[existingIdx].created_at : now,
          updated_at: now
        };
        if (existingIdx >= 0) {
          allRows[existingIdx] = row;
        } else {
          allRows.unshift(row);
        }
        newRows.push(row);
      }
      writeProductListingsDb(allRows.slice(0, 2e3));
      const draftListings = readListingsDb();
      draftListings.unshift({
        id: `listing-${Date.now()}`,
        ...payload,
        publish_batch_id: batchId,
        savedAt: now,
        published: true
      });
      writeListingsDb(draftListings.slice(0, 200));
      return res.json({
        success: true,
        batchId,
        listings: newRows,
        message: `\u0110\xE3 ghi nh\u1EADn \u0111\u0103ng b\xE1n l\xEAn ${newRows.length} gian h\xE0ng`
      });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message || "\u0110\u0103ng b\xE1n th\u1EA5t b\u1EA1i" });
    }
  });
  const PUBLISH_EDIT_DB_PATH = import_path.default.join(APP_ROOT, "data", "publish_edit.json");
  const FRAMED_IMAGES_DIR = import_path.default.join(APP_ROOT, "data", "framed_images");
  const readPublishEditDb = () => {
    try {
      if (!import_fs.default.existsSync(PUBLISH_EDIT_DB_PATH)) return { config: {}, meta: {} };
      const raw = import_fs.default.readFileSync(PUBLISH_EDIT_DB_PATH, "utf-8");
      const parsed = JSON.parse(raw);
      return { config: parsed.config || {}, meta: parsed.meta || {} };
    } catch {
      return { config: {}, meta: {} };
    }
  };
  const writePublishEditDb = (data) => {
    const dir = import_path.default.dirname(PUBLISH_EDIT_DB_PATH);
    if (!import_fs.default.existsSync(dir)) import_fs.default.mkdirSync(dir, { recursive: true });
    import_fs.default.writeFileSync(PUBLISH_EDIT_DB_PATH, JSON.stringify(data, null, 2), "utf-8");
  };
  app.get("/api/publish-edit", authMiddleware, (_req, res) => {
    const db = readPublishEditDb();
    return res.json({ success: true, config: db.config, meta: db.meta });
  });
  app.post("/api/publish-edit/config", authMiddleware, (req, res) => {
    try {
      const db = readPublishEditDb();
      db.config = { ...db.config, ...req.body, updated_at: (/* @__PURE__ */ new Date()).toISOString() };
      writePublishEditDb(db);
      return res.json({ success: true, config: db.config });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  });
  app.post("/api/publish-edit/batch-titles", authMiddleware, (req, res) => {
    try {
      const { assignments = [] } = req.body || {};
      const db = readPublishEditDb();
      for (const item of assignments) {
        if (!item.productId) continue;
        db.meta[item.productId] = {
          ...db.meta[item.productId] || {},
          shopTitles: item.shopTitles || {},
          aiTitles: item.aiTitles || [],
          titlesAppliedAt: (/* @__PURE__ */ new Date()).toISOString()
        };
      }
      writePublishEditDb(db);
      return res.json({ success: true, meta: db.meta });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  });
  app.post("/api/publish-edit/save-framed-image", authMiddleware, (req, res) => {
    try {
      const { productId, imageDataUrl, framedHash } = req.body || {};
      if (!productId || !imageDataUrl) {
        return res.status(400).json({ success: false, error: "Thi\u1EBFu productId ho\u1EB7c \u1EA3nh" });
      }
      if (!import_fs.default.existsSync(FRAMED_IMAGES_DIR)) import_fs.default.mkdirSync(FRAMED_IMAGES_DIR, { recursive: true });
      const base64 = String(imageDataUrl).replace(/^data:image\/\w+;base64,/, "");
      const buf = Buffer.from(base64, "base64");
      const filename = `${productId}.jpg`;
      import_fs.default.writeFileSync(import_path.default.join(FRAMED_IMAGES_DIR, filename), buf);
      const imageUrl = `/api/framed-images/${productId}`;
      const products = loadProducts();
      const idx = products.findIndex((p) => p.id === productId);
      if (idx >= 0) {
        products[idx] = { ...products[idx], imageUrl };
        saveProducts(products);
      }
      const db = readPublishEditDb();
      db.meta[productId] = {
        ...db.meta[productId] || {},
        framedImageUrl: imageUrl,
        framedHash: framedHash || `hash-${buf.length}`,
        frameAppliedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      writePublishEditDb(db);
      return res.json({ success: true, imageUrl, framedHash: db.meta[productId].framedHash });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  });
  app.get("/api/framed-images/:productId", (req, res) => {
    const filePath = import_path.default.join(FRAMED_IMAGES_DIR, `${req.params.productId}.jpg`);
    if (!import_fs.default.existsSync(filePath)) {
      return res.status(404).json({ error: "Kh\xF4ng t\xECm th\u1EA5y \u1EA3nh" });
    }
    res.setHeader("Content-Type", "image/jpeg");
    return res.send(import_fs.default.readFileSync(filePath));
  });
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa"
    });
    app.use(vite.middlewares);
  } else {
    const distPath = import_path.default.join(APP_ROOT, "dist");
    app.use(import_express.default.static(distPath, {
      setHeaders(res, filePath) {
        if (filePath.endsWith("index.html")) {
          res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
          res.setHeader("Pragma", "no-cache");
          res.setHeader("Expires", "0");
        } else if (/\.(js|css)$/.test(filePath)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
      }
    }));
    app.get("*", (req, res) => {
      if (req.path.startsWith("/labels/")) {
        return res.status(404).type("text/plain").send("Kh\xF4ng t\xECm th\u1EA5y file v\u1EADn \u0111\u01A1n.");
      }
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.sendFile(import_path.default.join(distPath, "index.html"));
    });
  }
  if (process.env.PORT) {
    app.listen(PORT, () => {
      console.log(`Server optimized for cPanel Phusion Passenger: listening on ${PORT}`);
      console.log(`[Config] APP_BASE_URL=${APP_BASE_URL}`);
      console.log(`[Config] NODE_ENV=${process.env.NODE_ENV || "unset"}`);
      console.log(`[Shopee] Callback=${SHOPEE_CALLBACK_URL}`);
    });
  } else {
    app.listen(Number(PORT), "0.0.0.0", () => {
      console.log(`Server running locally on port ${PORT}`);
      console.log(`[Config] APP_BASE_URL=${APP_BASE_URL}`);
      console.log(`[Shopee] Callback=${SHOPEE_CALLBACK_URL}`);
      console.log("[Dashboard] API route ready: GET /api/dashboard?date_range=...");
    });
  }
}
startServer();
