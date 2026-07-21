#!/usr/bin/env node
/**
 * QUÉT CẠN — Sync mã vận đơn thiếu từ Shopee v2.logistics.get_tracking_number
 *
 * Chạy 1 lần (độc lập):
 *   node scripts/sync_missing_tracking.js
 *
 * Tuỳ chọn:
 *   node scripts/sync_missing_tracking.js --limit=50
 *   node scripts/sync_missing_tracking.js --shop=4127421
 *   node scripts/sync_missing_tracking.js --dry-run
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import mongoose from "mongoose";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
dotenv.config({ path: path.join(ROOT, ".env") });

const URI = String(process.env.MONGODB_URI || process.env.MONGO_URL || "").trim();
const PARTNER_ID = String(process.env.SHOPEE_PARTNER_ID || "").trim();
const PARTNER_KEY = String(process.env.SHOPEE_PARTNER_KEY || "").trim();
const HOST = "https://partner.shopeemobile.com";
const TOKENS_PATH = path.join(ROOT, "data", "shopee_tokens.json");
const ORDERS_JSON_PATH = path.join(ROOT, "data", "orders.json");
const DELAY_MS = 500;

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : "";
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sign(apiPath, timestamp, accessToken, shopId) {
  const base = accessToken
    ? `${PARTNER_ID}${apiPath}${timestamp}${accessToken}${shopId}`
    : `${PARTNER_ID}${apiPath}${timestamp}`;
  return crypto.createHmac("sha256", PARTNER_KEY).update(base).digest("hex");
}

function loadTokens() {
  if (!fs.existsSync(TOKENS_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(TOKENS_PATH, "utf8")) || {};
  } catch {
    return {};
  }
}

function saveTokens(tokens) {
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2) + "\n", "utf8");
}

async function refreshAccessToken(shopId, refreshToken) {
  const apiPath = "/api/v2/auth/access_token/get";
  const timestamp = Math.floor(Date.now() / 1000);
  const s = sign(apiPath, timestamp);
  const url = `${HOST}${apiPath}?partner_id=${PARTNER_ID}&timestamp=${timestamp}&sign=${s}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      refresh_token: refreshToken,
      shop_id: Number(shopId),
      partner_id: Number(PARTNER_ID),
    }),
  });
  return res.json();
}

/** Lấy access_token hợp lệ cho shop (refresh nếu cần). Cache theo shopId. */
async function getAccessToken(shopId, tokenCache, tokens) {
  const key = String(shopId || "").trim();
  if (!key) return null;
  if (tokenCache.has(key)) return tokenCache.get(key);

  const record = tokens[key];
  if (!record?.access_token && !record?.refresh_token) {
    tokenCache.set(key, null);
    return null;
  }

  let accessToken = record.access_token || "";
  const obtainedAt = Number(record.obtained_at || 0);
  const expireIn = Number(record.expire_in || 0);
  const expired =
    !accessToken ||
    (obtainedAt > 0 && expireIn > 0 && Date.now() / 1000 > obtainedAt + expireIn - 300);

  if (expired && record.refresh_token) {
    try {
      const refreshed = await refreshAccessToken(key, record.refresh_token);
      if (refreshed?.access_token) {
        accessToken = refreshed.access_token;
        tokens[key] = {
          ...record,
          access_token: refreshed.access_token,
          refresh_token: refreshed.refresh_token || record.refresh_token,
          expire_in: refreshed.expire_in || record.expire_in,
          obtained_at: Math.floor(Date.now() / 1000),
        };
        saveTokens(tokens);
        console.log(`[Token] Đã refresh access_token cho shop_id=${key}`);
      } else {
        console.warn(`[Token] Refresh thất bại shop_id=${key}:`, refreshed?.error || refreshed?.message || refreshed);
      }
    } catch (err) {
      console.warn(`[Token] Refresh exception shop_id=${key}:`, err?.message || err);
    }
  }

  const ok = accessToken || null;
  tokenCache.set(key, ok);
  return ok;
}

