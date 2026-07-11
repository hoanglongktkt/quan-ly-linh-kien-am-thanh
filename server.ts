import express from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { PDFDocument } from "pdf-lib";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import { enrichOrdersFromCatalog } from "./src/utils/orderItemVariation.ts";

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET || "omnisales-vn-super-secret-key-2026";
const ENV_PATH = path.join(process.cwd(), ".env");

const PRODUCTION_APP_URL = "https://quanly.linhkienamthanh.net";

function resolveAppBaseUrl(): string {
  const fromEnv = String(process.env.APP_URL || process.env.API_BASE_URL || "").trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  if (process.env.NODE_ENV === "production") return PRODUCTION_APP_URL;
  return PRODUCTION_APP_URL;
}

const APP_BASE_URL = resolveAppBaseUrl();
const SHOPEE_CALLBACK_URL = `${APP_BASE_URL}/api/shopee/callback`;
const SHOPEE_WEBHOOK_URL = `${APP_BASE_URL}/api/shopee/webhook`;

function updateEnvVar(key: string, value: string): void {
  let content = "";
  if (fs.existsSync(ENV_PATH)) {
    content = fs.readFileSync(ENV_PATH, "utf-8");
  }
  const regex = new RegExp(`^${key}\\s*=.*$`, "m");
  const line = `${key}=${value}`;
  if (regex.test(content)) {
    content = content.replace(regex, line);
  } else {
    content = (content.trimEnd() ? content.trimEnd() + "\n" : "") + line + "\n";
  }
  fs.writeFileSync(ENV_PATH, content, "utf-8");
  process.env[key] = value;
}

function maskApiKey(key: string): string {
  if (!key || key.length < 8) return "••••••••";
  return key.slice(0, 4) + "••••" + key.slice(-4);
}

// ---------------------------------------------------------------------------
// Shopee Open Platform (Partner API v2) — REAL integration, not sandbox mock.
// Credentials must be the LIVE Partner ID / Live API Partner Key issued for
// your production App on https://open.shopee.com (NOT the old Sandbox app).
// ---------------------------------------------------------------------------
const SHOPEE_ENV = (process.env.SHOPEE_ENV || "live").toLowerCase();
const SHOPEE_HOST = "https://partner.shopeemobile.com";
if (SHOPEE_ENV !== "live") {
  console.warn(`[Shopee API] SHOPEE_ENV=${SHOPEE_ENV} — chỉ dùng host Live: ${SHOPEE_HOST}`);
}
const SHOPEE_PARTNER_ID = process.env.SHOPEE_PARTNER_ID || "";
const SHOPEE_PARTNER_KEY = process.env.SHOPEE_PARTNER_KEY || "";

// Partner_id from Shopee MUST be a plain integer. Anything else (empty, or a
// leftover placeholder like "CHUA_CO_LIVE_PARTNER_ID") means the real Live
// credentials were never filled in — every Shopee call will fail with
// "error_param" before it even reaches the order APIs.
function isShopeeConfigValid(): boolean {
  return /^\d+$/.test(SHOPEE_PARTNER_ID) && SHOPEE_PARTNER_KEY.length > 0 && !/CHUA_CO|YOUR_LIVE/i.test(SHOPEE_PARTNER_KEY);
}

if (!isShopeeConfigValid()) {
  console.warn(
    `[Shopee API] \u26A0\uFE0F SHOPEE_PARTNER_ID (hi\u1EC7n t\u1EA1i: "${SHOPEE_PARTNER_ID || "(r\u1ED7ng)"}") ho\u1EB7c SHOPEE_PARTNER_KEY ch\u01B0a \u0111\u01B0\u1EE3c \u0111i\u1EC1n \u0111\xFAng trong .env. ` +
      "Partner_id ph\u1EA3i l\xE0 m\u1ED9t s\u1ED1 nguy\xEAn (v\xED d\u1EE5: 2001234), l\u1EA5y t\u1EEB App PRODUCTION (Live) tr\xEAn open.shopee.com, KH\xD4NG d\xF9ng Sandbox. M\u1ECDi l\u1EA7n g\u1ECDi API Shopee s\u1EBD b\u1EC3 tr\u1EA3 l\u1ED7i error_param cho \u0111\u1EBFn khi s\u1EEDa \u0111\xFAng gi\xE1 tr\u1ECB n\xE0y."
  );
}

// Local JSON-file token store: shop_id -> { access_token, refresh_token, expire_in, obtained_at }
const SHOPEE_TOKENS_PATH = path.join(process.cwd(), "data", "shopee_tokens.json");

function loadShopeeTokens(): Record<string, any> {
  try {
    if (!fs.existsSync(SHOPEE_TOKENS_PATH)) return {};
    const raw = fs.readFileSync(SHOPEE_TOKENS_PATH, "utf-8");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch (error) {
    console.error("[Shopee Tokens] Failed to read shopee_tokens.json:", error);
    return {};
  }
}

function saveShopeeTokens(tokens: Record<string, any>): void {
  try {
    fs.mkdirSync(path.dirname(SHOPEE_TOKENS_PATH), { recursive: true });
    fs.writeFileSync(SHOPEE_TOKENS_PATH, JSON.stringify(tokens, null, 2), "utf-8");
  } catch (error) {
    console.error("[Shopee Tokens] Failed to write shopee_tokens.json:", error);
  }
}

// Signature per Shopee v2 spec: HMAC-SHA256(partner_key, partner_id + path + timestamp [+ access_token + shop_id])
function shopeeSign(apiPath: string, timestamp: number, accessToken?: string, shopId?: string | number): string {
  const baseString = accessToken && shopId
    ? `${SHOPEE_PARTNER_ID}${apiPath}${timestamp}${accessToken}${shopId}`
    : `${SHOPEE_PARTNER_ID}${apiPath}${timestamp}`;
  return crypto.createHmac("sha256", SHOPEE_PARTNER_KEY).update(baseString).digest("hex");
}

// Exchange the OAuth `code` for a real access_token/refresh_token pair (Live Shop).
async function exchangeShopeeCodeForToken(code: string, shopId: string) {
  if (!isShopeeConfigValid()) {
    const error = {
      error: "invalid_partner_config",
      message: `SHOPEE_PARTNER_ID/"${SHOPEE_PARTNER_ID}" ho\u1EB7c SHOPEE_PARTNER_KEY trong .env ch\u01B0a ph\u1EA3i gi\xE1 tr\u1ECB Live th\u1EF1c. Vui l\xF2ng \u0111i\u1EC1n \u0111\xFAng Partner ID (s\u1ED1 nguy\xEAn) v\xE0 Partner Key t\u1EEB App PRODUCTION tr\xEAn open.shopee.com r\u1ED3i th\u1EED l\u1EA1i.`,
    };
    console.error(`[Shopee OAuth] \u274C Kh\xF4ng th\u1EC3 \u0111\u1ED5i code cho shop_id=${shopId}: ${error.message}`);
    return error;
  }

  const apiPath = "/api/v2/auth/token/get";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp);
  const url = `${SHOPEE_HOST}${apiPath}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&sign=${sign}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, shop_id: Number(shopId), partner_id: Number(SHOPEE_PARTNER_ID) }),
  });
  const json: any = await res.json();
  console.log(`[Shopee API] POST ${apiPath} (env=${SHOPEE_ENV}) -> HTTP ${res.status}:`, JSON.stringify(json));

  if (json.access_token) {
    const tokens = loadShopeeTokens();
    tokens[shopId] = {
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      expire_in: json.expire_in,
      obtained_at: Math.floor(Date.now() / 1000),
    };
    saveShopeeTokens(tokens);
  }
  return json;
}

// Refresh an expired access_token using the stored refresh_token.
async function refreshShopeeToken(shopId: string, refreshToken: string) {
  const apiPath = "/api/v2/auth/access_token/get";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp);
  const url = `${SHOPEE_HOST}${apiPath}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&sign=${sign}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken, shop_id: Number(shopId), partner_id: Number(SHOPEE_PARTNER_ID) }),
  });
  const json: any = await res.json();
  console.log(`[Shopee API] POST ${apiPath} (refresh) -> HTTP ${res.status}:`, JSON.stringify(json));

  if (json.access_token) {
    const tokens = loadShopeeTokens();
    tokens[shopId] = {
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      expire_in: json.expire_in,
      obtained_at: Math.floor(Date.now() / 1000),
    };
    saveShopeeTokens(tokens);
  }
  return json;
}

// Returns a valid (non-expired) access_token for the shop, refreshing it first if needed.
async function getValidShopeeAccessToken(shopId: string): Promise<string | null> {
  const tokens = loadShopeeTokens();
  const record = tokens[shopId];
  if (!record) {
    console.warn(`[Shopee API] Ch\u01B0a c\xF3 access_token n\xE0o cho shop_id=${shopId}. C\u1EA7n th\u1EF1c hi\u1EC7n l\u1EA1i lu\u1ED3ng OAuth (/api/shopee/callback) v\u1EDBi shop Live th\u1EADt.`);
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  const isExpired = now - record.obtained_at >= record.expire_in - 60; // refresh 60s early
  if (!isExpired) return record.access_token;

  console.log(`[Shopee API] access_token c\u1EE7a shop_id=${shopId} \u0111\xE3 h\u1EBFt h\u1EA1n, \u0111ang refresh...`);
  const refreshed = await refreshShopeeToken(shopId, record.refresh_token);
  return refreshed.access_token || null;
}

// v2.order.get_order_list — pulls order_sn updated within the last 15 days.
// Supports optional order_status filter and cursor pagination (Shopee returns
// at most page_size orders per call; more/next_cursor must be followed).
async function shopeeGetOrderList(
  shopId: string,
  accessToken: string,
  opts?: { orderStatus?: string; cursor?: string; timeRangeField?: "create_time" | "update_time" }
) {
  const apiPath = "/api/v2/order/get_order_list";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);

  const params = new URLSearchParams({
    partner_id: SHOPEE_PARTNER_ID,
    timestamp: String(timestamp),
    access_token: accessToken,
    shop_id: shopId,
    sign,
    time_range_field: opts?.timeRangeField || "update_time",
    time_from: String(timestamp - 15 * 24 * 60 * 60),
    time_to: String(timestamp),
    page_size: "100",
    response_optional_fields: "order_status",
  });
  if (opts?.orderStatus) params.set("order_status", opts.orderStatus);
  if (opts?.cursor !== undefined && opts.cursor !== "") params.set("cursor", opts.cursor);

  const url = `${SHOPEE_HOST}${apiPath}?${params.toString()}`;
  const res = await fetch(url);
  const json: any = await res.json();
  console.log(`[Shopee API] GET ${apiPath} (shop_id=${shopId}, status=${opts?.orderStatus || "ALL"}) -> HTTP ${res.status}:`, JSON.stringify(json));

  if (json.error) {
    console.error(`[Shopee API] L\u1ED7i t\u1EEB Shopee khi l\u1EA5y danh s\xE1ch \u0111\u01A1n: ${json.error} - ${json.message}`);
  }
  return json;
}

// Shopee order_list pagination — response uses `more` + `next_cursor` (some SDKs
// alias has_more). Read both so we never stop after page 1 by mistake.
function parseShopeeOrderListPagination(result: any): { more: boolean; nextCursor: string } {
  const body = result?.response ?? result ?? {};
  const more =
    body.more === true ||
    body.more === 1 ||
    body.more === "true" ||
    body.has_more === true ||
    body.has_more === 1 ||
    body.has_more === "true";
  const nextCursor = String(body.next_cursor ?? body.cursor ?? "").trim();
  return { more, nextCursor };
}

// Paginate get_order_list for one Shopee order_status until `more` is false.
async function shopeeFetchAllOrderSnsByStatus(shopId: string, accessToken: string, orderStatus: string): Promise<string[]> {
  const orderSnSet = new Set<string>();
  let cursor: string | undefined;
  let page = 0;
  const maxPages = 500;

  while (page < maxPages) {
    page++;
    const listResult = await shopeeGetOrderList(shopId, accessToken, {
      orderStatus,
      cursor,
      timeRangeField: "update_time",
    });
    if (listResult.error) {
      throw new Error(`${listResult.error}${listResult.message ? ` - ${listResult.message}` : ""}`);
    }

    const pageList: any[] = listResult.response?.order_list || [];
    for (const row of pageList) {
      if (row?.order_sn) orderSnSet.add(String(row.order_sn));
    }

    const { more, nextCursor } = parseShopeeOrderListPagination(listResult);
    console.log(
      `[Shopee Sync] shop_id=${shopId} status=${orderStatus} page=${page}: +${pageList.length} đơn (tổng ${orderSnSet.size}), more=${more}, next_cursor=${nextCursor ? "yes" : "no"}`
    );

    if (!more) break;
    if (!nextCursor) {
      console.warn(`[Shopee Sync] shop_id=${shopId} status=${orderStatus}: more=true nhưng thiếu next_cursor — dừng sau trang ${page}.`);
      break;
    }
    cursor = nextCursor;
    await new Promise((r) => setTimeout(r, 150));
  }

  return Array.from(orderSnSet);
}

// Paginate get_order_list without status filter (all statuses in time window).
async function shopeeFetchAllOrderSns(shopId: string, accessToken: string): Promise<string[]> {
  const orderSnSet = new Set<string>();
  let cursor: string | undefined;
  let page = 0;
  const maxPages = 500;

  while (page < maxPages) {
    page++;
    const listResult = await shopeeGetOrderList(shopId, accessToken, { cursor, timeRangeField: "update_time" });
    if (listResult.error) {
      throw new Error(`${listResult.error}${listResult.message ? ` - ${listResult.message}` : ""}`);
    }

    const pageList: any[] = listResult.response?.order_list || [];
    for (const row of pageList) {
      if (row?.order_sn) orderSnSet.add(String(row.order_sn));
    }

    const { more, nextCursor } = parseShopeeOrderListPagination(listResult);
    console.log(
      `[Shopee API] shop_id=${shopId} page=${page}: +${pageList.length} đơn (tổng ${orderSnSet.size}), more=${more}`
    );

    if (!more) break;
    if (!nextCursor) break;
    cursor = nextCursor;
    await new Promise((r) => setTimeout(r, 150));
  }

  return Array.from(orderSnSet);
}

// v2.order.get_order_detail — pulls full order info (buyer, items, address...) for up to 50 order_sn at a time.
async function shopeeGetOrderDetail(shopId: string, accessToken: string, orderSnList: string[]) {
  const apiPath = "/api/v2/order/get_order_detail";
  const timestamp = Math.floor(Date.now() / 1000);
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
    response_optional_fields: "buyer_user_id,buyer_username,recipient_address,item_list,total_amount,shipping_carrier,package_list",
  });

  const url = `${SHOPEE_HOST}${apiPath}?${params.toString()}`;
  const res = await fetch(url);
  const json: any = await res.json();
  console.log(`[Shopee API] GET ${apiPath} (shop_id=${shopId}, ${orderSnList.length} orders) -> HTTP ${res.status}:`, JSON.stringify(json));

  if (json.error) {
    console.error(`[Shopee API] L\u1ED7i t\u1EEB Shopee khi l\u1EA5y chi ti\u1EBFt \u0111\u01A1n: ${json.error} - ${json.message}`);
  }
  return json;
}

// v2.product.get_item_list — paginated list of item_ids currently listed on the shop.
async function shopeeGetItemList(shopId: string, accessToken: string, offset: number) {
  const apiPath = "/api/v2/product/get_item_list";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);

  const params = new URLSearchParams({
    partner_id: SHOPEE_PARTNER_ID,
    timestamp: String(timestamp),
    access_token: accessToken,
    shop_id: shopId,
    sign,
    offset: String(offset),
    page_size: "100",
    item_status: "NORMAL",
  });

  const url = `${SHOPEE_HOST}${apiPath}?${params.toString()}`;
  const res = await fetch(url);
  const json: any = await res.json();
  console.log(`[Shopee API] GET ${apiPath} (offset=${offset}) -> HTTP ${res.status}:`, JSON.stringify(json));
  if (json.error) {
    console.error(`[Shopee API] L\u1ED7i t\u1EEB Shopee khi l\u1EA5y danh s\xE1ch s\u1EA3n ph\u1EA9m: ${json.error} - ${json.message}`);
  }
  return json;
}

// v2.product.get_item_base_info — name/SKU/price/stock/image for up to 50 items at a time.
async function shopeeGetItemBaseInfo(shopId: string, accessToken: string, itemIds: number[]) {
  const apiPath = "/api/v2/product/get_item_base_info";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);

  const params = new URLSearchParams({
    partner_id: SHOPEE_PARTNER_ID,
    timestamp: String(timestamp),
    access_token: accessToken,
    shop_id: shopId,
    sign,
    item_id_list: itemIds.join(","),
    need_tax_info: "false",
    need_complaint_policy: "false",
  });

  const url = `${SHOPEE_HOST}${apiPath}?${params.toString()}`;
  const res = await fetch(url);
  const json: any = await res.json();
  console.log(`[Shopee API] GET ${apiPath} (${itemIds.length} items) -> HTTP ${res.status}:`, JSON.stringify(json));
  if (json.error) {
    console.error(`[Shopee API] L\u1ED7i t\u1EEB Shopee khi l\u1EA5y th\xF4ng tin s\u1EA3n ph\u1EA9m: ${json.error} - ${json.message}`);
  }
  return json;
}

// v2.product.get_model_list — required for items that have variants (has_model=true);
// get_item_base_info's own price_info/stock_info_v2 do NOT reflect real numbers for those.
async function shopeeGetModelList(shopId: string, accessToken: string, itemId: number) {
  const apiPath = "/api/v2/product/get_model_list";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);

  const params = new URLSearchParams({
    partner_id: SHOPEE_PARTNER_ID,
    timestamp: String(timestamp),
    access_token: accessToken,
    shop_id: shopId,
    sign,
    item_id: String(itemId),
  });

  const url = `${SHOPEE_HOST}${apiPath}?${params.toString()}`;
  const res = await fetch(url);
  const json: any = await res.json();
  console.log(`[Shopee API] GET ${apiPath} (item_id=${itemId}) -> HTTP ${res.status}:`, JSON.stringify(json));
  return json;
}

async function shopeeGetModelListWithRetry(shopId: string, accessToken: string, itemId: number, retries = 2) {
  let last: any = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 500 * attempt));
    last = await shopeeGetModelList(shopId, accessToken, itemId);
    if (!last?.error) return last;
  }
  return last;
}

// v2.product.update_stock — đẩy tồn kho seller_stock lên sàn Shopee (theo item_id, có/không model_id).
async function shopeeUpdateStock(
  shopId: string,
  accessToken: string,
  itemId: number,
  stockList: { model_id?: number; seller_stock: { stock: number }[] }[]
) {
  const apiPath = "/api/v2/product/update_stock";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);
  const url = `${SHOPEE_HOST}${apiPath}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&access_token=${accessToken}&shop_id=${shopId}&sign=${sign}`;

  const body = { item_id: itemId, stock_list: stockList };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json: any = await res.json();
  console.log(`[Shopee API] POST ${apiPath} (item_id=${itemId}) -> HTTP ${res.status}:`, JSON.stringify(json));
  return json;
}

