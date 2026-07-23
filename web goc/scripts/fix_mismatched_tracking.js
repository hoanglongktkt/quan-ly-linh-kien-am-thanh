#!/usr/bin/env node
/**
 * HEAL — chữa mã vận đơn gán nhầm (overwrite theo Shopee API).
 *
 *   node scripts/fix_mismatched_tracking.js
 *   node scripts/fix_mismatched_tracking.js --order=26072074RQM48G
 *   node scripts/fix_mismatched_tracking.js --order=XXX --dry-run
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
const DEFAULT_ORDER_SN = "26072074RQM48G";

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : "";
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function sign(apiPath, timestamp, accessToken, shopId) {
  const base = accessToken
    ? `${PARTNER_ID}${apiPath}${timestamp}${accessToken}${shopId}`
    : `${PARTNER_ID}${apiPath}${timestamp}`;
  return crypto.createHmac("sha256", PARTNER_KEY).update(base).digest("hex");
}

function normalizeShopIdKey(shopId) {
  const key = String(shopId ?? "").trim();
  return /^\d+$/.test(key) ? key : "";
}

function loadTokens() {
  if (!fs.existsSync(TOKENS_PATH)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(TOKENS_PATH, "utf8"));
    if (Array.isArray(parsed)) {
      const map = {};
      for (const row of parsed) {
        const k = normalizeShopIdKey(row?.shop_id ?? row?.shopId);
        if (k) map[k] = row;
      }
      return map;
    }
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveTokens(tokens) {
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2) + "\n", "utf8");
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

function resolveShopeeApiShopId(record, configuredShopId) {
  const configured = normalizeShopIdKey(configuredShopId);
  const recordKey = normalizeShopIdKey(record?.shop_id);
  if (recordKey === configured) return configured;
  const oauth = normalizeShopIdKey(record?.oauth_shop_id);
  if (oauth) return oauth;
  return recordKey || configured;
}

function listOAuthShopIds(tokens) {
  return Object.keys(tokens || {})
    .map(normalizeShopIdKey)
    .filter(Boolean)
    .sort();
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

async function getAccessToken(tokens, preferredShopId) {
  const keys = listOAuthShopIds(tokens);
  if (keys.length === 0) return null;
  const key =
    (preferredShopId && getShopeeTokenRecord(tokens, preferredShopId)
      ? normalizeShopIdKey(preferredShopId)
      : "") || keys[0];
  const record = getShopeeTokenRecord(tokens, key) || tokens[key];
  if (!record) return null;
  const apiShopId = resolveShopeeApiShopId(record, key);
  let accessToken = record.access_token || "";
  const obtainedAt = Number(record.obtained_at || 0);
  const expireIn = Number(record.expire_in || 14400);
  const now = Math.floor(Date.now() / 1000);
  const expired = !accessToken || (obtainedAt > 0 && now - obtainedAt >= expireIn - 60);

  if (expired && record.refresh_token) {
    const refreshed = await refreshAccessToken(apiShopId, record.refresh_token);
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
    }
  }
  return accessToken ? { accessToken, apiShopId, fileKey: key } : null;
}

async function shopeeGet(apiPath, shopId, accessToken, extra = {}) {
  const timestamp = Math.floor(Date.now() / 1000);
  const params = new URLSearchParams({
    partner_id: PARTNER_ID,
    timestamp: String(timestamp),
    access_token: accessToken,
    shop_id: String(shopId),
    sign: sign(apiPath, timestamp, accessToken, shopId),
  });
  for (const [k, v] of Object.entries(extra)) {
    if (v != null && v !== "") params.set(k, String(v));
  }
  const res = await fetch(`${HOST}${apiPath}?${params.toString()}`);
  const json = await res.json();
  return { httpStatus: res.status, json };
}

function inferCarrierFromFields(shippingCarrier, trackingNo) {
  const carrier = String(shippingCarrier || "").trim();
  if (carrier) return carrier;
  const tn = String(trackingNo || "").trim().toUpperCase();
  if (/^GYA/.test(tn) || /^GHN/.test(tn)) return "Giao Hàng Nhanh";
  if (/^SPX/.test(tn)) return "SPX Express";
  return "";
}

function pickTracking(detail, trackJson) {
  const pkg = Array.isArray(detail?.package_list) ? detail.package_list[0] : null;
  const resp = trackJson?.response || trackJson || {};
  const candidates = [
    resp?.tracking_number,
    resp?.tracking_no,
    resp?.last_mile_tracking_number,
    resp?.third_party_tracking_number,
    pkg?.tracking_number,
    pkg?.tracking_no,
    detail?.tracking_number,
    detail?.tracking_no,
  ];
  for (const c of candidates) {
    const tn = String(c || "").trim();
    if (tn && !/^0FG/i.test(tn)) return tn;
  }
  return "";
}

function updateOrdersJson(orderSn, trackingNo, carrier) {
  if (!fs.existsSync(ORDERS_JSON_PATH)) return false;
  try {
    const orders = JSON.parse(fs.readFileSync(ORDERS_JSON_PATH, "utf8"));
    if (!Array.isArray(orders)) return false;
    let hit = false;
    for (const o of orders) {
      const sn = String(o?.orderSn || o?.id || "")
        .replace(/^shopee-/i, "")
        .trim();
      if (sn !== orderSn) continue;
      o.tracking_no = trackingNo;
      o.trackingNumber = trackingNo;
      if (carrier) {
        o.shipping_carrier = carrier;
        o.carrier = carrier;
      }
      hit = true;
    }
    if (!hit) return false;
    fs.writeFileSync(ORDERS_JSON_PATH, JSON.stringify(orders), "utf8");
    return true;
  } catch (err) {
    console.warn("[JSON] update failed:", err?.message || err);
    return false;
  }
}

async function main() {
  const orderSn = String(arg("order") || DEFAULT_ORDER_SN)
    .replace(/^shopee-/i, "")
    .trim();
  const dryRun = hasFlag("dry-run");

  console.log(`=== FIX MISMATCHED TRACKING order_sn=${orderSn} ===`);
  if (!URI) {
    console.error("Thiếu MONGODB_URI / MONGO_URL");
    process.exit(1);
  }
  if (!PARTNER_ID || !PARTNER_KEY) {
    console.error("Thiếu SHOPEE_PARTNER_ID / SHOPEE_PARTNER_KEY");
    process.exit(1);
  }

  await mongoose.connect(URI, { serverSelectionTimeoutMS: 20000 });
  const col = mongoose.connection.db.collection("orders");

  const doc = await col.findOne({
    $or: [
      { orderSn },
      { "data.orderSn": orderSn },
      { _id: `shopee-${orderSn}` },
    ],
  });
  const shopFromDb = normalizeShopIdKey(doc?.shopId || doc?.data?.shopId);
  const beforeTn = String(
    doc?.tracking_no || doc?.data?.tracking_no || doc?.data?.trackingNumber || "",
  ).trim();
  const beforeCarrier = String(
    doc?.shipping_carrier || doc?.data?.shipping_carrier || doc?.carrier || "",
  ).trim();
  console.log(`[DB] before tracking_no=${beforeTn || "(empty)"} carrier=${beforeCarrier || "(empty)"}`);

  const tokens = loadTokens();
  const tokenInfo = await getAccessToken(tokens, shopFromDb);
  if (!tokenInfo?.accessToken) {
    console.error("Không lấy được access_token Shopee");
    process.exit(1);
  }
  const { accessToken, apiShopId } = tokenInfo;

  const detailRes = await shopeeGet("/api/v2/order/get_order_detail", apiShopId, accessToken, {
    order_sn_list: orderSn,
    response_optional_fields:
      "buyer_user_id,item_list,total_amount,shipping_carrier,package_list,checkout_shipping_carrier",
  });
  const detailList =
    detailRes.json?.response?.order_list || detailRes.json?.order_list || [];
  // BẮT BUỘC map theo order_sn — không dùng index mảng.
  const detail = Array.isArray(detailList)
    ? detailList.find((d) => String(d?.order_sn || "").trim() === orderSn)
    : null;
  if (!detail) {
    console.error(
      "[Shopee] get_order_detail không trả đơn khớp order_sn=",
      orderSn,
      JSON.stringify(detailRes.json)?.slice(0, 400),
    );
    process.exit(1);
  }

  const pkg = Array.isArray(detail.package_list) ? detail.package_list[0] : null;
  const packageNumber = String(pkg?.package_number || doc?.data?.packageNumber || "").trim();

  const trackRes = await shopeeGet("/api/v2/logistics/get_tracking_number", apiShopId, accessToken, {
    order_sn: orderSn,
    ...(packageNumber ? { package_number: packageNumber } : {}),
    response_optional_fields: "plp_number,first_mile_tracking_number,last_mile_tracking_number",
  });

  const trackingNo = pickTracking(detail, trackRes.json);
  const shippingCarrier = String(
    detail.shipping_carrier ||
      pkg?.shipping_carrier ||
      detail.checkout_shipping_carrier ||
      pkg?.checkout_shipping_carrier ||
      "",
  ).trim();
  const carrier = inferCarrierFromFields(shippingCarrier, trackingNo);

  if (!trackingNo) {
    console.error("[Shopee] Không lấy được tracking_number:", JSON.stringify(trackRes.json)?.slice(0, 500));
    process.exit(1);
  }

  console.log(`[Shopee] order_sn=${orderSn} → tracking_no=${trackingNo} carrier=${carrier || "(infer empty)"}`);

  if (dryRun) {
    console.log("[DRY-RUN] Không ghi DB");
    await mongoose.disconnect();
    return;
  }

  const $set = {
    tracking_no: trackingNo,
    "data.tracking_no": trackingNo,
    "data.trackingNumber": trackingNo,
  };
  if (carrier) {
    $set.shipping_carrier = carrier;
    $set.carrier = carrier;
    $set["data.shipping_carrier"] = carrier;
    $set["data.carrier"] = carrier;
  }
  if (shippingCarrier && shippingCarrier !== carrier) {
    $set.checkout_shipping_carrier = shippingCarrier;
    $set["data.checkout_shipping_carrier"] = shippingCarrier;
  }

  const filter = {
    $or: [
      { _id: doc?._id },
      { orderSn },
      { "data.orderSn": orderSn },
      { _id: `shopee-${orderSn}` },
    ].filter((x) => x._id != null || x.orderSn || x["data.orderSn"]),
  };
  const result = await col.updateOne(filter, { $set }, { upsert: false });
  const jsonOk = updateOrdersJson(orderSn, trackingNo, carrier);

  console.log(
    `[DONE] Mongo matched=${result.matchedCount} modified=${result.modifiedCount} | orders.json=${jsonOk ? "OK" : "skip/miss"}`,
  );
  console.log(`[DONE] ${beforeTn || "(empty)"} → ${trackingNo} | carrier → ${carrier}`);
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