async function getTrackingNumber(shopId, accessToken, orderSn, packageNumber) {
  const apiPath = "/api/v2/logistics/get_tracking_number";
  const timestamp = Math.floor(Date.now() / 1000);
  const params = new URLSearchParams({
    partner_id: PARTNER_ID,
    timestamp: String(timestamp),
    access_token: accessToken,
    shop_id: String(shopId),
    sign: sign(apiPath, timestamp, accessToken, shopId),
    order_sn: orderSn,
    response_optional_fields: "plp_number,first_mile_tracking_number,last_mile_tracking_number",
  });
  if (packageNumber) params.set("package_number", String(packageNumber));

  const res = await fetch(`${HOST}${apiPath}?${params.toString()}`);
  const json = await res.json();
  return { httpStatus: res.status, json };
}

function pickTrackingFromResponse(json) {
  const resp = json?.response || json;
  const candidates = [
    resp?.tracking_number,
    resp?.tracking_no,
    resp?.last_mile_tracking_number,
    resp?.third_party_tracking_number,
    resp?.courier_tracking_number,
    json?.tracking_number,
  ];
  for (const c of candidates) {
    const tn = String(c || "").trim();
    if (tn) return tn;
  }
  return "";
}

function orderSnOf(doc) {
  return String(doc?.orderSn || doc?.data?.orderSn || doc?._id || "")
    .replace(/^shopee-/i, "")
    .trim();
}

function shopIdOf(doc) {
  return String(doc?.shopId || doc?.data?.shopId || "").trim();
}

function packageNumberOf(doc) {
  return String(
    doc?.data?.packageNumber ||
      doc?.data?.package_number ||
      doc?.packageNumber ||
      doc?.package_number ||
      "",
  ).trim();
}

/** Đơn thiếu mã vận đơn (tracking_no null / thiếu / chuỗi rỗng). */
function missingTrackingFilter() {
  return {
    $and: [
      {
        $or: [
          { orderSn: { $exists: true, $nin: [null, ""] } },
          { "data.orderSn": { $exists: true, $nin: [null, ""] } },
        ],
      },
      {
        $or: [
          { tracking_no: null },
          { tracking_no: "" },
          { tracking_no: { $exists: false } },
        ],
      },
    ],
  };
}

async function updateTrackingInDb(col, doc, trackingNo) {
  const sn = orderSnOf(doc);
  const tn = String(trackingNo).trim();
  if (!sn || !tn) return false;

  const filter = {
    $or: [
      { _id: doc._id },
      { orderSn: sn },
      { "data.orderSn": sn },
      { _id: `shopee-${sn}` },
    ],
  };
  const $set = {
    tracking_no: tn,
    "data.tracking_no": tn,
    "data.trackingNumber": tn,
  };
  const result = await col.updateOne(filter, { $set });
  return result.modifiedCount > 0 || result.matchedCount > 0;
}

/** Đồng bộ mã vào data/orders.json (API/UI đọc file này). */
function updateTrackingInOrdersJson(orderSn, trackingNo) {
  const sn = String(orderSn || "").trim();
  const tn = String(trackingNo || "").trim();
  if (!sn || !tn || !fs.existsSync(ORDERS_JSON_PATH)) return false;
  try {
    const raw = fs.readFileSync(ORDERS_JSON_PATH, "utf8");
    const orders = raw.trim() ? JSON.parse(raw) : [];
    if (!Array.isArray(orders)) return false;
    let hit = false;
    for (const o of orders) {
      const osn = String(o?.orderSn || o?.id || "")
        .replace(/^shopee-/i, "")
        .trim();
      if (osn !== sn) continue;
      o.tracking_no = tn;
      o.trackingNumber = tn;
      hit = true;
    }
    if (!hit) return false;
    fs.writeFileSync(ORDERS_JSON_PATH, JSON.stringify(orders), "utf8");
    return true;
  } catch (err) {
    console.warn(`[JSON] Không ghi được orders.json cho ${sn}:`, err?.message || err);
    return false;
  }
}

/**
 * Sau khi sync Mongo: hydrate toàn bộ tracking_no Mongo → orders.json (1 lần).
 */