async function shopeeUpdatePrice(
  shopId: string,
  accessToken: string,
  itemId: number,
  priceList: { model_id?: number; original_price: number }[]
) {
  const apiPath = "/api/v2/product/update_price";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);
  const url = `${SHOPEE_HOST}${apiPath}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&access_token=${accessToken}&shop_id=${shopId}&sign=${sign}`;

  const body = { item_id: itemId, price_list: priceList };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json: any = await res.json();
  console.log(`[Shopee API] POST ${apiPath} (item_id=${itemId}) -> HTTP ${res.status}:`, JSON.stringify(json));
  return json;
}

type ChannelSyncLine = {
  productId: string;
  sku: string;
  channel: string;
  action: string;
  success: boolean;
  message: string;
};

function parseShopeeApiResult(
  result: any,
  product: any,
  action: string
): ChannelSyncLine {
  const failures: any[] = result?.response?.failure_list || [];
  if (result?.error) {
    return {
      productId: product.id,
      sku: product.sku,
      channel: "shopee",
      action,
      success: false,
      message: `${result.error}${result.message ? ` — ${result.message}` : ""}`,
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
      message: String(f.failed_reason || f.error || JSON.stringify(f)),
    };
  }
  return {
    productId: product.id,
    sku: product.sku,
    channel: "shopee",
    action,
    success: true,
    message: `Cập nhật ${action} Shopee thành công`,
  };
}

async function syncProductToShopee(
  product: any,
  shopId: string,
  accessToken: string
): Promise<ChannelSyncLine[]> {
  const itemId = Number(product.shopeeItemId);
  if (!Number.isFinite(itemId)) {
    const base = {
      productId: product.id,
      sku: product.sku,
      channel: "shopee",
      success: false,
      message: "Thiếu shopeeItemId — SKU chưa liên kết Shopee",
    };
    return [
      { ...base, action: "update_stock" },
      { ...base, action: "update_price" },
    ];
  }

  const stockEntry: { model_id?: number; seller_stock: { stock: number }[] } = {
    seller_stock: [{ stock: Math.max(0, Math.round(Number(product.stock) || 0)) }],
  };
  const priceEntry: { model_id?: number; original_price: number } = {
    original_price: Math.max(0, Math.round(Number(product.sellingPrice) || 0)),
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
    parseShopeeApiResult(priceResult, product, "update_price"),
  ];
}

async function syncProductToWoo(product: any, shop: any): Promise<ChannelSyncLine[]> {
  const base = {
    productId: product.id,
    sku: product.sku,
    channel: "woocommerce",
    action: "update_product",
  };

  if (!shop?.wooUrl || !shop?.apiKey) {
    return [{ ...base, success: false, message: "Chưa cấu hình WooCommerce (URL/API Key)" }];
  }
  if (!product.wooId) {
    return [{ ...base, success: false, message: "Thiếu wooId — SKU chưa liên kết WooCommerce" }];
  }

  const baseUrl = String(shop.wooUrl).replace(/\/$/, "");
  const url = `${baseUrl}/wp-json/wc/v3/products/${product.wooId}`;
  const auth = Buffer.from(`${shop.apiKey}:${shop.apiSecret || ""}`).toString("base64");

  try {
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        regular_price: String(Math.round(Number(product.sellingPrice) || 0)),
        stock_quantity: Math.max(0, Math.round(Number(product.stock) || 0)),
        manage_stock: true,
      }),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const errMsg = json?.message || json?.code || `HTTP ${res.status}`;
      return [{ ...base, success: false, message: `WooCommerce từ chối: ${errMsg}` }];
    }
    return [{ ...base, success: true, message: `Cập nhật giá & tồn kho WooCommerce thành công (ID: ${product.wooId})` }];
  } catch (e: any) {
    return [{ ...base, success: false, message: `Lỗi kết nối WooCommerce: ${e?.message || "network error"}` }];
  }
}

async function syncProductToTikTok(product: any): Promise<ChannelSyncLine[]> {
  const base = {
    productId: product.id,
    sku: product.sku,
    channel: "tiktok",
    action: "update_product",
  };
  if (!product.tiktokId) {
    return [{ ...base, success: false, message: "Thiếu tiktokId — SKU chưa liên kết TikTok Shop" }];
  }
  return [{ ...base, success: false, message: "API TikTok Shop chưa được tích hợp trên server" }];
}

async function pushStockUpdatesToShopee(
  updatedProducts: any[],
  requestedShopId?: string
): Promise<{ ok: boolean; errors: string[]; pushed: number }> {
  const shopeeRows = updatedProducts.filter((p) => p.shopeeItemId);
  if (shopeeRows.length === 0) {
    return { ok: true, errors: [], pushed: 0 };
  }

  const shopId = resolveShopeeTokenShopId(requestedShopId);
  if (!shopId) {
    return { ok: false, errors: ["Chưa có shop Shopee được ủy quyền."], pushed: 0 };
  }

  const accessToken = await getValidShopeeAccessToken(shopId);
  if (!accessToken) {
    return { ok: false, errors: [`Chưa có access_token hợp lệ cho shop_id=${shopId}.`], pushed: 0 };
  }

  const byItem = new Map<number, any[]>();
  for (const p of shopeeRows) {
    const itemId = Number(p.shopeeItemId);
    if (!Number.isFinite(itemId)) continue;
    if (!byItem.has(itemId)) byItem.set(itemId, []);
    byItem.get(itemId)!.push(p);
  }

  const errors: string[] = [];
  let pushed = 0;

  for (const [itemId, rows] of byItem) {
    const stockList = rows.map((p) => {
      const entry: { model_id?: number; seller_stock: { stock: number }[] } = {
        seller_stock: [{ stock: Math.max(0, Math.round(Number(p.stock) || 0)) }],
      };
      if (p.shopeeModelId) entry.model_id = Number(p.shopeeModelId);
      return entry;
    });

    const result = await shopeeUpdateStock(shopId, accessToken, itemId, stockList);
    const failures: any[] =
      result?.response?.failure_list ||
      result?.response?.stock_list?.filter?.((s: any) => s.failed_reason) ||
      [];

    if (result?.error) {
      const skus = rows.map((r) => r.sku).join(", ");
      errors.push(`item_id=${itemId} (SKU: ${skus}): ${result.error}${result.message ? ` — ${result.message}` : ""}`);
    }

    if (Array.isArray(failures) && failures.length > 0) {
      for (const f of failures) {
        if (f.failed_reason || f.error) {
          errors.push(`item_id=${itemId} model_id=${f.model_id ?? "?"}: ${f.failed_reason || f.error}`);
        }
      }
    }

    if (!result?.error && (!failures.length || failures.every((f: any) => !f.failed_reason && !f.error))) {
      pushed += rows.length;
    }

    await new Promise((r) => setTimeout(r, 120));
  }

  return { ok: errors.length === 0, errors, pushed };
}

function getItemAvatarUrl(item: any): string | undefined {
  const list = item?.image?.image_url_list;
  return Array.isArray(list) && list.length > 0 ? String(list[0]) : undefined;
}

function resolveShopeeTokenShopId(requested?: string): string | null {
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

function parseModelListFromResponse(modelResult: any): { tierVariations: any[]; models: any[] } {
  const resp = modelResult?.response || {};
  return {
    tierVariations: resp.tier_variation || resp.standardise_tier_variation || [],
    models: resp.model || resp.model_list || [],
  };
}

function getModelDisplayName(model: any, tierVariations: any[]): string {
  if (model?.model_name) return String(model.model_name).trim();
  const tierIndex: number[] = Array.isArray(model?.tier_index) ? model.tier_index : [];
  const parts: string[] = [];
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
  return model?.model_id != null ? `Phân loại #${model.model_id}` : "Phân loại";
}

function parseModelStock(model: any): number {
  const s2 = model?.stock_info_v2;
  if (s2?.seller_stock?.[0]?.stock != null) return Math.max(0, Number(s2.seller_stock[0].stock) || 0);
  if (s2?.summary_info?.total_available_stock != null) return Math.max(0, Number(s2.summary_info.total_available_stock) || 0);
  if (model?.stock != null) return Math.max(0, Number(model.stock) || 0);
  if (model?.normal_stock != null) return Math.max(0, Number(model.normal_stock) || 0);
  return Math.max(0, Number(model?.stock_info?.[0]?.current_stock) || 0);
}

function parseModelPrice(model: any): number {
  const pi = model?.price_info;
  if (Array.isArray(pi) && pi.length > 0) {
    return Math.max(0, Number(pi[0].current_price ?? pi[0].original_price) || 0);
  }
  if (pi && typeof pi === "object") {
    return Math.max(0, Number(pi.current_price ?? pi.original_price) || 0);
  }
  return Math.max(0, Number(model?.price) || 0);
}

function buildSingleWarehouseRow(item: any): any {
  const itemId = item.item_id;
  const avatarUrl = getItemAvatarUrl(item);
  const sku = String(item.item_sku || "").trim() || String(itemId);
  const stock = Number(item.stock_info_v2?.summary_info?.total_available_stock) || 0;
  const price = Number(item.price_info?.[0]?.current_price ?? item.price_info?.[0]?.original_price) || 0;

  return {
    id: `shopee-item-${itemId}`,
    title: item.item_name || `Sản phẩm Shopee ${itemId}`,
    sku,
    barcode: sku,
    category: item.category_id ? String(item.category_id) : "Chưa phân loại",
    stock,
    importPrice: 0,
    sellingPrice: price,
    channels: ["shopee"],
    imageUrl: avatarUrl,
    avatarUrl,
    description: item.description || "",
    status: item.item_status !== "NORMAL" ? "draft" : (stock > 0 ? "active" : "out_of_stock"),
    shopeeId: String(itemId),
    shopeeItemId: String(itemId),
    lastSynced: new Date().toISOString(),
  };
}

function getModelImageUrl(item: any, model: any, tierVariations: any[]): string {
  const tierIndex: number[] = Array.isArray(model?.tier_index) ? model.tier_index : [];
  for (let tierPos = 0; tierPos < tierIndex.length; tierPos++) {
    const optIdx = tierIndex[tierPos];
    const tier = tierVariations?.[tierPos];
    const opt = tier?.option_list?.[optIdx] || tier?.variation_option_list?.[optIdx];
    const url = opt?.image?.image_url || opt?.image_url;
    if (url) return url;
  }
  return getItemAvatarUrl(item);
}

function buildVariantWarehouseRow(item: any, model: any, tierVariations: any[], modelIndex: number): any {
  const itemId = item.item_id;
  const modelId = model.model_id != null ? model.model_id : `idx${modelIndex}`;
  const modelName = getModelDisplayName(model, tierVariations);
  const baseName = item.item_name || `Sản phẩm Shopee ${itemId}`;
  const avatarUrl = getModelImageUrl(item, model, tierVariations);
  const parentSku = String(item.item_sku || "").trim() || undefined;
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
    category: item.category_id ? String(item.category_id) : "Chưa phân loại",
    stock,
    importPrice: 0,
    sellingPrice: price,
    channels: ["shopee"],
    imageUrl: avatarUrl,
    avatarUrl,
    description: item.description || "",
    status: item.item_status !== "NORMAL" ? "draft" : (stock > 0 ? "active" : "out_of_stock"),
    shopeeId: `${itemId}:${modelId}`,
    shopeeItemId: String(itemId),
    shopeeModelId: String(modelId),
    tierLabels: model.tier_index?.map((optIdx: number, tierPos: number) =>
      tierVariations?.[tierPos]?.option_list?.[optIdx]?.option
    ).filter(Boolean),
    lastSynced: new Date().toISOString(),
  };
}

async function syncShopeeItemToWarehouseRows(
  shopId: string,
  accessToken: string,
  item: any,
  opts?: { strict?: boolean }
): Promise<{ rows: any[]; modelCount: number; error?: string }> {
  const inlineModels: any[] = Array.isArray(item?.model_list)
    ? item.model_list
    : Array.isArray(item?.model)
      ? item.model
      : [];
  const inlineTiers: any[] = item?.tier_variation || item?.standardise_tier_variation || [];

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

async function fetchAllShopeeItemIds(shopId: string, accessToken: string): Promise<number[]> {
  const allItemIds: number[] = [];
  let offset = 0;
  let hasNext = true;
  let pageGuard = 0;
  while (hasNext && pageGuard < 100) {
    const listResult = await shopeeGetItemList(shopId, accessToken, offset);
    if (listResult.error) throw new Error(`${listResult.error}: ${listResult.message || ""}`);
    const items = listResult.response?.item || [];
    allItemIds.push(...items.map((it: any) => it.item_id));
    hasNext = !!listResult.response?.has_next_page && items.length > 0;
    offset = listResult.response?.next_offset ?? offset + items.length;
    pageGuard++;
  }
  return allItemIds;
}

async function fetchShopeeBaseItemsByIds(shopId: string, accessToken: string, itemIds: number[]): Promise<any[]> {
  const allItems: any[] = [];
  for (let i = 0; i < itemIds.length; i += 50) {
    const batch = itemIds.slice(i, i + 50);
    const baseInfoResult = await shopeeGetItemBaseInfo(shopId, accessToken, batch);
    if (baseInfoResult.error) {
      console.error(`[Shopee Sync] get_item_base_info batch ${i}: ${baseInfoResult.error}`);
      continue;
    }
    allItems.push(...(baseInfoResult.response?.item_list || []));
  }
  return allItems;
}

async function runFullShopeeWarehouseSync(shopId: string, accessToken: string) {
  const itemIds = await fetchAllShopeeItemIds(shopId, accessToken);
  console.log(`[Shopee Product Sync] get_item_list: ${itemIds.length} item_id`);

  const allItems = await fetchShopeeBaseItemsByIds(shopId, accessToken, itemIds);
  console.log(`[Shopee Product Sync] get_item_base_info: ${allItems.length} item`);

  const products: any[] = [];
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
      variantItemCount: variantItems,
    },
  };
}

async function fetchShopeeItemVariants(
  shopId: string,
  accessToken: string,
  itemId: number
): Promise<{ item: any; variantProducts: any[]; error?: string; modelCount: number }> {
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

function mergeShopeeRowPreservingLocal(existing: any, incoming: any): any {
  if (!existing) return incoming;
  return {
    ...existing,
    ...incoming,
    importPrice: existing.importPrice ?? incoming.importPrice,
    wholesalePrice: existing.wholesalePrice ?? incoming.wholesalePrice,
    weight: existing.weight ?? incoming.weight,
    unit: existing.unit ?? incoming.unit,
    description: existing.description || incoming.description,
  };
}

function replaceProductsForShopeeItem(products: any[], itemId: string, variantProducts: any[]): any[] {
  const key = String(itemId);
  const byId = new Map(products.map((p: any) => [p.id, p]));
  const without = products.filter((p: any) => {
    const pItemId = p.shopeeItemId || String(p.id || "").match(/^shopee-item-(\d+)/)?.[1];
    return String(pItemId) !== key;
  });
  const mergedVariants = variantProducts.map((row) =>
    mergeShopeeRowPreservingLocal(byId.get(row.id), row)
  );
  return [...mergedVariants, ...without];
}

function dedupeShopeeParentVariantRows(products: any[]): any[] {
  const groups = new Map<string, any[]>();
  for (const p of products) {
    const itemId = p.shopeeItemId || String(p.id || "").match(/^shopee-item-(\d+)/)?.[1];
    if (!itemId) continue;
    if (!groups.has(itemId)) groups.set(itemId, []);
    groups.get(itemId)!.push(p);
  }
  const removeIds = new Set<string>();
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

// v2.logistics.get_shipping_parameter — tells us whether this order ships via
// "pickup" (Shopee courier picks up from seller's address), "dropoff" (seller
// drops the parcel at a branch) or "non_integrated" (3rd-party carrier, manual
// tracking number), plus the concrete address/time-slot/branch options.
async function shopeeGetShippingParameter(shopId: string, accessToken: string, orderSn: string, packageNumber?: string) {
  const apiPath = "/api/v2/logistics/get_shipping_parameter";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);

  const params = new URLSearchParams({
    partner_id: SHOPEE_PARTNER_ID,
    timestamp: String(timestamp),
    access_token: accessToken,
    shop_id: shopId,
    sign,
    order_sn: orderSn,
  });
  if (packageNumber) params.set("package_number", packageNumber);

  const url = `${SHOPEE_HOST}${apiPath}?${params.toString()}`;
  const res = await fetch(url);
  const json: any = await res.json();
  console.log(`[Shopee API] GET ${apiPath} (order_sn=${orderSn}) -> HTTP ${res.status}:`, JSON.stringify(json));
  return json;
}

// v2.logistics.ship_order — arranges the actual shipment (pickup/dropoff/non_integrated)
// so the order moves to "Chờ lấy hàng" (LOGISTICS_REQUEST_CREATED) on Shopee.
//
// IMPORTANT: `package_number` is INTENTIONALLY never accepted/sent by this
// function. Shopee hard-rejects ship_order with "Please don't request with
// package_number for this unsplit order" for the vast majority of normal
// (unsplit) orders, and there is no reliable local heuristic to prove an
// order is genuinely split. Per explicit product decision, this project only
// ships normal/unsplit orders — package_number must NEVER appear in this body.
async function shopeeShipOrder(shopId: string, accessToken: string, orderSn: string, shipmentBody: Record<string, any>) {
  const apiPath = "/api/v2/logistics/ship_order";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);
  const url = `${SHOPEE_HOST}${apiPath}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&access_token=${accessToken}&shop_id=${shopId}&sign=${sign}`;

  const body: Record<string, any> = { order_sn: orderSn, ...shipmentBody };
  delete body.package_number; // absolute guard — never send this key, no matter what shipmentBody contains

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json: any = await res.json();
  console.log(`[Shopee API] POST ${apiPath} (order_sn=${orderSn}) body=${JSON.stringify(body)} -> HTTP ${res.status}:`, JSON.stringify(json));
  return json;
}

type ShipMethod = "pickup" | "dropoff";

// Full "ship this order" flow for a REAL Shopee shop: call get_shipping_parameter
// to discover the concrete address/time-slot (pickup) or branch (dropoff) options,
// honor the method the seller explicitly picked in the "Xác nhận đơn hàng" modal,
// then call ship_order. Fails clearly if Shopee doesn't support the chosen method
// for this specific order's logistics channel (info_needed doesn't list it).
async function shipShopeeOrderReal(order: any, method: ShipMethod): Promise<{ success: boolean; error?: string; message?: string; mode?: string; shopId?: string }> {
  const shopId = resolveOrderShopId(order);
  if (!shopId) {
    return { success: false, error: "missing_shop_id", message: "Đơn hàng thiếu shop_id, không xác định được shop Shopee để gọi API." };
  }

  const accessToken = await getValidShopeeAccessToken(shopId);
  if (!accessToken) {
    return { success: false, error: "no_valid_access_token", message: `Chưa có access_token hợp lệ cho shop_id=${shopId}. Cần ủy quyền lại qua /api/shopee/callback.` };
  }

  // Deliberately called WITHOUT package_number — see shopeeShipOrder's comment.
  const paramResult = await shopeeGetShippingParameter(shopId, accessToken, order.orderSn);
  console.log(`D\u1EEE LI\u1EC6U SHOPEE TR\u1EA2 V\u1EC0 (get_shipping_parameter) - \u0111\u01A1n ${order.orderSn}:`, JSON.stringify(paramResult));
  if (paramResult.error) {
    console.error(`[Shopee L\u1ED6I] get_shipping_parameter th\u1EA5t b\u1EA1i cho \u0111\u01A1n ${order.orderSn} -> error="${paramResult.error}" message="${paramResult.message}"`);
    return { success: false, error: paramResult.error, message: paramResult.message };
  }

  const infoNeeded = paramResult.response?.info_needed || {};
  let shipmentBody: Record<string, any> = {};

  if (method === "dropoff") {
    if (!Object.prototype.hasOwnProperty.call(infoNeeded, "dropoff")) {
      console.error(`[Shopee L\u1ED6I] \u0110\u01A1n ${order.orderSn} kh\xF4ng h\u1ED7 tr\u1EE3 dropoff. info_needed=${JSON.stringify(infoNeeded)}`);
      return { success: false, error: "dropoff_not_supported", message: "Đơn vị vận chuyển của đơn này KHÔNG hỗ trợ hình thức \"Tự mang hàng ra bưu cục\". Vui lòng chọn \"Lấy hàng\" (pickup) thay thế." };
    }
    const branch = paramResult.response?.dropoff?.branch_list?.[0];
    shipmentBody = { dropoff: branch ? { branch_id: branch.branch_id } : {} };
  } else {
    if (!Object.prototype.hasOwnProperty.call(infoNeeded, "pickup")) {
      console.error(`[Shopee L\u1ED6I] \u0110\u01A1n ${order.orderSn} kh\xF4ng h\u1ED7 tr\u1EE3 pickup. info_needed=${JSON.stringify(infoNeeded)}`);
      return { success: false, error: "pickup_not_supported", message: "Đơn vị vận chuyển của đơn này KHÔNG hỗ trợ hình thức \"Lấy hàng\". Vui lòng chọn \"Tự mang hàng ra bưu cục\" (dropoff) thay thế." };
    }
    // Automatically pull the soonest available pickup_time_id, per Shopee's
    // get_shipping_parameter response — no manual slot-picking needed.
    const address = paramResult.response?.pickup?.address_list?.[0];
    const timeSlot = address?.time_slot_list?.[0];
    if (!address || !timeSlot) {
      console.error(`[Shopee L\u1ED6I] \u0110\u01A1n ${order.orderSn} kh\xF4ng c\xF3 address/time_slot pickup kh\u1EA3 d\u1EE5ng. pickup=${JSON.stringify(paramResult.response?.pickup)}`);
      return { success: false, error: "no_pickup_slot_available", message: "Shopee không trả về địa chỉ/lịch hẹn lấy hàng (pickup) khả dụng cho đơn này." };
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

// TikTok Shop / off-platform (manual) orders: no real Partner API is wired up
// in this project yet (only Shopee has a Live App configured in .env), so we
// apply the same pickup/dropoff decision locally and generate a tracking
// number consistent with the seller's choice, instead of silently no-oping.
function arrangeShipmentLocal(order: any, method: ShipMethod): { success: boolean; mode: string; trackingNumber: string } {
  const prefix = order.channel === "tiktok" ? "TTS" : "DIRECT";
  const trackingNumber = order.trackingNumber || `${prefix}-${method === "dropoff" ? "DROPOFF" : "PICKUP"}-${Math.floor(10000000 + Math.random() * 90000000)}`;
  return { success: true, mode: method, trackingNumber };
}

// Single entry point used by both the single-order and bulk ship routes.
async function arrangeShipment(order: any, method: ShipMethod): Promise<{ success: boolean; error?: string; message?: string; mode?: string; trackingNumber?: string; shopId?: string }> {
  if (order.channel === "shopee") {
    return shipShopeeOrderReal(order, method);
  }
  return arrangeShipmentLocal(order, method);
}

// Seller uses a regular A4/A5 office printer (thermal-label printing is OFF in
// Shopee Seller Centre) — NORMAL_AIR_WAYBILL renders the standard-size PDF
// label instead of the thermal-printer-sized THERMAL_AIR_WAYBILL. Single
// source of truth so create/poll/download always agree on the same type.
const SHOPEE_SHIPPING_DOCUMENT_TYPE = "NORMAL_AIR_WAYBILL";

// v2.logistics.get_tracking_number — for INTEGRATED channels, ship_order does
// not return the tracking_number synchronously (the 3PL assigns it a few
// seconds/minutes later). create_shipping_document REQUIRES a real
// tracking_number for these channels — omitting it is exactly what causes
// Shopee's "logistics.tracking_number_invalid" even for a perfectly valid,
// already-shipped order. This fetches the authoritative tracking_number.
async function shopeeGetTrackingNumber(shopId: string, accessToken: string, orderSn: string, packageNumber?: string) {
  const apiPath = "/api/v2/logistics/get_tracking_number";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);
  const params = new URLSearchParams({
    partner_id: SHOPEE_PARTNER_ID,
    timestamp: String(timestamp),
    access_token: accessToken,
    shop_id: shopId,
    sign,
    order_sn: orderSn,
  });
  if (packageNumber) params.set("package_number", packageNumber);

  const url = `${SHOPEE_HOST}${apiPath}?${params.toString()}`;
  const res = await fetch(url);
  const json: any = await res.json();
  console.log(`[Shopee API] GET ${apiPath} (order_sn=${orderSn}) -> HTTP ${res.status}:`, JSON.stringify(json));
  return json;
}

// v2.logistics.create_shipping_document — kicks off async AWB/label generation for up to 50 orders.
async function shopeeCreateShippingDocument(shopId: string, accessToken: string, orderList: { order_sn: string; package_number?: string; tracking_number?: string }[]) {
  const apiPath = "/api/v2/logistics/create_shipping_document";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);
  const url = `${SHOPEE_HOST}${apiPath}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&access_token=${accessToken}&shop_id=${shopId}&sign=${sign}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ order_list: orderList, shipping_document_type: SHOPEE_SHIPPING_DOCUMENT_TYPE }),
  });
  const json: any = await res.json();
  console.log(`[Shopee API] POST ${apiPath} (${orderList.length} orders) -> HTTP ${res.status}:`, JSON.stringify(json));
  return json;
}

// v2.logistics.get_shipping_document_result — poll until status is READY/FAILED.
async function shopeeGetShippingDocumentResult(shopId: string, accessToken: string, orderList: { order_sn: string; package_number?: string }[]) {
  const apiPath = "/api/v2/logistics/get_shipping_document_result";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);
  const url = `${SHOPEE_HOST}${apiPath}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&access_token=${accessToken}&shop_id=${shopId}&sign=${sign}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ order_list: orderList, shipping_document_type: SHOPEE_SHIPPING_DOCUMENT_TYPE }),
  });
  const json: any = await res.json();
  console.log(`[Shopee API] POST ${apiPath} -> HTTP ${res.status}:`, JSON.stringify(json));
  return json;
}