async function hydrateOrdersJsonFromMongo(col) {
  if (!fs.existsSync(ORDERS_JSON_PATH)) {
    console.log("[JSON] Bỏ qua hydrate — không có data/orders.json");
    return 0;
  }
  let orders;
  try {
    const raw = fs.readFileSync(ORDERS_JSON_PATH, "utf8");
    orders = raw.trim() ? JSON.parse(raw) : [];
  } catch (err) {
    console.warn("[JSON] Đọc orders.json lỗi:", err?.message || err);
    return 0;
  }
  if (!Array.isArray(orders) || orders.length === 0) return 0;

  const docs = await col
    .find({
      $or: [
        { tracking_no: { $exists: true, $nin: [null, ""] } },
        { "data.tracking_no": { $exists: true, $nin: [null, ""] } },
        { "data.trackingNumber": { $exists: true, $nin: [null, ""] } },
      ],
    })
    .project({
      orderSn: 1,
      tracking_no: 1,
      "data.orderSn": 1,
      "data.tracking_no": 1,
      "data.trackingNumber": 1,
    })
    .toArray();

  const map = new Map();
  for (const d of docs) {
    const sn = String(d.orderSn || d.data?.orderSn || "")
      .replace(/^shopee-/i, "")
      .trim();
    const tn = String(d.tracking_no || d.data?.tracking_no || d.data?.trackingNumber || "").trim();
    if (sn && tn && !/^0FG/i.test(tn)) map.set(sn, tn);
  }

  let filled = 0;
  for (const o of orders) {
    const sn = String(o?.orderSn || o?.id || "")
      .replace(/^shopee-/i, "")
      .trim();
    if (!sn) continue;
    const existing = String(o.trackingNumber || o.tracking_no || "").trim();
    if (existing && !/^0FG/i.test(existing)) continue;
    const tn = map.get(sn);
    if (!tn) continue;
    o.trackingNumber = tn;
    o.tracking_no = tn;
    filled++;
  }

  if (filled > 0) {
    const bak = `${ORDERS_JSON_PATH}.bak-tracking-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.copyFileSync(ORDERS_JSON_PATH, bak);
    fs.writeFileSync(ORDERS_JSON_PATH, JSON.stringify(orders), "utf8");
    console.log(`[JSON] Hydrate tracking Mongo → orders.json: ${filled} đơn (backup: ${path.basename(bak)})`);
  } else {
    console.log("[JSON] Hydrate: không có đơn nào cần bổ sung tracking vào orders.json");
  }
  return filled;
}

async function main() {
  console.log("=== SYNC MISSING TRACKING (quét cạn get_tracking_number) ===");

  if (!URI) {
    console.error("Thiếu MONGODB_URI / MONGO_URL trong .env");
    process.exit(1);
  }

  const hydrateOnly = hasFlag("hydrate-only");
  const dryRun = hasFlag("dry-run");
  const limitArg = arg("limit");
  const limit = limitArg ? Math.max(1, Number(limitArg) || 0) : 0;
  const shopFilter = String(arg("shop") || "").trim();

  await mongoose.connect(URI, { serverSelectionTimeoutMS: 20000 });
  const col = mongoose.connection.db.collection("orders");

  // Chỉ đổ tracking Mongo → orders.json (không gọi Shopee API).
  if (hydrateOnly) {
    const hydrated = await hydrateOrdersJsonFromMongo(col);
    console.log(`[DONE] hydrate-only: ${hydrated} đơn → data/orders.json`);
    await mongoose.disconnect();
    return;
  }

  if (!PARTNER_ID || !PARTNER_KEY) {
    console.error("Thiếu SHOPEE_PARTNER_ID / SHOPEE_PARTNER_KEY trong .env");
    process.exit(1);
  }

  const tokens = loadTokens();
  const shopKeys = Object.keys(tokens);
  if (shopKeys.length === 0) {
    console.error(`Không có token trong ${TOKENS_PATH}. Cần OAuth shop trước.`);
    process.exit(1);
  }
  console.log(`[Token] Shop có sẵn: [${shopKeys.join(", ")}]`);
  if (dryRun) console.log("[Mode] DRY-RUN — chỉ gọi API, không UPDATE DB");

  const filter = missingTrackingFilter();
  if (shopFilter) {
    filter.$and.push({
      $or: [{ shopId: shopFilter }, { "data.shopId": shopFilter }],
    });
  }

  let cursor = col.find(filter).project({
    _id: 1,
    orderSn: 1,
    shopId: 1,
    tracking_no: 1,
    status: 1,
    "data.orderSn": 1,
    "data.shopId": 1,
    "data.tracking_no": 1,
    "data.trackingNumber": 1,
    "data.packageNumber": 1,
    "data.package_number": 1,
    "data.channel": 1,
    "data.shopee_order_status": 1,
  });
  if (limit > 0) cursor = cursor.limit(limit);

  const docs = await cursor.toArray();
  // Lọc thêm phía JS: tracking thực sự rỗng (tránh edge case whitespace)
  const orders = docs.filter((d) => {
    const tn = String(d.tracking_no || d.data?.tracking_no || d.data?.trackingNumber || "").trim();
    return !tn && orderSnOf(d);
  });

  const total = orders.length;
  console.log(`[DB] Tìm thấy ${total} đơn thiếu tracking_no${limit > 0 ? ` (limit=${limit})` : ""}`);
  if (total === 0) {
    console.log("Không có đơn nào cần xử lý. Kết thúc.");
    await mongoose.disconnect();
    return;
  }

  const tokenCache = new Map();
  let updated = 0;
  let skippedEmpty = 0;
  let skippedNoToken = 0;
  let failed = 0;

  for (let i = 0; i < total; i++) {
    const doc = orders[i];
    const sn = orderSnOf(doc);
    const shopId = shopIdOf(doc) || shopKeys[0];
    const pkg = packageNumberOf(doc);
    const prefix = `Đang xử lý đơn ${i + 1}/${total}: ${sn}`;

    try {
      const accessToken = await getAccessToken(shopId, tokenCache, tokens);
      if (!accessToken) {
        skippedNoToken++;
        console.log(`${prefix}... Thất bại: không có access_token (shop_id=${shopId})`);
        continue;
      }

      const { json } = await getTrackingNumber(shopId, accessToken, sn, pkg || undefined);
      if (json?.error && !json?.response) {
        failed++;
        console.log(
          `${prefix}... Thất bại: API error=${json.error} ${json.message || json.error_description || ""}`.trim(),
        );
      } else {
        const tn = pickTrackingFromResponse(json);
        if (!tn) {
          skippedEmpty++;
          console.log(`${prefix}... Thất bại: API trả về rỗng`);
        } else if (dryRun) {
          updated++;
          console.log(`${prefix}... [DRY-RUN] Có mã: ${tn} (chưa ghi DB)`);
        } else {
          const ok = await updateTrackingInDb(col, doc, tn);
          if (ok) {
            updateTrackingInOrdersJson(sn, tn);
            updated++;
            console.log(`${prefix}... Thành công! → ${tn}`);
          } else {
            failed++;
            console.log(`${prefix}... Thất bại: UPDATE DB không khớp document`);
          }
        }
      }
    } catch (err) {
      failed++;
      console.log(`${prefix}... Thất bại: ${err?.message || err}`);
    }

    // BẮT BUỘC delay 500ms giữa mỗi lần gọi API
    if (i < total - 1) await delay(DELAY_MS);
  }

  console.log("\n========== TỔNG KẾT ==========");
  console.log(`Tổng đơn quét:     ${total}`);
  console.log(`Đã cập nhật:       ${updated}`);
  console.log(`API trả rỗng:      ${skippedEmpty}`);
  console.log(`Thiếu token shop:  ${skippedNoToken}`);
  console.log(`Lỗi khác:          ${failed}`);
  console.log("==============================\n");

  // Đảm bảo orders.json (nguồn API/UI) nhận đủ mã đã có trên Mongo.
  if (!dryRun) {
    try {
      const hydrated = await hydrateOrdersJsonFromMongo(col);
      console.log(`[JSON] Tổng hydrate orders.json: ${hydrated}`);
    } catch (err) {
      console.warn("[JSON] hydrateOrdersJsonFromMongo lỗi:", err?.message || err);
    }
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("[FATAL]", err);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