// v2.logistics.download_shipping_document — response body IS the raw file
// (PDF for most channels, sometimes ZIP/HTML). Returns the raw bytes + content-type,
// or throws/returns an error object if Shopee answered with a JSON error instead.
async function shopeeDownloadShippingDocument(shopId: string, accessToken: string, orderList: { order_sn: string; package_number?: string }[]) {
  const apiPath = "/api/v2/logistics/download_shipping_document";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);
  const url = `${SHOPEE_HOST}${apiPath}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&access_token=${accessToken}&shop_id=${shopId}&sign=${sign}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ order_list: orderList, shipping_document_type: SHOPEE_SHIPPING_DOCUMENT_TYPE }),
  });

  const contentType = res.headers.get("content-type") || "";
  console.log(`[Shopee API] POST ${apiPath} (${orderList.length} orders) -> HTTP ${res.status}, content-type=${contentType}`);

  if (contentType.includes("application/json")) {
    const json: any = await res.json();
    console.log(`[Shopee API] ${apiPath} tr\u1EA3 v\u1EC1 l\u1ED7i JSON (kh\xF4ng c\xF3 file):`, JSON.stringify(json));
    return { error: json.error || "download_failed", message: json.message || "Shopee kh\xF4ng tr\u1EA3 v\u1EC1 file v\u1EAD n \u0111\u01A1n." };
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, contentType: contentType || "application/pdf" };
}

// Normalize one line item from Shopee order item_list (includes variation/model fields).
function extractShopeeOrderModelName(it: any): string | undefined {
  const directCandidates = [
    it.model_name,
    it.variation_name,
    it.model_display_name,
    it.item_model_name,
    it.sku_model_name,
  ];
  for (const c of directCandidates) {
    const s = String(c || "").trim();
    if (s) return s;
  }

  const tierParts: string[] = [];
  const tierSources = [
    it.model_tier_variation,
    it.tier_variation,
    it.standardise_tier_variation,
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
    const parts = it.variation_list
      .map((v: any) => String(v?.variation_name || v?.option || v?.name || "").trim())
      .filter(Boolean);
    if (parts.length > 0) return parts.join(" / ");
  }

  return undefined;
}

function extractShopeeOrderModelId(it: any): string {
  const candidates = [it.model_id, it.variation_id, it.modelId, it.variationId];
  for (const raw of candidates) {
    if (raw != null && raw !== "" && Number(raw) !== 0) {
      return String(raw);
    }
  }
  return "0";
}

function extractShopeeOrderModelSku(it: any): string | undefined {
  const candidates = [
    it.model_sku,
    it.variation_sku,
    it.item_sku,
    it.sku,
    it.modelSku,
    it.variationSku,
  ];
  for (const raw of candidates) {
    const s = String(raw || "").trim();
    if (s) return s;
  }
  return undefined;
}

function mapShopeeOrderLineItem(it: any) {
  const itemId = String(it.item_id || "");
  const modelId = extractShopeeOrderModelId(it);
  const modelSku = extractShopeeOrderModelSku(it);
  const modelName = extractShopeeOrderModelName(it);
  const itemName = String(it.item_name || "S\u1EA3n ph\u1EA9m Shopee").trim();
  const productTitle = modelName ? `${itemName} - ${modelName}` : itemName;
  const productImage =
    it.image_info?.image_url ||
    it.image_url ||
    it.variation_image_url ||
    undefined;

  return {
    productId: itemId,
    productTitle,
    productImage,
    quantity: Number(it.model_quantity_purchased || it.model_quantity || it.quantity || 1),
    price: Number(it.model_discounted_price || it.model_original_price || it.item_price || 0),
    modelId: modelId === "0" ? undefined : modelId,
    modelSku,
    modelName,
  };
}

// Normalize one item from get_order_detail's `order_list` into this project's Order shape.
function normalizeShopeeOrderDetail(shopId: string, shopName: string, item: any): any {
  const statusMap: Record<string, string> = {
    UNPAID: "pending_confirm",
    READY_TO_SHIP: "unprocessed",
    PROCESSED: "processed",
    SHIPPED: "shipping",
    TO_CONFIRM_RECEIVE: "shipping",
    IN_CANCEL: "cancelled",
    CANCELLED: "cancelled",
    TO_RETURN: "return_pending",
    COMPLETED: "completed",
  };
  const rawStatus = String(item.order_status || "READY_TO_SHIP").toUpperCase();

  return {
    id: `shopee-${item.order_sn}`,
    orderSn: String(item.order_sn),
    channel: "shopee",
    shopId: String(shopId),
    shopName: shopName || "Shopee Shop",
    customerName: item.recipient_address?.name || item.buyer_username || "Kh\xE1ch Shopee",
    customerPhone: item.recipient_address?.phone || undefined,
    customerAddress: item.recipient_address?.full_address || undefined,
    totalAmount: Number(item.total_amount || 0),
    revenue: Number(item.total_amount || 0) * 0.88,
    status: statusMap[rawStatus] || "unprocessed",
    date: item.create_time ? new Date(item.create_time * 1000).toISOString() : new Date().toISOString(),
    trackingNumber: item.package_list?.[0]?.tracking_number || undefined,
    // NOTE: package_number is captured here for EVERY shipped order (not just
    // split ones) because create_shipping_document/get_shipping_document_result/
    // download_shipping_document actually need the real package_number to match
    // up the print task correctly — omitting it is what causes Shopee's
    // "logistics.shipping_document_should_print_first" error even after create
    // succeeded and status is READY. ship_order is the ONLY call that must never
    // receive package_number for a normal/unsplit order — that is enforced with
    // its own absolute guard inside shopeeShipOrder(), independent of this field.
    packageNumber: item.package_list?.[0]?.package_number || undefined,
    isPrepared: rawStatus === "PROCESSED" || rawStatus === "SHIPPED" || rawStatus === "TO_CONFIRM_RECEIVE",
    isPrinted: false,
    items: Array.isArray(item.item_list)
      ? item.item_list.map((it: any) => mapShopeeOrderLineItem(it))
      : [],
  };
}

// Upsert one Shopee order from get_order_detail — trust Shopee status for tab
// placement while preserving local print flags and non-empty item snapshots.
function orderItemsHaveVariationData(items: any[] | undefined): boolean {
  return Array.isArray(items) && items.some((i) => i?.modelId || i?.modelName || i?.modelSku);
}

function mergeShopeeOrderOnSync(existing: any | undefined, incoming: any): any {
  if (!existing) return incoming;

  const merged = { ...existing, ...incoming, id: existing.id };
  merged.status = incoming.status;
  merged.isPrepared = incoming.status === "processed" || incoming.status === "shipping";
  merged.isPrinted = Boolean(existing.isPrinted);

  const incomingItems = Array.isArray(incoming.items) ? incoming.items : [];
  const existingItems = Array.isArray(existing.items) ? existing.items : [];
  if (incomingItems.length > 0) {
    if (
      orderItemsHaveVariationData(incomingItems) ||
      !existingItems.length ||
      !orderItemsHaveVariationData(existingItems)
    ) {
      merged.items = incomingItems;
    } else {
      merged.items = existingItems;
    }
  } else if (existingItems.length) {
    merged.items = existingItems;
  }
  if (!incoming.trackingNumber && existing.trackingNumber) {
    merged.trackingNumber = existing.trackingNumber;
  }
  if (!incoming.packageNumber && existing.packageNumber) {
    merged.packageNumber = existing.packageNumber;
  }
  if (!incoming.shopId && existing.shopId) {
    merged.shopId = existing.shopId;
  }
  return merged;
}

// TO_CONFIRM_RECEIVE is returned inside SHIPPED pages — not a valid order_status filter.
const SHOPEE_SYNC_STATUSES = ["READY_TO_SHIP", "PROCESSED", "SHIPPED"] as const;

const SHOPEE_SYNC_UI_STATUSES = new Set(["pending_confirm", "unprocessed", "processed", "shipping"]);

// Pull orders from every connected Shopee shop for the given statuses (15-day
// window, full cursor pagination), fetch get_order_detail in batches of 50,
// upsert into the local orders database with real Shopee status → UI tab mapping.
async function syncShopeeOrdersFromApi(statuses: string[] = [...SHOPEE_SYNC_STATUSES]) {
  const tokens = loadShopeeTokens();
  const shopIds = Object.keys(tokens);
  let orders = loadOrders();
  let syncedCount = 0;
  let addedCount = 0;
  let updatedCount = 0;
  const errors: any[] = [];
  const statusCounts: Record<string, number> = {};

  for (const shopId of shopIds) {
    try {
      const accessToken = await getValidShopeeAccessToken(shopId);
      if (!accessToken) {
        errors.push({ shopId, error: "no_valid_access_token" });
        continue;
      }

      const orderSnSet = new Set<string>();
      for (const status of statuses) {
        try {
          const sns = await shopeeFetchAllOrderSnsByStatus(shopId, accessToken, status);
          sns.forEach((sn) => orderSnSet.add(sn));
          statusCounts[`${shopId}:${status}`] = sns.length;
          console.log(`[Shopee Sync] Shop ${shopId} / ${status}: ${sns.length} đơn (15 ngày, đã lật trang).`);
        } catch (statusErr: any) {
          console.error(`[Shopee Sync] Shop ${shopId} / ${status} lỗi (bỏ qua, tiếp tục status khác):`, statusErr?.message || statusErr);
          errors.push({ shopId, status, error: statusErr?.message || String(statusErr) });
        }
      }

      const orderSnList = Array.from(orderSnSet);
      if (orderSnList.length === 0) continue;

      const syncedForShop: any[] = [];
      for (let i = 0; i < orderSnList.length; i += 50) {
        const batch = orderSnList.slice(i, i + 50);
        const detailResult = await shopeeGetOrderDetail(shopId, accessToken, batch);
        if (detailResult.error) {
          errors.push({ shopId, error: detailResult.error, message: detailResult.message, batch: batch.length });
          continue;
        }

        const detailList = detailResult.response?.order_list || [];
        for (const detail of detailList) {
          syncedForShop.push(normalizeShopeeOrderDetail(shopId, detail.shop_name, detail));
        }
      }

      const syncedSnSet = new Set(syncedForShop.map((o) => o.orderSn));
      // Drop stale Shopee active-tab rows for this shop that Shopee no longer returns.
      orders = orders.filter((o: any) => {
        if (o.channel !== "shopee" || String(o.shopId) !== String(shopId)) return true;
        if (syncedSnSet.has(o.orderSn)) return false;
        if (!SHOPEE_SYNC_UI_STATUSES.has(o.status)) return true;
        return false;
      });

      for (const normalized of syncedForShop) {
        const existingIndex = orders.findIndex((o: any) => o.orderSn === normalized.orderSn);
        if (existingIndex >= 0) {
          orders[existingIndex] = mergeShopeeOrderOnSync(orders[existingIndex], normalized);
          updatedCount++;
        } else {
          orders.unshift(normalized);
          addedCount++;
        }
        syncedCount++;
      }
    } catch (error: any) {
      console.error(`[Shopee Sync] Lỗi shop_id=${shopId}:`, error);
      errors.push({ shopId, error: error.message || "unknown_error" });
    }
  }

  const products = loadProducts();
  orders = enrichOrdersFromCatalog(orders, products);
  saveOrders(orders);
  const validOrders = orders.filter(isValidOrder);
  const uiStatusCounts = {
    unprocessed: validOrders.filter((o: any) => o.status === "unprocessed").length,
    processed: validOrders.filter((o: any) => o.status === "processed").length,
    shipping: validOrders.filter((o: any) => o.status === "shipping").length,
    pending_confirm: validOrders.filter((o: any) => o.status === "pending_confirm").length,
  };
  console.log(`[Shopee Sync] UI counts sau đồng bộ:`, JSON.stringify(uiStatusCounts));

  return {
    synced: syncedCount,
    added: addedCount,
    updated: updatedCount,
    orders: validOrders,
    statusCounts,
    uiStatusCounts,
    errors: errors.length ? errors : undefined,
  };
}
const ORDERS_DB_PATH = path.join(process.cwd(), "data", "orders.json");

// Local JSON-file "database" holding orders synced in from real marketplace webhooks (Shopee, ...).

function loadOrders(): any[] {
  try {
    if (!fs.existsSync(ORDERS_DB_PATH)) return [];
    const raw = fs.readFileSync(ORDERS_DB_PATH, "utf-8");
    return raw.trim() ? JSON.parse(raw) : [];
  } catch (error) {
    console.error("[Orders DB] Failed to read orders.json:", error);
    return [];
  }
}

function saveOrders(orders: any[]): void {
  try {
    fs.mkdirSync(path.dirname(ORDERS_DB_PATH), { recursive: true });
    fs.writeFileSync(ORDERS_DB_PATH, JSON.stringify(orders, null, 2), "utf-8");
  } catch (error) {
    console.error("[Orders DB] Failed to write orders.json:", error);
  }
}

function toDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseDashboardOrderDate(dateStr: string): Date {
  const raw = String(dateStr || "").trim();
  if (!raw) return new Date(NaN);
  const datePart = raw.split("T")[0];
  const [y, m, d] = datePart.split("-").map(Number);
  if (!y || !m || !d) return new Date(NaN);
  return new Date(y, m - 1, d);
}

function isDashboardOrder(order: any): boolean {
  const sn = String(order?.orderSn || order?.id || "");
  if (!sn) return false;
  const hasAmount = Number(order?.totalAmount) > 0;
  const hasItems = Array.isArray(order?.items) && order.items.length > 0;
  if (!hasAmount && !hasItems && sn.startsWith("260709")) return false;
  return true;
}

function getDashboardDateRange(rangeKey: string) {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);

  switch (rangeKey) {
    case "this_month":
      return { start: new Date(y, m, 1), end, key: "this_month", label: "Tháng này" };
    case "last_month":
      return {
        start: new Date(y, m - 1, 1),
        end: new Date(y, m, 0, 23, 59, 59, 999),
        key: "last_month",
        label: "Tháng trước",
      };
    case "this_quarter": {
      const qStart = Math.floor(m / 3) * 3;
      return { start: new Date(y, qStart, 1), end, key: "this_quarter", label: "Quý này" };
    }
    case "this_year":
      return { start: new Date(y, 0, 1), end, key: "this_year", label: "Năm nay" };
    case "today": {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      return { start, end, key: "today", label: "Hôm nay" };
    }
    case "last_7_days":
    default: {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      start.setDate(start.getDate() - 6);
      return { start, end, key: "last_7_days", label: "7 ngày qua" };
    }
  }
}

function isDateInRange(dateStr: string, start: Date, end: Date): boolean {
  const d = parseDashboardOrderDate(dateStr);
  if (Number.isNaN(d.getTime())) return false;
  const s = new Date(start);
  s.setHours(0, 0, 0, 0);
  const e = new Date(end);
  e.setHours(23, 59, 59, 999);
  return d >= s && d <= e;
}

function findOrderItemMeta(orders: any[], productId: string): { title: string | null; image: string | null } {
  for (const order of orders) {
    const items = Array.isArray(order?.items) ? order.items : [];
    const hit = items.find((i: any) => String(i.productId) === productId);
    if (hit) {
      return {
        title: hit.productTitle ? String(hit.productTitle) : null,
        image: hit.productImage ? String(hit.productImage) : null,
      };
    }
  }
  return { title: null, image: null };
}

function buildDashboardChart(orders: any[], range: { start: Date; end: Date; key: string }) {
  const buckets = new Map<string, { key: string; label: string; amount: number }>();

  if (range.key === "this_year" || range.key === "this_quarter") {
    const cursor = new Date(range.start.getFullYear(), range.start.getMonth(), 1);
    const endMonth = new Date(range.end.getFullYear(), range.end.getMonth(), 1);
    while (cursor <= endMonth) {
      const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`;
      buckets.set(key, {
        key,
        label: `T${cursor.getMonth() + 1}`,
        amount: 0,
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
        amount: 0,
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

const PRODUCTS_DB_PATH = path.join(process.cwd(), "data", "products.json");

function loadProducts(): any[] {
  try {
    if (!fs.existsSync(PRODUCTS_DB_PATH)) return [];
    const raw = fs.readFileSync(PRODUCTS_DB_PATH, "utf-8");
    return raw.trim() ? JSON.parse(raw) : [];
  } catch (error) {
    console.error("[Products DB] Failed to read products.json:", error);
    return [];
  }
}

function saveProducts(products: any[]): void {
  try {
    fs.mkdirSync(path.dirname(PRODUCTS_DB_PATH), { recursive: true });
    fs.writeFileSync(PRODUCTS_DB_PATH, JSON.stringify(products, null, 2), "utf-8");
  } catch (error) {
    console.error("[Products DB] Failed to write products.json:", error);
  }
}

const SUPPLIERS_DB_PATH = path.join(process.cwd(), "data", "suppliers.json");

function normalizeSupplier(raw: any): any {
  const totalOrderValue = Number(raw?.totalOrderValue) || 0;
  const totalPaid = Number(raw?.totalPaid) || 0;
  return {
    id: String(raw?.id || `sup-${Date.now()}`),
    name: String(raw?.name || "").trim(),
    supplierCode: String(raw?.supplierCode || raw?.supplier_code || "").trim().toUpperCase(),
    totalOrderValue,
    totalPaid,
    totalDebt: Number(raw?.totalDebt ?? totalOrderValue - totalPaid) || 0,
    status: raw?.status === "inactive" ? "inactive" : "active",
  };
}

function loadSuppliers(): any[] {
  try {
    if (!fs.existsSync(SUPPLIERS_DB_PATH)) return [];
    const raw = fs.readFileSync(SUPPLIERS_DB_PATH, "utf-8");
    const parsed = raw.trim() ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.map(normalizeSupplier) : [];
  } catch (error) {
    console.error("[Suppliers DB] Failed to read suppliers.json:", error);
    return [];
  }
}

function saveSuppliers(suppliers: any[]): void {
  try {
    fs.mkdirSync(path.dirname(SUPPLIERS_DB_PATH), { recursive: true });
    fs.writeFileSync(SUPPLIERS_DB_PATH, JSON.stringify(suppliers, null, 2), "utf-8");
  } catch (error) {
    console.error("[Suppliers DB] Failed to write suppliers.json:", error);
  }
}

const IMPORTS_DB_PATH = path.join(process.cwd(), "data", "imports.json");

function loadImports(): any[] {
  try {
    if (!fs.existsSync(IMPORTS_DB_PATH)) return [];
    const raw = fs.readFileSync(IMPORTS_DB_PATH, "utf-8");
    const parsed = raw.trim() ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error("[Imports DB] Failed to read imports.json:", error);
    return [];
  }
}

function saveImports(imports: any[]): void {
  try {
    fs.mkdirSync(path.dirname(IMPORTS_DB_PATH), { recursive: true });
    fs.writeFileSync(IMPORTS_DB_PATH, JSON.stringify(imports, null, 2), "utf-8");
  } catch (error) {
    console.error("[Imports DB] Failed to write imports.json:", error);
  }
}

const EXPENSES_DB_PATH = path.join(process.cwd(), "data", "expenses.json");
const EXPENSES_CLEAR_MARKER = path.join(process.cwd(), "data", ".expenses-cleared-v2");

function loadExpenses(): any[] {
  try {
    if (!fs.existsSync(EXPENSES_DB_PATH)) return [];
    const raw = fs.readFileSync(EXPENSES_DB_PATH, "utf-8");
    const parsed = raw.trim() ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error("[Expenses DB] Failed to read expenses.json:", error);
    return [];
  }
}

function saveExpenses(expenses: any[]): void {
  try {
    fs.mkdirSync(path.dirname(EXPENSES_DB_PATH), { recursive: true });
    fs.writeFileSync(EXPENSES_DB_PATH, JSON.stringify(expenses, null, 2), "utf-8");
  } catch (error) {
    console.error("[Expenses DB] Failed to write expenses.json:", error);
  }
}

function migrateExpensesStorageOnce(): void {
  if (fs.existsSync(EXPENSES_CLEAR_MARKER)) return;
  saveExpenses([]);
  try {
    fs.mkdirSync(path.dirname(EXPENSES_CLEAR_MARKER), { recursive: true });
    fs.writeFileSync(EXPENSES_CLEAR_MARKER, new Date().toISOString(), "utf-8");
    console.log("[Expenses] Đã xóa sạch dữ liệu chi phí cũ (migration một lần).");
  } catch (error) {
    console.error("[Expenses] Failed to write clear marker:", error);
  }
}

migrateExpensesStorageOnce();

function applyBulkProductUpdate(
  product: any,
  opts: { stock?: { mode: string; value: number }; price?: { mode: string; value: number } }
): any {
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
    lastSynced: new Date().toISOString(),
  };
}

function mergeProductPatch(product: any, patch: any): any {
  const merged = { ...product };
  if (patch.title !== undefined) merged.title = String(patch.title);
  if (patch.sku !== undefined) merged.sku = String(patch.sku);
  if (patch.stock !== undefined) merged.stock = Math.max(0, Math.round(Number(patch.stock)));
  if (patch.sellingPrice !== undefined) merged.sellingPrice = Math.max(0, Math.round(Number(patch.sellingPrice)));
  if (patch.wholesalePrice !== undefined) merged.wholesalePrice = Math.max(0, Math.round(Number(patch.wholesalePrice)));
  if (patch.importPrice !== undefined) merged.importPrice = Math.max(0, Math.round(Number(patch.importPrice)));
  if (patch.weight !== undefined) merged.weight = Math.max(0, Number(patch.weight));
  if (patch.brand !== undefined) merged.brand = String(patch.brand);
  if (patch.supplierId !== undefined) merged.supplierId = patch.supplierId ? String(patch.supplierId) : undefined;
  if (patch.barcode !== undefined) merged.barcode = String(patch.barcode);
  if (patch.stockMin !== undefined) merged.stockMin = Math.max(0, Math.round(Number(patch.stockMin)));
  if (patch.stockMax !== undefined) merged.stockMax = Math.max(0, Math.round(Number(patch.stockMax)));
  if (patch.description !== undefined) merged.description = String(patch.description);
  if (patch.category !== undefined) merged.category = String(patch.category);
  if (patch.unit !== undefined) merged.unit = String(patch.unit).trim();
  if (patch.status !== undefined) merged.status = patch.status;
  if (merged.stock <= 0 && merged.status !== "draft") merged.status = "out_of_stock";
  else if (merged.stock > 0 && merged.status === "out_of_stock") merged.status = "active";
  merged.lastSynced = new Date().toISOString();
  return merged;
}

// Some orders inserted purely from an older buggy webhook normalization never
// got a shop_id recorded (see normalizeShopeeOrder fix above). Self-heal them
// on read: if the order itself lacks shop_id but exactly one Shopee shop is
// connected in this project, that's unambiguously the right shop — use it
// instead of letting a missing field wrongly block real ship_order/print calls.
function resolveOrderShopId(order: any): string | undefined {
  if (order?.shopId) return String(order.shopId);
  if (order?.channel !== "shopee") return undefined;
  const shopIds = Object.keys(loadShopeeTokens());
  return shopIds.length === 1 ? shopIds[0] : undefined;
}

// Resolve an order row by internal id OR Shopee order_sn (bulk UI may send either).
function findOrderRecord(orders: any[], idOrSn: string): { index: number; order: any } | null {
  const key = String(idOrSn || "").trim();
  if (!key) return null;
  let index = orders.findIndex((o: any) => o.id === key || o.orderSn === key);
  if (index === -1 && !key.startsWith("shopee-")) {
    index = orders.findIndex((o: any) => o.id === `shopee-${key}`);
  }
  if (index === -1) return null;
  return { index, order: orders[index] };
}

// Build a de-duplicated list of orders to ship from orderIds and/or orderSns arrays.
function resolveOrdersFromRequest(orders: any[], orderIds?: string[], orderSns?: string[]): { index: number; order: any }[] {
  const hits: { index: number; order: any }[] = [];
  const seen = new Set<number>();
  const tryAdd = (idOrSn: string) => {
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

// Shopee sometimes returns an "already shipped" style error when ship_order is
// retried on an order that was actually prepared earlier — treat as success so
// bulk runs don't report 0/N for orders that are already on Shopee's side.
function isAlreadyShippedError(result: any): boolean {
  const blob = `${result?.error || ""} ${result?.message || ""}`.toLowerCase();
  return blob.includes("already") || blob.includes("has been shipped") || blob.includes("logistics order is completed");
}

// Broken/mock orders (0đ total AND no items) or ghost webhook rows with no
// real product snapshot — leftovers from older test/config attempts.
function isValidOrder(order: any): boolean {
  const hasAmount = Number(order?.totalAmount) > 0;
  const hasItems = Array.isArray(order?.items) && order.items.length > 0;
  if (!hasAmount && !hasItems) return false;
  const sn = String(order?.orderSn || "");
  if (sn.startsWith("260709") && !hasItems && Number(order?.totalAmount) === 0) return false;
  return true;
}

// Normalize a raw Shopee push-notification payload into this project's Order shape.
// IMPORTANT: Shopee's push envelope is { shop_id, code, timestamp, data: {...} } —
// `shop_id` lives at the TOP LEVEL, sibling to `data`, never inside `data` itself.
// Reading `data.shop_id` (the inner object) always returns undefined and was the
// root cause of orders silently losing their shop_id in the local database.
function normalizeShopeeOrder(payload: any): any | null {
  const data = payload?.data || payload || {};
  const orderSn = data.ordersn || data.order_sn || data.orderSn;
  if (!orderSn) return null;
  const shopId = payload?.shop_id ?? data.shop_id;

  const statusMap: Record<string, string> = {
    UNPAID: "pending_confirm",
    READY_TO_SHIP: "unprocessed",
    PROCESSED: "processed",
    SHIPPED: "shipping",
    TO_CONFIRM_RECEIVE: "shipping",
    IN_CANCEL: "cancelled",
    CANCELLED: "cancelled",
    TO_RETURN: "return_pending",
    COMPLETED: "completed",
  };

  const rawStatus = String(data.status || data.order_status || "READY_TO_SHIP").toUpperCase();

  return {
    id: `shopee-${orderSn}`,
    orderSn: String(orderSn),
    channel: "shopee",
    shopId: shopId ? String(shopId) : undefined,
    shopName: data.shop_name || "Shopee Shop",
    customerName: data.buyer_username || data.recipient_address?.name || "Khách Shopee",
    customerPhone: data.recipient_address?.phone || undefined,
    customerAddress: data.recipient_address?.full_address || undefined,
    totalAmount: Number(data.total_amount || 0),
    revenue: Number(data.total_amount || 0) * 0.88,
    status: statusMap[rawStatus] || "unprocessed",
    date: data.create_time ? new Date(data.create_time * 1000).toISOString() : new Date().toISOString(),
    // Shopee's push envelope uses "tracking_no" (NOT "tracking_number" like the
    // REST APIs) for the tracking-number-assigned webhook event — check both.
    trackingNumber: data.tracking_no || data.tracking_number || undefined,
    // Capture package_number from the webhook event too (e.g. the code=4
    // "tracking assigned" push) — needed by create_shipping_document /
    // get_shipping_document_result / download_shipping_document, which
    // otherwise fail with "logistics.shipping_document_should_print_first".
    // Safe to capture unconditionally: ship_order (the ONLY call that must
    // never receive package_number for a normal/unsplit order) has its own
    // absolute guard inside shopeeShipOrder(), independent of this field.
    packageNumber: data.package_number || undefined,
    isPrepared: false,
    isPrinted: false,
    items: Array.isArray(data.item_list)
      ? data.item_list.map((it: any) => mapShopeeOrderLineItem(it))
      : [],
  };
}

function processShopeeWebhookPayload(body: any): void {
  try {
    const normalized = normalizeShopeeOrder(body);
    if (!normalized) return;

    const orders = loadOrders();
    const existingIndex = orders.findIndex((o: any) => o.orderSn === normalized.orderSn);
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
      if (!normalized.trackingNumber) {
        merged.trackingNumber = orders[existingIndex].trackingNumber;
      }
      if (!normalized.packageNumber) {
        merged.packageNumber = orders[existingIndex].packageNumber;
      }
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

const authMiddleware = (req: any, res: any, next: any) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Y\xEAu c\u1EA7u cung c\u1EA5p Token x\xE1c th\u1EF1c h\u1EE3p l\u1EC7." });
  }
  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: "Token kh\xF4ng h\u1EE3p l\u1EC7 ho\u1EB7c \u0111\xE3 h\u1EBFt h\u1EA1n." });
  }
};

async function startServer() {
  const app = express();
  const PORT = process.env.PORT || 3000;

  app.use((req, res, next) => {
    const origin = req.headers.origin as string | undefined;
    const allowedOrigin =
      origin &&
      (/^https:\/\/([a-z0-9-]+\.)*vercel\.app$/i.test(origin) ||
        /^https:\/\/([a-z0-9-]+\.)*linhkienamthanh\.net$/i.test(origin) ||
        /^http:\/\/localhost(:\d+)?$/i.test(origin));
    if (allowedOrigin) {
      res.setHeader('Access-Control-Allow-Origin', origin!);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }
    next();
  });

  app.use(express.json());

  app.post("/api/login", (req, res) => {
    const { username, password } = req.body;
    const expectedUsername = process.env.ADMIN_USERNAME || "admin";
    const expectedPassword = process.env.ADMIN_PASSWORD || "password123";
    if (username === expectedUsername && password === expectedPassword) {
      const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: "24h" });
      return res.json({ token, username });
    } else {
      return res.status(401).json({ error: "T\xEAn \u0111\u0103ng nh\u1EADp ho\u1EB7c m\u1EADt kh\u1EA9u kh\xF4ng ch\xEDnh x\xE1c." });
    }
  });

  app.get("/api/auth/verify", authMiddleware, (req: any, res) => {
    res.json({ valid: true, username: req.user.username });
  });

  app.get("/api/config/public", (_req, res) => {
    res.json({
      appUrl: APP_BASE_URL,
      apiBaseUrl: APP_BASE_URL,
      shopeeCallbackUrl: SHOPEE_CALLBACK_URL,
      shopeeWebhookUrl: SHOPEE_WEBHOOK_URL,
    });
  });

  // Shopee Open Platform OAuth redirect callback.
  // Register in Shopee Partner App Settings: SHOPEE_CALLBACK_URL
  app.get("/api/shopee/callback", async (req, res) => {
    const { code, shop_id } = req.query;
    console.log(`[Shopee OAuth] Callback received. code=${code || "N/A"} shop_id=${shop_id || "N/A"} env=${SHOPEE_ENV}`);

    if (!code || !shop_id) {
      return res.status(400).send("Thi\u1EBFu tham s\u1ED1 code ho\u1EB7c shop_id t\u1EEB Shopee callback.");
    }

    try {
      const tokenResult = await exchangeShopeeCodeForToken(String(code), String(shop_id));
      if (!tokenResult.access_token) {
        console.error(`[Shopee OAuth] \u0110\u1ED5i code th\u1EA5t b\u1EA1i cho shop_id=${shop_id}:`, tokenResult.error, tokenResult.message);
        return res.redirect("/?shopee_linked=0&error=" + encodeURIComponent(tokenResult.error || "token_exchange_failed"));
      }
      console.log(`[Shopee OAuth] Shop ${shop_id} li\xEAn k\u1EBFt th\xE0nh c\xF4ng, access_token h\u1EBFt h\u1EA1n sau ${tokenResult.expire_in}s.`);
      return res.redirect("/?shopee_linked=1&shop_id=" + shop_id);
    } catch (error: any) {
      console.error("[Shopee OAuth] Exchange token error:", error);
      return res.redirect("/?shopee_linked=0&error=" + encodeURIComponent(error.message || "unknown_error"));
    }
  });

  // Shopee webhook — trả 200 OK ngay (<3s), xử lý dữ liệu nặng ở background.
  app.post("/api/shopee/webhook", (req, res) => {
    res.status(200).json({ received: true });
    const payload = req.body;
    setImmediate(() => {
      console.log("[Shopee Webhook] Payload received:", JSON.stringify(payload));
      processShopeeWebhookPayload(payload);
    });
  });

  // Real synced orders list — this is what the Order Management UI reads from.
  // --- Products warehouse API (data/products.json) ---
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
      category: body.category || "Chưa phân loại",
      description: body.description || "",
      imageUrl: body.imageUrl || undefined,
      status: body.status || "active",
      shopeeId: body.shopeeId,
      tiktokId: body.tiktokId,
      wooId: body.wooId,
      lastSynced: new Date().toISOString(),
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
    const index = products.findIndex((p: any) => p.id === req.params.id);
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
        return res.status(400).json({ success: false, message: "Chưa có dòng tồn kho nào để cân bằng." });
      }

      const skuStockMap = new Map<string, number>();
      for (const item of items) {
        const sku = String(item?.sku || "").trim();
        if (!sku) continue;
        const actual = Math.max(0, Math.round(Number(item.actual_stock)));
        if (!Number.isFinite(actual)) continue;
        skuStockMap.set(sku, actual);
      }

      if (skuStockMap.size === 0) {
        return res.status(400).json({ success: false, message: "Dữ liệu cân bằng kho không hợp lệ." });
      }

      const products = loadProducts();
      let updatedCount = 0;
      const next = products.map((p: any) => {
        const sku = String(p.sku || "").trim();
        if (!skuStockMap.has(sku)) return p;
        updatedCount++;
        return mergeProductPatch(p, { stock: skuStockMap.get(sku) });
      });

      if (updatedCount === 0) {
        return res.status(404).json({ success: false, message: "Không tìm thấy SKU nào trong kho gốc để cập nhật." });
      }

      const updatedProducts = next.filter((p: any) => skuStockMap.has(String(p.sku || "").trim()));

      const unlinkedShopee = updatedProducts.filter(
        (p: any) => p.channels?.includes("shopee") && !p.shopeeItemId
      );
      if (unlinkedShopee.length > 0) {
        return res.status(400).json({
          success: false,
          message: `SKU chưa liên kết Shopee (thiếu item_id): ${unlinkedShopee.map((p: any) => p.sku).join(", ")}`,
        });
      }

      saveProducts(next);
      console.log(`[Inventory Balance] Cập nhật kho gốc ${updatedCount} SKU`);

      const shopeeResult = await pushStockUpdatesToShopee(updatedProducts, req.body?.shopId);
      if (!shopeeResult.ok) {
        return res.status(400).json({
          success: false,
          message: `Kho gốc đã cập nhật. Đẩy Shopee thất bại: ${shopeeResult.errors.join(" | ")}`,
          shopeeErrors: shopeeResult.errors,
        });
      }

      const msg =
        shopeeResult.pushed > 0
          ? `Cân bằng kho thành công (${shopeeResult.pushed} SKU đã đồng bộ lên Shopee).`
          : "Cân bằng kho thành công";
      console.log(`[Inventory Balance] ${msg}`);
      return res.status(200).json({ success: true, message: msg });
    } catch (err: any) {
      console.error("[Inventory Balance] Exception:", err);
      return res.status(500).json({ success: false, message: err?.message || "Lỗi server khi cân bằng kho." });
    }
  });

  app.post("/api/products/bulk-save", authMiddleware, (req, res) => {
    const updates = req.body?.updates;
    if (!Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({ error: "updates_required" });
    }
    const patchMap = new Map<string, any>();
    for (const u of updates) {
      if (u?.id) patchMap.set(String(u.id), u);
    }
    const products = loadProducts();
    let updatedCount = 0;
    const next = products.map((p: any) => {
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
    const next = products.filter((p: any) => p.id !== req.params.id);
    if (next.length === products.length) {
      return res.status(404).json({ error: "product_not_found" });
    }
    saveProducts(next);
    return res.json({ deleted: req.params.id });
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
    const next = products.map((p: any) => {
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

      const channelList: string[] = Array.isArray(channels) && channels.length
        ? channels
        : ["shopee"];

      const idSet = new Set(productIds.map(String));
      const products = loadProducts().filter((p: any) => idSet.has(p.id));
      if (products.length === 0) {
        return res.status(404).json({ error: "Không tìm thấy sản phẩm nào trong kho." });
      }

      const shopList: any[] = Array.isArray(shops) ? shops : [];
      const wooShop = shopList.find((s) => s.platform === "woocommerce" && s.connected !== false);

      const shopeeShopId = resolveShopeeTokenShopId(shopId || shopList.find((s) => s.platform === "shopee")?.shopId);
      let shopeeToken: string | null = null;
      if (channelList.includes("shopee")) {
        if (!shopeeShopId) {
          return res.status(400).json({
            error: "Chưa có shop Shopee được ủy quyền.",
            logs: products.flatMap((p: any) => [
              {
                productId: p.id,
                sku: p.sku,
                channel: "shopee",
                action: "auth",
                success: false,
                message: "Chưa có shop Shopee được ủy quyền",
              },
            ]),
          });
        }
        shopeeToken = await getValidShopeeAccessToken(shopeeShopId);
        if (!shopeeToken) {
          return res.status(400).json({
            error: `Chưa có access_token hợp lệ cho shop_id=${shopeeShopId}.`,
            logs: products.flatMap((p: any) => [
              {
                productId: p.id,
                sku: p.sku,
                channel: "shopee",
                action: "auth",
                success: false,
                message: `Chưa có access_token hợp lệ cho shop_id=${shopeeShopId}`,
              },
            ]),
          });
        }
      }

      const logs: ChannelSyncLine[] = [];

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
        const now = new Date().toISOString();
        const next = allProducts.map((p: any) =>
          syncedProductIds.has(p.id) ? { ...p, lastSynced: now } : p
        );
        saveProducts(next);
      }

      return res.json({
        success: failCount === 0,
        logs,
        successCount,
        failCount,
        total: logs.length,
        products: loadProducts(),
      });
    } catch (error: any) {
      console.error("[Bulk Channel Sync]", error);
      return res.status(500).json({
        error: error?.message || "Đồng bộ đa kênh thất bại",
        logs: [],
      });
    }
  });

  // --- Suppliers API (data/suppliers.json) ---
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
      status: body.status || "active",
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
    const code = body.supplierCode
      ? String(body.supplierCode).trim().toUpperCase()
      : suppliers[index].supplierCode;
    if (
      suppliers.some((s, i) => i !== index && s.supplierCode === code)
    ) {
      return res.status(400).json({ error: "supplier_code_duplicate" });
    }
    const updated = normalizeSupplier({
      ...suppliers[index],
      ...body,
      id: suppliers[index].id,
      supplierCode: code,
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
    console.log("[Suppliers] Đã xóa sạch toàn bộ dữ liệu nhà cung cấp.");
    return res.json({ success: true, cleared: true, suppliers: [] });
  });

  // --- Imports API (data/imports.json) ---
  app.get("/api/imports", authMiddleware, (_req, res) => {
    return res.json(loadImports());
  });

  app.get("/api/imports/product-context/:productId", authMiddleware, (req, res) => {
    const productId = String(req.params.productId);
    const products = loadProducts();
    const product = products.find((p: any) => p.id === productId);
    if (!product) {
      return res.status(404).json({ error: "product_not_found" });
    }

    const imports = loadImports();
    const sku = String(product.sku || "");
    const history = imports.filter(
      (imp: any) => imp.productId === productId || (sku && imp.productSku === sku)
    );
    const latest = history.length > 0
      ? [...history].sort((a: any, b: any) => {
          const tb = new Date(b.date || 0).getTime();
          const ta = new Date(a.date || 0).getTime();
          if (tb !== ta) return tb - ta;
          return String(b.id || "").localeCompare(String(a.id || ""));
        })[0]
      : null;

    return res.json({
      productId,
      oldPrice: Math.max(0, Math.round(Number(product.importPrice) || 0)),
      lastSupplierName: latest?.supplierName || null,
      lastSupplierId: latest?.supplierId || null,
      lastImportDate: latest?.date || null,
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
      date: body.date || new Date().toISOString().split("T")[0],
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
      notes: body.notes || undefined,
    };
    imports.unshift(entry);
    saveImports(imports);
    return res.status(201).json({ import: entry, imports });
  });

  app.post("/api/imports/clear-all", authMiddleware, (_req, res) => {
    saveImports([]);
    console.log("[Imports] Đã xóa sạch toàn bộ lịch sử nhập hàng.");
    return res.json({ success: true, cleared: true, imports: [] });
  });

  // --- Expenses API (data/expenses.json) ---
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
      notes: body.notes ? String(body.notes) : undefined,
    };
    expenses.unshift(entry);
    saveExpenses(expenses);
    return res.status(201).json({ expense: entry, expenses });
  });

  app.delete("/api/expenses/:id", authMiddleware, (req, res) => {
    const expenses = loadExpenses();
    const next = expenses.filter((e: any) => e.id !== req.params.id);
    if (next.length === expenses.length) {
      return res.status(404).json({ error: "expense_not_found" });
    }
    saveExpenses(next);
    return res.json({ deleted: req.params.id, expenses: next });
  });

  app.post("/api/expenses/clear-all", authMiddleware, (_req, res) => {
    saveExpenses([]);
    console.log("[Expenses] Đã xóa sạch toàn bộ chi phí doanh nghiệp.");
    return res.json({ success: true, cleared: true, expenses: [] });
  });

  // --- Dashboard API ---
  app.get("/api/dashboard", authMiddleware, (req, res) => {
    try {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      const dateRange = String(req.query.date_range || "last_7_days");
      const range = getDashboardDateRange(dateRange);
      const allOrders = loadOrders();
      const orders = allOrders.filter(isDashboardOrder);
      const products = loadProducts();

      const ordersInRange = orders.filter((o: any) =>
        isDateInRange(String(o.date || ""), range.start, range.end)
      );

      const revenueOrders = ordersInRange.filter(
        (o: any) => o.status !== "cancelled" && Number(o.totalAmount) > 0
      );
      const totalRevenue = revenueOrders.reduce(
        (sum: number, o: any) => sum + (Number(o.totalAmount) || 0),
        0
      );
      const newOrderCount = ordersInRange.filter(
        (o: any) => o.status === "pending_confirm" || o.status === "unprocessed"
      ).length;
      const returnOrderCount = ordersInRange.filter(
        (o: any) => o.status === "return_pending" || o.status === "return_received"
      ).length;
      const cancelledOrderCount = ordersInRange.filter((o: any) => o.status === "cancelled").length;

      const pendingOrders = {
        pendingApproval: orders.filter((o: any) => o.status === "pending_confirm").length,
        pendingPayment: orders.filter(
          (o: any) => o.status === "pending_confirm" && o.channel === "manual"
        ).length,
        pendingPack: orders.filter(
          (o: any) => o.status === "unprocessed" && !o.isPrepared
        ).length,
        pendingPickup: orders.filter(
          (o: any) => (o.status === "unprocessed" && o.isPrepared) || o.status === "processed"
        ).length,
        shipping: orders.filter((o: any) => o.status === "shipping").length,
        returnPending: orders.filter((o: any) => o.status === "return_pending").length,
      };

      const productSales = new Map<string, { productId: string; quantitySold: number }>();
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

      const topProducts = Array.from(productSales.values())
        .sort((a, b) => b.quantitySold - a.quantitySold)
        .slice(0, 5)
        .map((entry, idx) => {
          const prod = products.find((p: any) => p.id === entry.productId);
          const itemMeta = findOrderItemMeta(revenueOrders, entry.productId);
          return {
            rank: idx + 1,
            productId: entry.productId,
            title: prod?.title || itemMeta.title || entry.productId,
            sku: prod?.sku || "—",
            imageUrl: prod?.avatarUrl || prod?.imageUrl || itemMeta.image || null,
            quantitySold: entry.quantitySold,
          };
        });

      const LOW_STOCK_THRESHOLD = 5;
      const lowStockProducts = products
        .filter((p: any) => (Number(p.stock) || 0) < LOW_STOCK_THRESHOLD)
        .map((p: any) => ({
          id: String(p.id),
          title: String(p.title || p.sku || p.id),
          sku: String(p.sku || ""),
          stock: Number(p.stock) || 0,
        }))
        .sort((a: any, b: any) => a.stock - b.stock);

      const chart = buildDashboardChart(revenueOrders, range);

      return res.json({
        dateRange: range.key,
        dateRangeLabel: range.label,
        startDate: toDateKey(range.start),
        endDate: toDateKey(range.end),
        meta: {
          totalOrdersInDb: allOrders.length,
          dashboardOrders: orders.length,
          ordersInRange: ordersInRange.length,
        },
        kpi: {
          revenue: totalRevenue,
          newOrders: newOrderCount,
          returns: returnOrderCount,
          cancelled: cancelledOrderCount,
        },
        pendingOrders,
        chart,
        topProducts,
        inventory: {
          lowStockThreshold: LOW_STOCK_THRESHOLD,
          lowStockProducts,
        },
      });
    } catch (error: any) {
      console.error("[Dashboard API] Error:", error);
      return res.status(500).json({
        error: "dashboard_query_failed",
        message: error?.message || "Không thể tải dữ liệu dashboard.",
      });
    }
  });

  // Broken/mock orders (0đ total AND no items — leftovers from earlier test
  // configuration, not real Shopee orders) are filtered out of the response.
  app.get("/api/orders", authMiddleware, (req, res) => {
    const products = loadProducts();
    const orders = enrichOrdersFromCatalog(loadOrders().filter(isValidOrder), products);
    return res.json(orders);
  });

  // Cleanup utility: permanently DELETE broken/mock order records (0đ total AND
  // no items) from the local database so they stop polluting the data file.
  app.post("/api/orders/cleanup-mock", authMiddleware, (req, res) => {
    const orders = loadOrders();
    const validOrders = orders.filter(isValidOrder);
    const removedOrders = orders.filter((o: any) => !isValidOrder(o));

    saveOrders(validOrders);
    console.log(
      `[Orders Cleanup] \u0110\xE3 x\xF3a ${removedOrders.length} \u0111\u01A1n h\xE0ng l\u1ED7i/mock (0\u0111 v\xE0 kh\xF4ng c\xF3 s\u1EA3n ph\u1EA9m). C\xF2n l\u1EA1i ${validOrders.length} \u0111\u01A1n th\u1EAD t.`,
      removedOrders.map((o: any) => o.orderSn || o.id)
    );

    return res.json({
      removed: removedOrders.length,
      remaining: validOrders.length,
      removedOrderSns: removedOrders.map((o: any) => o.orderSn || o.id),
    });
  });

  // Update a real order's status/tracking after a warehouse/UI action.
  app.patch("/api/orders/:id", authMiddleware, (req, res) => {
    const orders = loadOrders();
    const index = orders.findIndex((o: any) => o.id === req.params.id);
    if (index === -1) {
      return res.status(404).json({ error: "Kh\xF4ng t\xECm th\u1EA5y \u0111\u01A1n h\xE0ng." });
    }
    orders[index] = { ...orders[index], ...req.body, id: orders[index].id };
    saveOrders(orders);
    return res.json(orders[index]);
  });

  const VN_ADDRESS_API = "https://provinces.open-api.vn/api";
  let vnProvincesCache: any[] | null = null;
  const vnDistrictsCache = new Map<number, any[]>();
  const vnWardsCache = new Map<number, any[]>();

  const fetchVnJson = async (url: string) => {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`VN address API ${res.status}`);
    return res.json();
  };

  app.get("/api/vietnam-address/provinces", authMiddleware, async (_req, res) => {
    try {
      if (!vnProvincesCache) {
        vnProvincesCache = await fetchVnJson(`${VN_ADDRESS_API}/p/`);
      }
      const list = (vnProvincesCache || []).map((p: any) => ({
        name: p.name,
        code: p.code,
      }));
      return res.json(list);
    } catch (error: any) {
      console.error("[VN Address] provinces:", error);
      return res.status(502).json({ error: "Không tải được danh sách Tỉnh/Thành" });
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
          districts.map((d: any) => ({ name: d.name, code: d.code }))
        );
      }
      return res.json(vnDistrictsCache.get(provinceCode) || []);
    } catch (error: any) {
      console.error("[VN Address] districts:", error);
      return res.status(502).json({ error: "Không tải được danh sách Quận/Huyện" });
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
          wards.map((w: any) => ({ name: w.name, code: w.code }))
        );
      }
      return res.json(vnWardsCache.get(districtCode) || []);
    } catch (error: any) {
      console.error("[VN Address] wards:", error);
      return res.status(502).json({ error: "Không tải được danh sách Phường/Xã" });
    }
  });

  const buildCarrierLogisticsPayload = (
    carrier: string,
    customer: { name: string; phone: string },
    addr: {
      street: string;
      province: string;
      provinceCode: string;
      district: string;
      districtCode: string;
      ward: string;
      wardCode: string;
    },
    extras: { weight: number; note: string; codAmount: number }
  ) => {
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
        cod_amount: extras.codAmount,
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
          deliver_province_id: addr.provinceCode,
        },
        parcel_weight: extras.weight,
        remark: extras.note,
        cod_amount: extras.codAmount,
      };
    }
    return null;
  };

  const generateCarrierTracking = (carrier: string) => {
    if (carrier === "ghn") return `GHN-VN-${Math.floor(100000000 + Math.random() * 900000000)}`;
    if (carrier === "spx") return `SPX-VN-${Math.floor(100000000 + Math.random() * 900000000)}`;
    return `DIRECT-${Math.floor(100000 + Math.random() * 900000)}`;
  };

  app.post("/api/orders/manual", authMiddleware, (req, res) => {
    try {
      const body = req.body || {};
      const {
        customerName,
        customerPhone,
        shippingAddress,
        items,
        carrier = "self",
        packageWeight = 500,
        shippingFee = 0,
        orderDiscount = 0,
        carrierNotes = "",
      } = body;

      if (!customerName?.trim() || !customerPhone?.trim()) {
        return res.status(400).json({ error: "Thiếu tên hoặc số điện thoại khách hàng." });
      }

      const addr = shippingAddress || {};
      if (!addr.provinceCode || !addr.districtCode || !addr.wardCode || !addr.street?.trim()) {
        return res.status(400).json({
          error: "Địa chỉ chưa đầy đủ. Vui lòng chọn Tỉnh, Quận/Huyện, Phường/Xã và nhập địa chỉ chi tiết.",
        });
      }

      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: "Đơn hàng cần ít nhất 1 sản phẩm." });
      }

      const subtotal = items.reduce(
        (acc: number, it: any) => acc + Number(it.price || 0) * Number(it.quantity || 0),
        0
      );
      const totalAmount = subtotal + Number(shippingFee) - Number(orderDiscount);

      const fullAddress = [addr.street, addr.ward, addr.district, addr.province]
        .filter(Boolean)
        .join(", ");

      const trackingNumber = generateCarrierTracking(carrier);
      const logisticsPayload =
        carrier !== "self"
          ? buildCarrierLogisticsPayload(
              carrier,
              { name: customerName.trim(), phone: customerPhone.trim() },
              {
                street: addr.street.trim(),
                province: addr.province,
                provinceCode: String(addr.provinceCode),
                district: addr.district,
                districtCode: String(addr.districtCode),
                ward: addr.ward,
                wardCode: String(addr.wardCode),
              },
              {
                weight: Number(packageWeight) || 500,
                note: carrierNotes || "",
                codAmount: totalAmount,
              }
            )
          : null;

      if (logisticsPayload) {
        console.log(
          `[Logistics ${carrier.toUpperCase()}] Payload đẩy đơn:`,
          JSON.stringify(logisticsPayload, null, 2)
        );
      }

      const newOrder = {
        id: `order-manual-${Date.now()}`,
        orderSn: `DON-NGOAI-${Math.floor(100000 + Math.random() * 900000)}`,
        channel: "manual",
        customerName: customerName.trim(),
        customerPhone: customerPhone.trim(),
        customerAddress: fullAddress,
        shippingAddress: {
          province: addr.province,
          provinceCode: String(addr.provinceCode),
          district: addr.district,
          districtCode: String(addr.districtCode),
          ward: addr.ward,
          wardCode: String(addr.wardCode),
          street: addr.street.trim(),
          fullAddress,
        },
        carrier,
        totalAmount,
        revenue: totalAmount,
        status: "unprocessed",
        date: new Date().toISOString(),
        trackingNumber,
        isPrepared: carrier !== "self",
        isPrinted: false,
        items: items.map((it: any) => ({
          productId: it.productId,
          productTitle: it.productTitle,
          productImage: it.productImage,
          quantity: Number(it.quantity),
          price: Number(it.price),
        })),
        logisticsPayload,
      };

      const orders = loadOrders();
      orders.unshift(newOrder);
      saveOrders(orders);

      return res.json({
        success: true,
        order: newOrder,
        trackingNumber,
        logisticsPayload,
        orders: orders.filter(isValidOrder),
      });
    } catch (error: any) {
      console.error("[Orders manual]", error);
      return res.status(500).json({ error: error.message || "Tạo đơn thủ công thất bại" });
    }
  });

  // Full Shopee order sync — READY_TO_SHIP + PROCESSED + SHIPPED (15 ngày, lật trang đủ).
  app.post("/api/shopee/orders/sync", authMiddleware, async (req, res) => {
    if (!SHOPEE_PARTNER_ID || !SHOPEE_PARTNER_KEY) {
      return res.status(500).json({
        error: "Thi\u1EBFu SHOPEE_PARTNER_ID / SHOPEE_PARTNER_KEY (Live) trong file .env.",
      });
    }

    const tokens = loadShopeeTokens();
    if (Object.keys(tokens).length === 0) {
      return res.json({ synced: 0, orders: [], warning: "Ch\u01B0a c\xF3 shop Shopee Live n\xE0o \u0111\u01B0\u1EE3c \u1EE7y quy\u1EC1n." });
    }

    console.log(`[Shopee Sync] Bắt đầu đồng bộ đơn ${SHOPEE_SYNC_STATUSES.join(" + ")} (15 ngày, lật trang cursor)...`);
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
      warning: result.synced === 0 && !result.errors ? `Không tìm thấy đơn ${SHOPEE_SYNC_STATUSES.join("/")} nào trong 15 ngày gần nhất.` : undefined,
    });
  });

  // Active "pull" — actively calls Shopee's real v2.order.get_order_list +
  // v2.order.get_order_detail for every Live shop that has completed OAuth,
  // instead of passively waiting for webhook pushes. Bound to the "Cập nhật
  // đơn hàng" button on the frontend.
  app.post("/api/orders/pull", authMiddleware, async (req, res) => {
    if (!SHOPEE_PARTNER_ID || !SHOPEE_PARTNER_KEY) {
      return res.status(500).json({
        error: "Thi\u1EBFu SHOPEE_PARTNER_ID / SHOPEE_PARTNER_KEY (Live) trong file .env. Vui l\xF2ng c\u1EA5u h\xECnh tr\u01B0\u1EDBc khi k\xE9o \u0111\u01A1n.",
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
    const errors: any[] = [];

    for (const shopId of shopIds) {
      try {
        const accessToken = await getValidShopeeAccessToken(shopId);
        if (!accessToken) {
          errors.push({ shopId, error: "no_valid_access_token" });
          continue;
        }

        const orderSnList = await shopeeFetchAllOrderSns(shopId, accessToken);
        console.log(`[Shopee API] Shop ${shopId}: tìm thấy ${orderSnList.length} đơn hàng trong 15 ngày gần nhất (đã lật trang đủ).`);
        if (orderSnList.length === 0) continue;

        // get_order_detail accepts at most 50 order_sn per call.
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
            const existingIndex = orders.findIndex((o: any) => o.orderSn === normalized.orderSn);
            if (existingIndex >= 0) {
              orders[existingIndex] = mergeShopeeOrderOnSync(orders[existingIndex], normalized);
            } else {
              orders.unshift(normalized);
            }
            pulledCount++;
          }
        }
      } catch (error: any) {
        console.error(`[Shopee API] L\u1ED7i khi k\xE9o \u0111\u01A1n cho shop_id=${shopId}:`, error);
        errors.push({ shopId, error: error.message || "unknown_error" });
      }
    }

    saveOrders(orders);
    console.log(`[Shopee API] Ho\xE0n t\u1EA5t k\xE9o \u0111\u01A1n: ${pulledCount} \u0111\u01A1n \u0111\xE3 \u0111\u01B0\u1EE3c c\u1EADp nh\u1EADt/th\xEAm m\u1EDBi.`);

    return res.json({ pulled: pulledCount, orders: orders.filter(isValidOrder), errors: errors.length ? errors : undefined });
  });

  // Debug/test-only route: call v2.order.get_order_list directly with the
  // currently stored token for one shop and dump the RAW Shopee response
  // (no normalization, no saving) so you can see exactly what Shopee returns
  // — an empty order list [], or an error code (expired token, invalid sign...).
  // Usage: GET /api/shopee/force-sync?shop_id=4127421  (Authorization: Bearer <admin_token>)
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
        orderCount: listResult.response?.order_list?.length ?? 0,
      });
    } catch (error: any) {
      console.error("[Shopee Force-Sync] \u274C Exception:", error);
      return res.status(500).json({ step: "exception", ok: false, error: error.message || String(error) });
    }
  });

  // Real product sync — "Khởi tạo kho chính từ Shopee API": pulls the shop's
  // REAL listed items (v2.product.get_item_list -> get_item_base_info, plus
  // get_model_list for items with variants) and returns them normalized to
  // this project's Product shape. The frontend replaces its entire local
  // product list with this response — no more hardcoded/mock demo products.
  app.post("/api/shopee/products/sync", authMiddleware, async (req, res) => {
    if (!isShopeeConfigValid()) {
      return res.status(500).json({ error: "invalid_partner_config", message: "SHOPEE_PARTNER_ID/SHOPEE_PARTNER_KEY trong .env ch\u01B0a h\u1EE3p l\u1EC7." });
    }

    const tokens = loadShopeeTokens();
    const shopId = resolveShopeeTokenShopId(req.body?.shopId);
    if (!shopId) {
      return res.status(404).json({ error: "no_shopee_shop_linked", message: "Chưa có shop Shopee nào được ủy quyền." });
    }

    const accessToken = await getValidShopeeAccessToken(shopId);
    if (!accessToken) {
      return res.status(401).json({ error: "no_valid_access_token", message: `Chưa có access_token hợp lệ cho shop_id=${shopId}.` });
    }

    try {
      console.log(`[Shopee Product Sync] Bắt đầu đồng bộ kho cho shop_id=${shopId}...`);
      const result = await runFullShopeeWarehouseSync(shopId, accessToken);
      return res.json(result);
    } catch (error: any) {
      console.error("[Shopee Product Sync] Exception:", error);
      return res.status(500).json({ error: "exception", message: error.message || String(error) });
    }
  });

  // Tải/refresh toàn bộ phân loại (model_list / model_sku) cho MỘT sản phẩm Shopee.
  app.post("/api/shopee/products/sync-item-variants", authMiddleware, async (req, res) => {
    if (!isShopeeConfigValid()) {
      return res.status(500).json({ error: "invalid_partner_config" });
    }

    const rawItemId = String(req.body?.itemId || req.body?.shopeeItemId || req.body?.productId || "");
    const itemIdMatch = rawItemId.match(/(\d{6,})/);
    if (!itemIdMatch) {
      return res.status(400).json({ error: "itemId_required", message: "Không xác định được item_id Shopee." });
    }
    const itemId = Number(itemIdMatch[1]);

    const shopId = resolveShopeeTokenShopId(req.body?.shopId);
    if (!shopId) {
      return res.status(404).json({ error: "no_shopee_shop", message: "Chưa có shop Shopee được ủy quyền." });
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
        return res.status(404).json({ error: "no_variants_found", message: "Không lấy được phân loại từ Shopee." });
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
        products: merged,
      });
    } catch (err: any) {
      console.error("[Shopee Variant Sync] Exception:", err);
      return res.status(500).json({ error: "exception", message: err.message || String(err) });
    }
  });

  // --- Shopee logistics: "Chuẩn bị hàng" (ship_order) ------------------------

  // Single order: arrange pickup/dropoff (per the seller's explicit choice in the
  // "Xác nhận đơn hàng" modal) so it moves to "Chờ lấy hàng".
  app.post("/api/shopee/ship-order", authMiddleware, async (req, res) => {
    const { orderId, method } = req.body;
    const shipMethod: ShipMethod = method === "dropoff" ? "dropoff" : "pickup";
    const orders = loadOrders();
    const order = orders.find((o: any) => o.id === orderId);
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
      const index = orders.findIndex((o: any) => o.id === orderId);
      orders[index] = {
        ...orders[index],
        isPrepared: true,
        // Move the order into "Chờ lấy hàng (Đã xử lý)" the INSTANT ship_order
        // succeeds — no need to wait for the print step to flip this anymore.
        status: "processed",
        trackingNumber: orders[index].trackingNumber || result.trackingNumber,
        shopId: orders[index].shopId || result.shopId, // self-heal orders that lost shop_id from an old webhook bug
      };
      saveOrders(orders);
      return res.json({ success: true, mode: result.mode, order: orders[index] });
    }
    return res.status(400).json({ success: false, ...result });
  });

  // Bulk: arrange shipment for multiple orders at once ("Xác nhận Chuẩn bị hàng loạt"),
  // all using the single method (pickup/dropoff) the seller picked in the modal.
  // Accepts both orderIds and orderSns so the frontend can send whichever it has.
  // After all ship_order calls finish, automatically creates + downloads one merged
  // NORMAL_AIR_WAYBILL PDF for every successfully prepared Shopee order.
  app.post("/api/shopee/ship-order/bulk", authMiddleware, async (req, res) => {
    const { orderIds, orderSns, method } = req.body;
    const shipMethod: ShipMethod = method === "dropoff" ? "dropoff" : "pickup";
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
        orders: orders.filter(isValidOrder),
      });
    }

    const results: any[] = [];
    const successfulShopeeOrders: any[] = [];

    for (let i = 0; i < toShip.length; i++) {
      const { index, order } = toShip[i];
      // Self-heal missing shop_id before every ship_order call.
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
      }

      if (treatedAsSuccess) {
        orders[index] = {
          ...orders[index],
          isPrepared: true,
          status: "processed",
          trackingNumber: orders[index].trackingNumber || result.trackingNumber,
          shopId: orders[index].shopId || result.shopId || resolvedShopId,
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
        ...result,
      });

      // Brief pause between consecutive ship_order calls — avoids Shopee rate-limit
      // spikes when the seller confirms a large batch in one click.
      if (i < toShip.length - 1) {
        await new Promise(r => setTimeout(r, 400));
      }
    }

    saveOrders(orders);
    const successCount = results.filter(r => r.success).length;
    console.log(`[Ship Order Bulk] Ho\xE0n t\u1EA5t: ${successCount}/${toShip.length} \u0111\u01A1n chu\u1EA9n b\u1EB1 h\xE0ng th\xE0nh c\xF4ng.`);

    console.log("D\u1EEE LI\u1EC6U SHOPEE TR\u1EA2 V\u1EC0 (ship-order/bulk response g\u1EEDi cho Frontend):", JSON.stringify({ successCount, total: toShip.length, results }));
    const failedResults = results.filter(r => !r.success);
    if (failedResults.length > 0) {
      console.error(`[Ship Order Bulk] ${failedResults.length} \u0111\u01A1n L\u1ED6I chi ti\u1EBFt:`);
      for (const f of failedResults) {
        console.error(`   - \u0111\u01A1n ${f.orderSn || f.orderId}: error="${f.error || ""}" message="${f.message || ""}"`);
      }
    }

    // Closed-loop bulk print: wait 2s then fetch one merged NORMAL_AIR_WAYBILL PDF.
    let printDocument: any = null;
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
      printDocument,
    });
  });

  // --- Shopee logistics: "In đơn hàng" (create + poll + download AWB PDF) ---

  // Public, non-authenticated static folder (like Sapo): downloaded Shopee AWB
  // files are saved here and served directly at /labels/<file>, so the browser
  // can window.open() the link straight from a new tab and print it — no
  // Authorization header available on a plain tab navigation, so this MUST
  // live outside the authMiddleware-protected API routes.
  // NOTE: deliberately NOT named "public/" — Vite treats a root-level "public/"
  // folder as its own publicDir and copies its entire contents into dist/ on
  // every `npm run build`, which would bloat/leak generated AWB files into the
  // production bundle. "storage/labels" is served the exact same way via
  // express.static, giving an identical public /labels/<file> URL without that side effect.
  const SHIPPING_DOCS_DIR = path.join(process.cwd(), "storage", "labels");
  fs.mkdirSync(SHIPPING_DOCS_DIR, { recursive: true });
  app.use("/labels", express.static(SHIPPING_DOCS_DIR));

  function extensionForContentType(contentType: string): string {
    if (contentType.includes("zip")) return "zip";
    if (contentType.includes("html")) return "html";
    return "pdf";
  }

  function isPdfBuffer(buffer: Buffer, contentType?: string): boolean {
    if (contentType?.includes("pdf")) return true;
    return buffer.length > 4 && buffer.subarray(0, 4).toString() === "%PDF";
  }

  // Concatenate multiple AWB PDF buffers into one multi-page document so
  // window.print() prints every order label in a single dialog.
  async function mergePdfBuffers(buffers: Buffer[]): Promise<Buffer> {
    if (buffers.length === 0) throw new Error("No PDF buffers to merge.");
    if (buffers.length === 1) return buffers[0];

    const mergedPdf = await PDFDocument.create();
    for (const buf of buffers) {
      const src = await PDFDocument.load(buf);
      const pages = await mergedPdf.copyPages(src, src.getPageIndices());
      for (const page of pages) mergedPdf.addPage(page);
    }
    return Buffer.from(await mergedPdf.save());
  }

  function buildMergedLabelFilename(orderSns: string[]): string {
    const safe = orderSns.map((sn) => String(sn).replace(/[^a-zA-Z0-9_-]/g, "")).filter(Boolean);
    const primarySn = safe[0] || "bulk";
    return safe.length > 1 ? `${primarySn}_gop_${safe.length}_don.pdf` : `${primarySn}.pdf`;
  }

  function saveLabelFile(buffer: Buffer, filename: string, contentType?: string): string {
    fs.mkdirSync(SHIPPING_DOCS_DIR, { recursive: true });
    fs.writeFileSync(path.join(SHIPPING_DOCS_DIR, filename), buffer);
    console.log(`[Shopee Print] Đã lưu vận đơn (${contentType || "application/pdf"}) → storage/labels/${filename}`);
    return filename;
  }

  // Download AWB PDFs — for bulk runs, fetch each order individually then merge
  // so no label is silently dropped when Shopee's batch PDF only contains 1 page.
  async function downloadShippingDocumentsMerged(
    shopId: string,
    accessToken: string,
    cleanOrderList: { order_sn: string; package_number?: string; tracking_number?: string }[]
  ): Promise<{ buffer: Buffer; contentType: string } | { error: string; message?: string }> {
    if (cleanOrderList.length === 0) {
      return { error: "empty_order_list", message: "Không có đơn nào để tải vận đơn." };
    }

    if (cleanOrderList.length === 1) {
      const single = await shopeeDownloadShippingDocument(shopId, accessToken, cleanOrderList);
      if (single.error || !single.buffer) {
        return { error: single.error || "download_failed", message: single.message };
      }
      return { buffer: single.buffer, contentType: single.contentType || "application/pdf" };
    }

    const pdfBuffers: Buffer[] = [];
    for (const order of cleanOrderList) {
      const one = await shopeeDownloadShippingDocument(shopId, accessToken, [order]);
      if (one.buffer && isPdfBuffer(one.buffer, one.contentType)) {
        pdfBuffers.push(one.buffer);
        console.log(`[Shopee Print] Đã tải PDF riêng cho đơn ${order.order_sn} (${one.buffer.length} bytes).`);
      } else {
        console.warn(`[Shopee Print] Không tải được PDF riêng cho đơn ${order.order_sn}: ${one.error || one.message || "unknown"}`);
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
      console.warn(`[Shopee Print] Chỉ tải được ${pdfBuffers.length}/${cleanOrderList.length} PDF riêng — vẫn gộp các file đã có.`);
    }

    const merged = await mergePdfBuffers(pdfBuffers);
    return { buffer: merged, contentType: "application/pdf" };
  }

  async function mergeLabelFilesToSingleUrl(filenames: string[], orderSns: string[]): Promise<string | null> {
    const pdfBuffers: Buffer[] = [];
    for (const name of filenames) {
      const full = path.join(SHIPPING_DOCS_DIR, name);
      if (!fs.existsSync(full)) continue;
      const buf = fs.readFileSync(full);
      if (isPdfBuffer(buf)) pdfBuffers.push(buf);
    }
    if (pdfBuffers.length === 0) return null;
    if (pdfBuffers.length === 1) return `/labels/${filenames[0]}`;

    const merged = await mergePdfBuffers(pdfBuffers);
    const mergedName = buildMergedLabelFilename(orderSns);
    saveLabelFile(merged, mergedName, "application/pdf");
    console.log(`[Shopee Print] Đã gộp ${pdfBuffers.length} file PDF thành 1 file duy nhất: ${mergedName}`);
    return `/labels/${mergedName}`;
  }

  // Generates one real Shopee AWB/label document (grouped per shop) for the
  // given orders, polls until Shopee finishes rendering it, downloads the raw
  // file and saves it locally so the frontend can open/print it via a URL.
  // The full create→poll→download pipeline is wrapped in a retry loop: Shopee
  // sometimes hasn't finished internally processing the order's logistics
  // status yet (transient "All failed, please check result_list for detail"),
  // so up to 3 retries (4 attempts total), 3s apart, before finally giving up.
  async function generateShopeeShippingDocument(shopId: string, orderList: { order_sn: string; package_number?: string; tracking_number?: string }[]) {
    const accessToken = await getValidShopeeAccessToken(shopId);
    if (!accessToken) {
      return { success: false, error: "no_valid_access_token", message: `Ch\u01B0a c\xF3 access_token h\u1EE3p l\u1EC7 cho shop_id=${shopId}.` };
    }

    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 3000;
    let lastError: { error?: string; message?: string } = {};

    for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
      const result: any = await tryGenerateShopeeShippingDocumentOnce(shopId, accessToken, orderList);
      if (result.success) return result;

      lastError = { error: result.error, message: result.message };
      console.error(`[Shopee Print] L\u1EA5y v\u1EAD n \u0111\u01A1n TH\u1EA4T B\u1EA0I (l\u1EA7n ${attempt}/${MAX_RETRIES + 1}) cho shop_id=${shopId}: error="${result.error}" message="${result.message}"`);

      // Permanent errors (order has no valid tracking number / never actually
      // shipped) will NEVER succeed no matter how many times we retry — bail
      // out immediately instead of wasting 3 more x3s round-trips to Shopee.
      if (result.permanent) {
        console.error(`[Shopee Print] L\u1ED7i "${result.error}" l\xE0 l\u1ED7i VĨNH VI\u1EC4N (\u0111\u01A1n ch\u01B0a th\u1EF1c s\u1EF1 \u0111\u01B0\u1EE3c "Chu\u1EA9n b\u1EB1 h\xE0ng"/ship_order th\xE0nh c\xF4ng tr\xEAn Shopee) — b\u1ECF qua c\xE1c l\u1EA7n th\u1EED l\u1EA1i.`);
        break;
      }

      if (attempt <= MAX_RETRIES) {
        console.log(`[Shopee Print] T\u1EF1 \u0111\u1ED9ng th\u1EED l\u1EA1i sau ${RETRY_DELAY_MS}ms...`);
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      }
    }

    console.error(`[Shopee Print] \u0110\xE3 th\u1EED l\u1EA1i t\u1ED1i \u0111a (${MAX_RETRIES} l\u1EA7n) v\u1EABn th\u1EA5t b\u1EA1i cho shop_id=${shopId}. B\u1ECF cu\u1ED9c, \u0111\xE1nh d\u1EA5u \u0111\u01A1n l\xE0 "Ch\u01B0a in".`);
    return { success: false, error: lastError.error, message: lastError.message };
  }

  // Shopee errors that mean the order genuinely has no valid tracking number /
  // logistics assignment yet (i.e. ship_order was never actually completed for
  // it on Shopee's side) — these are PERMANENT, not transient. Retrying with a
  // delay changes nothing, so the retry loop above should fail fast on these.
  const PERMANENT_SHOPEE_DOC_ERRORS = new Set([
    "logistics.tracking_number_invalid",
    "logistics.order_status_error",
    "error_param",
  ]);

  // One single create_shipping_document → poll → download attempt (no retry logic here).
  //
  // IMPORTANT (bulk fix): create_shipping_document can PARTIALLY fail inside a
  // batch — Shopee returns HTTP 200 with error:"" at the top level, but some
  // individual orders inside response.result_list carry their own fail_error
  // (e.g. "logistics.package_can_not_print" for one bad order among 35 good
  // ones). If we keep sending the ORIGINAL orderList (including that failed
  // order) to get_shipping_document_result/download_shipping_document, Shopee
  // rejects the WHOLE batch download with "logistics.shipping_document_should_
  // print_first" — one bad order poisons every other order's PDF. So: split
  // successes from failures right here, and only poll/download the orders
  // that actually got a package_number back.
  async function tryGenerateShopeeShippingDocumentOnce(shopId: string, accessToken: string, orderList: { order_sn: string; package_number?: string; tracking_number?: string }[]) {
    const createResult = await shopeeCreateShippingDocument(shopId, accessToken, orderList);
    const createList: any[] = createResult.response?.result_list || [];
    const failedItems: any[] = createList.filter((it: any) => it.fail_error);
    // Only orders that got a real package_number back are safe to poll/download.
    const okItems: any[] = createList.filter((it: any) => it.package_number && !it.fail_error);

    if (createResult.error && okItems.length === 0) {
      // Top-level error AND nothing usable in result_list — total failure.
      if (failedItems.length > 0) {
        const first = failedItems[0];
        const detail = failedItems.map((it: any) => `${it.order_sn}: ${it.fail_message || it.fail_error}`).join("; ");
        return {
          success: false,
          error: first.fail_error || createResult.error,
          message: failedItems.length > 1 ? `${failedItems.length} \u0111\u01A1n l\u1ED7i: ${detail}` : (first.fail_message || detail),
          permanent: PERMANENT_SHOPEE_DOC_ERRORS.has(first.fail_error),
        };
      }
      return { success: false, error: createResult.error, message: createResult.message, permanent: PERMANENT_SHOPEE_DOC_ERRORS.has(createResult.error) };
    }

    if (okItems.length === 0) {
      // No top-level error, but every order in this batch individually failed.
      const detail = failedItems.map((it: any) => `${it.order_sn}: ${it.fail_message || it.fail_error}`).join("; ");
      return {
        success: false,
        error: failedItems[0]?.fail_error || "document_generation_failed",
        message: detail || "Kh\xF4ng c\xF3 \u0111\u01A1n n\xE0o t\u1EA1o v\u1EAD n th\xE0nh c\xF4ng trong l\u1EA7n g\u1ECDi n\xE0y.",
        permanent: PERMANENT_SHOPEE_DOC_ERRORS.has(failedItems[0]?.fail_error),
      };
    }

    // Rebuild orderList from ONLY the successfully-created items, carrying over
    // each order's real package_number (required by poll/download) and any
    // tracking_number we already had, keyed by order_sn.
    const originalBySn = new Map(orderList.map(o => [o.order_sn, o]));
    const cleanOrderList = okItems.map((it: any) => ({
      order_sn: it.order_sn,
      package_number: it.package_number,
      tracking_number: originalBySn.get(it.order_sn)?.tracking_number,
    }));
    const skippedOrders = failedItems.map((it: any) => ({ orderSn: it.order_sn, error: it.fail_error, message: it.fail_message }));
    if (skippedOrders.length > 0) {
      console.warn(`[Shopee Print] ${skippedOrders.length}/${orderList.length} \u0111\u01A1n b\u1ECB lo\u1EB7i b\u1ECF kh\u1ECFi l\u1EA7n t\u1EA1o v\u1EAD n n\xE0y (kh\xF4ng \u1EA3nh h\u01B0\u1EDFng \u0111\u1EBFn ${cleanOrderList.length} \u0111\u01A1n c\xF2n l\u1EA1i): ${JSON.stringify(skippedOrders)}`);
    }

    // Poll get_shipping_document_result until READY/FAILED. First wait 2s after
    // create_shipping_document — Shopee needs a moment to actually render the
    // AWB before it's ready to be fetched (matches the create -> 2s -> fetch flow).
    let status = "PROCESSING";
    let attempts = 0;
    while (status === "PROCESSING" && attempts < 10) {
      await new Promise(r => setTimeout(r, 2000));
      const pollResult = await shopeeGetShippingDocumentResult(shopId, accessToken, cleanOrderList);
      const items: any[] = pollResult.response?.result_list || [];
      // Consider the batch READY once none of the still-pending items are PROCESSING.
      const anyProcessing = items.some((it: any) => it.status === "PROCESSING");
      const anyFailed = items.some((it: any) => it.status === "FAILED");
      status = anyProcessing ? "PROCESSING" : (anyFailed && items.every((it: any) => it.status !== "READY") ? "FAILED" : "READY");
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
      return { success: false, error: (downloadResult as any).error, message: (downloadResult as any).message };
    }

    const ext = extensionForContentType(downloadResult.contentType);
    const orderSns = cleanOrderList.map((o: any) => o.order_sn);
    const filename = ext === "pdf" ? buildMergedLabelFilename(orderSns) : `${orderSns[0] || `shop-${shopId}`}.${ext}`;
    saveLabelFile(downloadResult.buffer, filename, downloadResult.contentType);
    console.log(`[Shopee Print] Đã lưu vận đơn thật từ Shopee (${cleanOrderList.length} đơn → 1 file ${filename}), truy cập tại /labels/${filename}.`);

    return {
      success: true,
      filename,
      contentType: downloadResult.contentType,
      orderSns,
      skippedOrders,
    };
  }

  // Shared helper: after a bulk (or single) ship_order run, wait 4s then create +
  // download one merged NORMAL_AIR_WAYBILL PDF per shop for the given orders.
  async function autoPrintLabelsForShopeeOrders(allOrders: any[], shopeeOrders: any[]) {
    const candidates = shopeeOrders.filter((o: any) => o.channel === "shopee" && (o.shopId || resolveOrderShopId(o)));
    if (candidates.length === 0) return null;

    for (const o of candidates) {
      if (!o.shopId) {
        const resolved = resolveOrderShopId(o);
        if (resolved) {
          o.shopId = resolved;
          const idx = allOrders.findIndex((x: any) => x.orderSn === o.orderSn);
          if (idx >= 0) allOrders[idx].shopId = resolved;
        }
      }
    }

    const groups: Record<string, any[]> = {};
    for (const o of candidates) {
      if (!o.shopId) continue;
      groups[o.shopId] = groups[o.shopId] || [];
      groups[o.shopId].push(o);
    }

    for (const [shopId, groupOrders] of Object.entries(groups)) {
      const accessToken = await getValidShopeeAccessToken(shopId);
      if (!accessToken) continue;
      for (const o of groupOrders) {
        if (o.trackingNumber) continue;
        const trackResult = await shopeeGetTrackingNumber(shopId, accessToken, o.orderSn, o.packageNumber);
        const fresh = trackResult.response?.tracking_number;
        if (fresh) {
          o.trackingNumber = fresh;
          const idx = allOrders.findIndex((x: any) => x.orderSn === o.orderSn);
          if (idx >= 0) allOrders[idx].trackingNumber = fresh;
        }
      }
    }
    saveOrders(allOrders);

    // Shopee needs ~4s after a bulk ship_order run before AWB/tracking numbers are
    // ready for create_shipping_document — 2s was too fast for newly created orders.
    console.log(`[Ship Order Bulk Auto-Print] Ch\u1EDD 4 gi\xE2y \u0111\u1EC3 Shopee kh\u1EDfi t\u1EA1o m\xE3 v\u1EADn \u0111\u01A1n cho ${candidates.length} \u0111\u01A1n...`);
    await new Promise(r => setTimeout(r, 4000));

    const printedOrderSns: string[] = [];
    const skippedOrders: any[] = [];
    const savedFilenames: string[] = [];

    for (const [shopId, groupOrders] of Object.entries(groups)) {
      const orderList = groupOrders.map((o: any) => ({
        order_sn: o.orderSn,
        package_number: o.packageNumber,
        tracking_number: o.trackingNumber,
      }));
      console.log(`[Ship Order Bulk Auto-Print] Tạo vận gộp ${orderList.length} đơn shop_id=${shopId}...`);
      const docResult = await generateShopeeShippingDocument(shopId, orderList);
      if (docResult.success && docResult.filename) {
        savedFilenames.push(docResult.filename);
        printedOrderSns.push(...(docResult.orderSns || groupOrders.map((o: any) => o.orderSn)));
        if (Array.isArray(docResult.skippedOrders)) skippedOrders.push(...docResult.skippedOrders);
      } else {
        console.error(`[Ship Order Bulk Auto-Print] Thất bại shop_id=${shopId}: ${docResult.error} - ${docResult.message}`);
        skippedOrders.push({ shopId, error: docResult.error, message: docResult.message });
      }
    }

    const primaryUrl = savedFilenames.length > 0
      ? await mergeLabelFilesToSingleUrl(savedFilenames, printedOrderSns)
      : null;

    if (!primaryUrl) {
      return { url: null, printedOrderSns, skippedOrders, message: "Kh\xF4ng t\u1EA1o \u0111\u01B0\u1EE3c v\u1EAD n \u0111\u01A1n t\u1EF1 \u0111\u1ED9ng sau khi chu\u1EA9n b\u1EB1 h\xE0ng." };
    }
    return { url: primaryUrl, printedOrderSns, skippedOrders };
  }

  // Single or bulk print: fetch the REAL Shopee AWB PDF for the given orders.
  app.post("/api/shopee/print-document", authMiddleware, async (req, res) => {
    const { orderIds } = req.body;
    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      return res.status(400).json({ error: "Thi\u1EBFu danh s\xE1ch orderIds." });
    }

    const orders = loadOrders();
    const targetOrders = orders.filter((o: any) => orderIds.includes(o.id));

    // Self-heal orders that lost shop_id from the old webhook-normalization bug —
    // resolveOrderShopId() falls back to the single connected Shopee shop when
    // an order's own shopId field is missing. Persist the fix back onto the
    // order in-place so it doesn't need to be resolved again next time.
    for (const o of targetOrders) {
      if (o.channel === "shopee" && !o.shopId) {
        const resolved = resolveOrderShopId(o);
        if (resolved) o.shopId = resolved;
      }
    }

    const shopeeCandidates = targetOrders.filter((o: any) => o.channel === "shopee" && o.shopId);

    // Deliberately NOT gating on order.isPrepared (local ship_order flag) anymore.
    // Per explicit product decision, if the order is genuinely ready on Shopee's
    // side, calling create_shipping_document/get_shipping_document must be allowed
    // straight away — Shopee itself is the single source of truth for whether the
    // order's logistics status actually supports document generation; if it
    // doesn't, Shopee's own API call below will return its own real error/message,
    // which is already logged and surfaced to the frontend as-is (no more local
    // "orders_not_prepared" pre-check blocking the request beforehand).
    if (shopeeCandidates.length === 0) {
      return res.status(400).json({ error: "Kh\xF4ng c\xF3 \u0111\u01A1n Shopee th\u1EADt n\xE0o (c\xF3 shop_id) trong danh s\xE1ch \u0111\u01B0\u1EE3c ch\u1ECDn \u0111\u1EC3 in v\u1EAD n." });
    }

    // Group by shop_id — create_shipping_document is per-shop.
    const groups: Record<string, any[]> = {};
    for (const o of shopeeCandidates) {
      groups[o.shopId] = groups[o.shopId] || [];
      groups[o.shopId].push(o);
    }

    // create_shipping_document REQUIRES a real tracking_number for integrated
    // channels (Shopee's own 3PL, e.g. SPX) — this is the actual root cause of
    // "logistics.tracking_number_invalid" even for an order that is genuinely
    // "Đang giao" with a valid tracking number on Shopee's own platform: we were
    // simply never sending that tracking_number in the request body. Resolve +
    // persist it here (from cache, or freshly via get_tracking_number) before
    // building each shop's order_list.
    for (const [shopId, groupOrders] of Object.entries(groups)) {
      const accessToken = await getValidShopeeAccessToken(shopId);
      if (!accessToken) continue;
      for (const o of groupOrders) {
        if (o.trackingNumber) continue;
        const trackResult = await shopeeGetTrackingNumber(shopId, accessToken, o.orderSn, o.packageNumber);
        const fresh = trackResult.response?.tracking_number;
        if (fresh) {
          o.trackingNumber = fresh;
          const idx = orders.findIndex((x: any) => x.orderSn === o.orderSn);
          if (idx >= 0) orders[idx].trackingNumber = fresh;
          console.log(`[Shopee Print] \u0110\xE3 l\u1EA5y tracking_number="${fresh}" cho \u0111\u01A1n ${o.orderSn} qua get_tracking_number.`);
        } else {
          console.error(`[Shopee Print] Kh\xF4ng l\u1EA5y \u0111\u01B0\u1EE3c tracking_number cho \u0111\u01A1n ${o.orderSn} (get_tracking_number tr\u1EA3 v\u1EC1: ${JSON.stringify(trackResult)}). create_shipping_document c\xF3 th\u1EC3 s\u1EBD b\u1ECB t\u1EEB ch\u1ED1i.`);
        }
      }
    }
    saveOrders(orders);

    const documents: any[] = [];
    const savedFilenames: string[] = [];
    const allPrintedSns: string[] = [];

    for (const [shopId, groupOrders] of Object.entries(groups)) {
      const orderList = groupOrders.map((o: any) => ({ order_sn: o.orderSn, package_number: o.packageNumber, tracking_number: o.trackingNumber }));
      console.log(`[Shopee Print] Đang tạo vận đơn cho ${orderList.length} đơn của shop_id=${shopId}...`);
      const docResult = await generateShopeeShippingDocument(shopId, orderList);

      if (docResult.success && docResult.filename) {
        savedFilenames.push(docResult.filename);
        const sns = docResult.orderSns || groupOrders.map((o: any) => o.orderSn);
        allPrintedSns.push(...sns);
        documents.push({
          shopId,
          orderSns: sns,
          url: `/labels/${docResult.filename}`,
          contentType: docResult.contentType,
        });
        if (Array.isArray(docResult.skippedOrders) && docResult.skippedOrders.length > 0) {
          for (const skipped of docResult.skippedOrders) {
            documents.push({
              shopId,
              orderSns: [skipped.orderSn],
              success: false,
              error: skipped.error,
              message: skipped.message,
            });
          }
        }
      } else {
        documents.push({ shopId, orderSns: groupOrders.map((o: any) => o.orderSn), success: false, error: docResult.error, message: docResult.message });
      }
    }

    const mergedUrl = savedFilenames.length > 0
      ? await mergeLabelFilesToSingleUrl(savedFilenames, allPrintedSns)
      : null;

    // Mark successfully-printed orders (isPrinted=true, and auto-advance status like the old UI mock did).
    const printedOrderSns = new Set(allPrintedSns);
    const updatedOrders = orders.map((o: any) => {
      if (printedOrderSns.has(o.orderSn)) {
        return { ...o, isPrinted: true, status: o.isPrepared ? "processed" : o.status };
      }
      return o;
    });
    saveOrders(updatedOrders);

    console.log(`[Shopee Print] Ho\xE0n t\u1EA5t: ${documents.filter(d => d.url).length}/${Object.keys(groups).length} nh\xF3m shop t\u1EA1o v\u1EAD n th\xE0nh c\xF4ng.`);

    return res.json({ mergedUrl, documents, orders: updatedOrders.filter(isValidOrder) });
  });

  let ai: GoogleGenAI | null = null;
  if (process.env.GEMINI_API_KEY) {
    ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  } else {
    console.warn("Warning: GEMINI_API_KEY is not configured in .env");
  }

  const initGeminiClient = (apiKey: string) => {
    return new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: { "User-Agent": "aistudio-build" },
      },
    });
  };

  app.get("/api/settings/gemini-status", authMiddleware, (_req, res) => {
    const key = process.env.GEMINI_API_KEY || "";
    const configured = Boolean(key && key !== "chua_co_key_tam_thoi");
    return res.json({
      success: true,
      configured,
      maskedKey: configured ? maskApiKey(key) : "",
    });
  });

  app.post("/api/settings/update-gemini-key", authMiddleware, (req, res) => {
    try {
      const { apiKey } = req.body || {};
      const trimmed = String(apiKey || "").trim();
      if (!trimmed) {
        return res.status(400).json({ success: false, error: "Vui lòng nhập Gemini API Key." });
      }
      updateEnvVar("GEMINI_API_KEY", trimmed);
      ai = initGeminiClient(trimmed);
      return res.json({ success: true, message: "Đã cập nhật API Key thành công!" });
    } catch (error: any) {
      return res.status(500).json({ success: false, error: error.message || "Lưu API Key thất bại" });
    }
  });

  app.post("/api/settings/test-gemini-key", authMiddleware, async (req, res) => {
    try {
      const testKey = String(req.body?.apiKey || process.env.GEMINI_API_KEY || "").trim();
      if (!testKey || testKey === "chua_co_key_tam_thoi") {
        return res.status(400).json({ success: false, error: "API Key không hợp lệ" });
      }
      const testAi = initGeminiClient(testKey);
      await testAi.models.generateContent({
        model: "gemini-3.5-flash",
        contents: "Reply with exactly: OK",
      });
      return res.json({ success: true, message: "Kết nối thành công!" });
    } catch (error: any) {
      console.error("[Gemini test]", error);
      return res.status(400).json({ success: false, error: "API Key không hợp lệ" });
    }
  });

  async function checkShopConnectionStatus(shop: any): Promise<{ online: boolean; message: string }> {
    if (!shop?.connected) {
      return { online: false, message: "Đồng bộ đang tắt" };
    }

    if (shop.platform === "shopee") {
      if (!isShopeeConfigValid()) {
        return { online: false, message: "Shopee Partner ID/Key chưa cấu hình" };
      }
      const token = await getValidShopeeAccessToken(String(shop.shopId || ""));
      if (token) {
        return { online: true, message: "OAuth token hợp lệ" };
      }
      return { online: false, message: "Chưa OAuth hoặc token hết hạn" };
    }

    if (shop.platform === "woocommerce") {
      const base = String(shop.wooUrl || "").replace(/\/$/, "");
      const key = String(shop.shopId || "").trim();
      const secret = String(shop.apiSecret || shop.apiKey || "").trim();
      if (!base || !key) {
        return { online: false, message: "Thiếu URL hoặc Consumer Key" };
      }
      try {
        const auth = Buffer.from(`${key}:${secret}`).toString("base64");
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        const res = await fetch(`${base}/wp-json/wc/v3/system_status`, {
          headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (res.ok) {
          return { online: true, message: "WooCommerce REST API phản hồi OK" };
        }
        return { online: false, message: `WooCommerce trả HTTP ${res.status}` };
      } catch (error: any) {
        return { online: false, message: error?.message || "Không kết nối được WooCommerce" };
      }
    }

    if (shop.platform === "tiktok") {
      if (shop.shopId && shop.apiKey) {
        return { online: true, message: "Credentials TikTok Shop đã cấu hình" };
      }
      return { online: false, message: "Thiếu Seller ID hoặc API Key" };
    }

    return { online: false, message: "Nền tảng không hỗ trợ" };
  }

  app.post("/api/settings/shop-connection-status", authMiddleware, async (req, res) => {
    try {
      const shops = Array.isArray(req.body?.shops) ? req.body.shops : [];
      const statuses: Record<string, { online: boolean; message: string }> = {};
      for (const shop of shops) {
        if (!shop?.id) continue;
        statuses[shop.id] = await checkShopConnectionStatus(shop);
      }
      return res.json({ success: true, statuses });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        error: error?.message || "Kiểm tra kết nối thất bại",
      });
    }
  });

  // API endpoint for Gemini optimization (Protected)
  app.post("/api/gemini/optimize", authMiddleware, async (req, res) => {
    try {
      const { action, text, context } = req.body;
      const apiKey = process.env.GEMINI_API_KEY;

      if (!apiKey) {
        return res.status(503).json({
          error: "Ch\u01B0a c\u1EA5u h\xECnh API Key c\u1EE7a Gemini AI. Vui l\xF2ng c\xE0i \u0111\u1EB7t trong m\u1EE5c Settings ho\u1EB7c Secrets.",
        });
      }

      if (!ai) {
        ai = new GoogleGenAI({
          apiKey,
          httpOptions: {
            headers: {
              "User-Agent": "aistudio-build",
            },
          },
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
        contents: prompt,
      });

      return res.json({ result: response.text });
    } catch (error: any) {
      console.error("Gemini API Error:", error);
      return res.status(500).json({ error: error.message || "L\u1ED7i x\u1EED l\xFD AI t\u1EEB server" });
    }
  });

  const LISTINGS_DB_PATH = path.join(process.cwd(), "data", "multi_channel_listings.json");

  const readListingsDb = (): any[] => {
    try {
      if (!fs.existsSync(LISTINGS_DB_PATH)) return [];
      const raw = fs.readFileSync(LISTINGS_DB_PATH, "utf-8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };

  const writeListingsDb = (listings: any[]) => {
    const dir = path.dirname(LISTINGS_DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(LISTINGS_DB_PATH, JSON.stringify(listings, null, 2), "utf-8");
  };

  const markdownToHtml = (text: string): string => {
    if (!text) return "";
    if (/<[a-z][\s\S]*>/i.test(text)) return text;
    const lines = text.split("\n");
    const parts: string[] = [];
    let inList = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        if (inList) { parts.push("</ul>"); inList = false; }
        continue;
      }
      if (trimmed.startsWith("### ")) {
        if (inList) { parts.push("</ul>"); inList = false; }
        parts.push(`<h3>${trimmed.slice(4)}</h3>`);
      } else if (trimmed.startsWith("## ")) {
        if (inList) { parts.push("</ul>"); inList = false; }
        parts.push(`<h2>${trimmed.slice(3)}</h2>`);
      } else if (trimmed.startsWith("# ")) {
        if (inList) { parts.push("</ul>"); inList = false; }
        parts.push(`<h1>${trimmed.slice(2)}</h1>`);
      } else if (/^[-*]\s+/.test(trimmed)) {
        if (!inList) { parts.push("<ul>"); inList = true; }
        parts.push(`<li>${trimmed.replace(/^[-*]\s+/, "")}</li>`);
      } else {
        if (inList) { parts.push("</ul>"); inList = false; }
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
          error: "Chưa cấu hình API Key của Gemini AI.",
        });
      }

      if (!address?.trim()) {
        return res.status(400).json({ error: "Thiếu chuỗi địa chỉ cần phân tích." });
      }

      if (!ai) {
        ai = new GoogleGenAI({
          apiKey,
          httpOptions: { headers: { "User-Agent": "aistudio-build" } },
        });
      }

      const prompt = `Bạn là chuyên gia phân tích địa chỉ giao hàng Việt Nam.
Phân tích chuỗi địa chỉ sau và trả về JSON thuần (KHÔNG markdown, KHÔNG giải thích):
{"province":"...","district":"...","ward":"...","street":"..."}

Yêu cầu:
- province: tên Tỉnh/Thành phố chuẩn (VD: "Thành phố Hồ Chí Minh", "Hà Nội")
- district: tên Quận/Huyện/Thị xã chuẩn (VD: "Quận 1", "Huyện Đông Anh")
- ward: tên Phường/Xã/Thị trấn chuẩn
- street: phần địa chỉ chi tiết còn lại (số nhà, tên đường, ngõ ngách)
- Chuẩn hóa viết tắt: HCM/TPHCM -> Thành phố Hồ Chí Minh, Q1 -> Quận 1, P. -> Phường

Địa chỉ cần phân tích: "${String(address).trim()}"`;

      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: prompt,
      });

      const raw = (response.text || "").trim();
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return res.status(422).json({ error: "AI không trả về JSON hợp lệ." });
      }

      const parsed = JSON.parse(jsonMatch[0]);
      return res.json({
        success: true,
        parsed: {
          province: String(parsed.province || "").trim(),
          district: String(parsed.district || "").trim(),
          ward: String(parsed.ward || "").trim(),
          street: String(parsed.street || "").trim(),
        },
      });
    } catch (error: any) {
      console.error("[AI parse-address]", error);
      return res.status(500).json({ error: error.message || "Lỗi phân tích địa chỉ AI" });
    }
  });

  app.post("/api/ai/generate-description", authMiddleware, async (req, res) => {
    try {
      const { title, keywords, context } = req.body || {};
      const apiKey = process.env.GEMINI_API_KEY;

      if (!apiKey) {
        return res.status(503).json({
          error: "Ch\u01B0a c\u1EA5u h\xECnh API Key c\u1EE7a Gemini AI.",
        });
      }

      if (!ai) {
        ai = new GoogleGenAI({
          apiKey,
          httpOptions: { headers: { "User-Agent": "aistudio-build" } },
        });
      }

      const prompt = `B\u1EA1n l\xE0 chuy\xEAn gia Copywriter vi\u1EBFt m\xF4 t\u1EA3 s\u1EA3n ph\u1EA9m b\xE1n h\xE0ng tr\xEAn Shopee, Lazada v\xE0 TikTok Shop Vi\u1EC7t Nam.
H\xE3y vi\u1EBFt m\xF4 t\u1EA3 s\u1EA3n ph\u1EA9m d\u1EA1ng HTML (d\xF9ng th\u1EBB h2, h3, p, ul, li, strong) \u2014 KH\xD4NG d\xF9ng markdown, KH\xD4NG bọc trong \`\`\`html.
T\xEAn s\u1EA3n ph\u1EA9m: "${title || ""}"
T\u1EEB kh\xF3a / T\xEDnh n\u0103ng: "${keywords || ""}"
${context ? `Th\xF4ng tin th\xEAm: ${context}` : ""}

C\u1EA5u tr\xFAc: slogan ng\u1EAFn, \u0111\u1EB7c \u0111i\u1EC3m n\u1ED5i b\u1EADt (ul/li), th\xF4ng s\u1ED1, cam k\u1EBFt shop, hashtags cu\u1ED1i b\xE0i. Ch\u1EC9 tr\u1EA3 v\u1EC1 HTML thu\u1EA7n.`;

      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: prompt,
      });

      const raw = (response.text || "").trim();
      const html = markdownToHtml(raw.replace(/^```html\s*/i, "").replace(/```\s*$/i, ""));
      return res.json({ success: true, html });
    } catch (error: any) {
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
        savedAt: new Date().toISOString(),
      };
      listings.unshift(entry);
      writeListingsDb(listings.slice(0, 200));
      return res.json({ success: true, id: entry.id, message: "L\u01B0u nh\xE1p \u0111\u0103ng b\xE1n \u0111a s\xE0n th\xE0nh c\xF4ng" });
    } catch (error: any) {
      return res.status(500).json({ success: false, error: error.message || "L\u01B0u th\u1EA5t b\u1EA1i" });
    }
  });

  const PRODUCT_LISTINGS_DB_PATH = path.join(process.cwd(), "data", "product_listings.json");

  const readProductListingsDb = (): any[] => {
    try {
      if (!fs.existsSync(PRODUCT_LISTINGS_DB_PATH)) return [];
      const raw = fs.readFileSync(PRODUCT_LISTINGS_DB_PATH, "utf-8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };

  const writeProductListingsDb = (rows: any[]) => {
    const dir = path.dirname(PRODUCT_LISTINGS_DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PRODUCT_LISTINGS_DB_PATH, JSON.stringify(rows, null, 2), "utf-8");
  };

  const computeOverallListingStatus = (statuses: string[]): string => {
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
      const byProduct = new Map<string, any[]>();

      for (const row of rows) {
        const pid = row.product_id || "unknown";
        if (!byProduct.has(pid)) byProduct.set(pid, []);
        byProduct.get(pid)!.push(row);
      }

      const groups = Array.from(byProduct.entries()).map(([productId, children]) => {
        const sorted = [...children].sort(
          (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
        );
        const product = products.find((p: any) => p.id === productId);
        const statuses = sorted.map((c) => c.status);
        const created = sorted.reduce((min, c) => (c.created_at < min ? c.created_at : min), sorted[0].created_at);
        const updated = sorted.reduce((max, c) => (c.updated_at > max ? c.updated_at : max), sorted[0].updated_at);
        const platforms = Array.from(new Set(sorted.map((c) => c.platform)));

        return {
          product_id: productId,
          product_title: product?.title || sorted[0]?.listing_title || "Sản phẩm không xác định",
          product_image: product?.imageUrl || product?.avatarUrl || sorted[0]?.product_image,
          product_sku: product?.sku,
          created_at: created,
          updated_at: updated,
          overall_status: computeOverallListingStatus(statuses),
          platform_labels: platforms,
          children: sorted,
        };
      });

      groups.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

      return res.json({ success: true, groups });
    } catch (error: any) {
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/multi-channel/publish", authMiddleware, (req, res) => {
    try {
      const payload = req.body || {};
      const {
        warehouseProductId,
        title,
        images = [],
        shops = [],
        selectedShops = [],
      } = payload;

      const productId = warehouseProductId || payload.product_id || "unknown";
      const product = loadProducts().find((p: any) => p.id === productId);
      const batchId = `batch-${Date.now()}`;
      const now = new Date().toISOString();
      const allRows = readProductListingsDb();
      const newRows: any[] = [];

      const shopList = Array.isArray(shops) && shops.length
        ? shops
        : (selectedShops as string[]).map((id: string) => ({ id, name: id, platform: "shopee" }));

      for (let i = 0; i < shopList.length; i++) {
        const shop = shopList[i];
        const platform = String(shop.platform || "shopee").toLowerCase();
        if (!["shopee", "lazada", "tiktok"].includes(platform)) continue;

        const existingIdx = allRows.findIndex(
          (r) => r.product_id === productId && r.shop_id === shop.id && r.platform === platform
        );

        const simulateFail = platform === "lazada" && i % 3 === 2;
        const status = simulateFail ? "failed" : "success";
        const platformProductId = status === "success"
          ? `${platform}-${productId}-${Date.now().toString(36)}`
          : undefined;

        const row = {
          id: existingIdx >= 0 ? allRows[existingIdx].id : `pl-${Date.now()}-${i}`,
          product_id: productId,
          publish_batch_id: batchId,
          platform,
          shop_id: shop.id,
          shop_name: shop.name || shop.shopName || shop.id,
          status,
          platform_product_id: platformProductId,
          error_message: status === "failed" ? "Lỗi xác thực danh mục hoặc từ khóa bị cấm trên sàn" : undefined,
          listing_title: (payload.shopTitles && payload.shopTitles[shop.id]) || title || product?.title,
          product_image: images[0] || product?.imageUrl || product?.avatarUrl,
          created_at: existingIdx >= 0 ? allRows[existingIdx].created_at : now,
          updated_at: now,
        };

        if (existingIdx >= 0) {
          allRows[existingIdx] = row;
        } else {
          allRows.unshift(row);
        }
        newRows.push(row);
      }

      writeProductListingsDb(allRows.slice(0, 2000));

      const draftListings = readListingsDb();
      draftListings.unshift({
        id: `listing-${Date.now()}`,
        ...payload,
        publish_batch_id: batchId,
        savedAt: now,
        published: true,
      });
      writeListingsDb(draftListings.slice(0, 200));

      return res.json({
        success: true,
        batchId,
        listings: newRows,
        message: `Đã ghi nhận đăng bán lên ${newRows.length} gian hàng`,
      });
    } catch (error: any) {
      return res.status(500).json({ success: false, error: error.message || "Đăng bán thất bại" });
    }
  });

  const PUBLISH_EDIT_DB_PATH = path.join(process.cwd(), "data", "publish_edit.json");
  const FRAMED_IMAGES_DIR = path.join(process.cwd(), "data", "framed_images");

  const readPublishEditDb = (): { config: any; meta: Record<string, any> } => {
    try {
      if (!fs.existsSync(PUBLISH_EDIT_DB_PATH)) return { config: {}, meta: {} };
      const raw = fs.readFileSync(PUBLISH_EDIT_DB_PATH, "utf-8");
      const parsed = JSON.parse(raw);
      return { config: parsed.config || {}, meta: parsed.meta || {} };
    } catch {
      return { config: {}, meta: {} };
    }
  };

  const writePublishEditDb = (data: { config: any; meta: Record<string, any> }) => {
    const dir = path.dirname(PUBLISH_EDIT_DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PUBLISH_EDIT_DB_PATH, JSON.stringify(data, null, 2), "utf-8");
  };

  app.get("/api/publish-edit", authMiddleware, (_req, res) => {
    const db = readPublishEditDb();
    return res.json({ success: true, config: db.config, meta: db.meta });
  });

  app.post("/api/publish-edit/config", authMiddleware, (req, res) => {
    try {
      const db = readPublishEditDb();
      db.config = { ...db.config, ...req.body, updated_at: new Date().toISOString() };
      writePublishEditDb(db);
      return res.json({ success: true, config: db.config });
    } catch (error: any) {
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
          ...(db.meta[item.productId] || {}),
          shopTitles: item.shopTitles || {},
          aiTitles: item.aiTitles || [],
          titlesAppliedAt: new Date().toISOString(),
        };
      }
      writePublishEditDb(db);
      return res.json({ success: true, meta: db.meta });
    } catch (error: any) {
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/publish-edit/save-framed-image", authMiddleware, (req, res) => {
    try {
      const { productId, imageDataUrl, framedHash } = req.body || {};
      if (!productId || !imageDataUrl) {
        return res.status(400).json({ success: false, error: "Thiếu productId hoặc ảnh" });
      }

      if (!fs.existsSync(FRAMED_IMAGES_DIR)) fs.mkdirSync(FRAMED_IMAGES_DIR, { recursive: true });

      const base64 = String(imageDataUrl).replace(/^data:image\/\w+;base64,/, "");
      const buf = Buffer.from(base64, "base64");
      const filename = `${productId}.jpg`;
      fs.writeFileSync(path.join(FRAMED_IMAGES_DIR, filename), buf);

      const imageUrl = `/api/framed-images/${productId}`;
      const products = loadProducts();
      const idx = products.findIndex((p: any) => p.id === productId);
      if (idx >= 0) {
        products[idx] = { ...products[idx], imageUrl };
        saveProducts(products);
      }

      const db = readPublishEditDb();
      db.meta[productId] = {
        ...(db.meta[productId] || {}),
        framedImageUrl: imageUrl,
        framedHash: framedHash || `hash-${buf.length}`,
        frameAppliedAt: new Date().toISOString(),
      };
      writePublishEditDb(db);

      return res.json({ success: true, imageUrl, framedHash: db.meta[productId].framedHash });
    } catch (error: any) {
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get("/api/framed-images/:productId", (req, res) => {
    const filePath = path.join(FRAMED_IMAGES_DIR, `${req.params.productId}.jpg`);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Không tìm thấy ảnh" });
    }
    res.setHeader("Content-Type", "image/jpeg");
    return res.send(fs.readFileSync(filePath));
  });

  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath, {
      setHeaders(res, filePath) {
        if (filePath.endsWith("index.html")) {
          res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
          res.setHeader("Pragma", "no-cache");
          res.setHeader("Expires", "0");
        } else if (/\.(js|css)$/.test(filePath)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
    }));
    app.get("*", (req, res) => {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.sendFile(path.join(distPath, "index.html"));
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
