#!/usr/bin/env node
/**
 * Backfill sản phẩm cho đơn CANCELLED đang items=[] (30 ngày).
 * Chỉ $set data.items — không đụng cờ kho.
 *
 *   node scripts/backfill_cancelled_empty_items.js
 *   node scripts/backfill_cancelled_empty_items.js --limit=20
 *   node scripts/backfill_cancelled_empty_items.js --shop=4127421
 *   node scripts/backfill_cancelled_empty_items.js --dry-run
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
const DELAY_MS = 500;
const DEADLINE_MS = 75_000;
const LOOKBACK_DAYS = 30;
const DEFAULT_LIMIT = 20;
const HARD_CAP = 40;

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
function shopKey(shopId) {
  const key = String(shopId ?? "").trim();
  return /^\d+$/.test(key) ? key : "";
}
function unixNow() {
  return Math.floor(Date.now() / 1000);
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
    const parsed = JSON.parse(fs.readFileSync(TOKENS_PATH, "utf8"));
    if (Array.isArray(parsed)) {
      const map = {};
      for (const row of parsed) {
        const k = shopKey(row?.shop_id ?? row?.shopId);
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

async function refreshAccessToken(shopId, refreshToken) {
  const apiPath = "/api/v2/auth/access_token/get";
  const timestamp = unixNow();
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

async function resolveAccessToken(shopId, tokens) {
  const rec = tokens[shopId];
  if (!rec) return "";
  let accessToken = String(rec.access_token || "");
  const obtainedAt = Number(rec.obtained_at || 0);
  const expireIn = Number(rec.expire_in || 14400);
  const expired = !accessToken || (obtainedAt > 0 && unixNow() - obtainedAt >= expireIn - 60);
  if ((expired || !accessToken) && rec.refresh_token) {
    try {
      const refreshed = await refreshAccessToken(shopId, rec.refresh_token);
      if (refreshed?.access_token) {
        accessToken = refreshed.access_token;
        tokens[shopId] = {
          ...rec,
          access_token: refreshed.access_token,
          refresh_token: refreshed.refresh_token || rec.refresh_token,
          expire_in: refreshed.expire_in || rec.expire_in,
          obtained_at: unixNow(),
        };
        saveTokens(tokens);
      }
    } catch (err) {
      console.warn(`[token] refresh fail shop=${shopId}`, err?.message || err);
    }
  }
  return accessToken;
}

function mapItem(it, orderStatus) {
  if (!it || typeof it !== "object") return null;
  const purchasedQty = Math.max(
    1,
    Number(it.model_quantity_purchased ?? it.model_quantity ?? it.quantity ?? 1) || 1,
  );
  const cancelledQty = Math.max(0, Number(it.cancelled_qty ?? it.cancelledQty) || 0);
  const activeQty = Math.max(0, purchasedQty - cancelledQty);
  const raw = String(orderStatus || "").toUpperCase();
  const isFullCancel = raw === "CANCELLED" || raw === "IN_CANCEL";
  if (activeQty <= 0 && cancelledQty > 0 && !isFullCancel) return null;
  const itemName = String(it.item_name || "Sản phẩm Shopee").trim();
  const modelName = String(it.model_name || "").trim();
  return {
    productId: String(it.item_id || ""),
    productTitle: modelName ? `${itemName} - ${modelName}` : itemName,
    productImage: it?.image_info?.image_url || it?.image_url || undefined,
    quantity: isFullCancel ? purchasedQty : activeQty > 0 ? activeQty : purchasedQty,
    originalQuantity: purchasedQty,
    cancelledQty: isFullCancel ? Math.max(cancelledQty, purchasedQty) : cancelledQty,
    cancelled: isFullCancel || (activeQty <= 0 && cancelledQty > 0),
    price: Number(it.model_discounted_price || it.model_original_price || it.item_price || 0) || 0,
    modelId: it.model_id != null ? String(it.model_id) : undefined,
    modelSku: it.model_sku ? String(it.model_sku) : undefined,
    modelName: modelName || undefined,
  };
}

async function main() {
  const dryRun = hasFlag("dry-run");
  const limit = Math.max(1, Math.min(HARD_CAP, Number(arg("limit")) || DEFAULT_LIMIT));
  const onlyShop = shopKey(arg("shop"));
  if (!URI) {
    console.error("Missing MONGODB_URI");
    process.exit(1);
  }
  if (!PARTNER_ID || !PARTNER_KEY) {
    console.error("Missing SHOPEE_PARTNER_ID / SHOPEE_PARTNER_KEY");
    process.exit(1);
  }

  await mongoose.connect(URI, { serverSelectionTimeoutMS: 12_000 });
  const col = mongoose.connection.collection("orders");
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const sinceIso = since.toISOString();
  const filter = {
    $and: [
      {
        $or: [
          { shopee_order_status: { $in: ["CANCELLED", "IN_CANCEL"] } },
          { "data.shopee_order_status": { $in: ["CANCELLED", "IN_CANCEL"] } },
          { status: "cancelled" },
          { "data.status": "cancelled" },
        ],
      },
      {
        $or: [
          { "data.items": { $exists: false } },
          { "data.items": { $size: 0 } },
          { "data.items": null },
        ],
      },
      {
        $or: [
          { "data.date": { $gte: sinceIso } },
          { last_shopee_update_at: { $gte: since } },
          { last_synced_at: { $gte: since } },
        ],
      },
    ],
  };
  if (onlyShop) {
    filter.$and.push({
      $or: [{ shopId: onlyShop }, { "data.shopId": onlyShop }],
    });
  }

  const docs = await col
    .find(filter, {
      projection: { orderSn: 1, shopId: 1, "data.orderSn": 1, "data.shopId": 1 },
      maxTimeMS: 8000,
    })
    .sort({ last_shopee_update_at: -1, _id: -1 })
    .limit(limit)
    .toArray();

  console.log(`[backfill] candidates=${docs.length} limit=${limit} dryRun=${dryRun}`);
  const tokens = loadTokens();
  const startedAt = Date.now();
  let filled = 0;
  let errors = 0;

  for (let i = 0; i < docs.length; i += 1) {
    if (Date.now() - startedAt >= DEADLINE_MS) {
      console.log("[backfill] deadline reached — stop");
      break;
    }
    const doc = docs[i];
    const orderSn = String(doc?.orderSn || doc?.data?.orderSn || "")
      .replace(/^shopee-/i, "")
      .trim();
    const shopId = shopKey(doc?.shopId || doc?.data?.shopId);
    if (!orderSn || !shopId) continue;
    const accessToken = await resolveAccessToken(shopId, tokens);
    if (!accessToken) {
      errors += 1;
      console.warn(`[backfill] no token shop=${shopId} sn=${orderSn}`);
      continue;
    }
    const timestamp = unixNow();
    const apiPath = "/api/v2/order/get_order_detail";
    const s = sign(apiPath, timestamp, accessToken, shopId);
    const params = new URLSearchParams({
      partner_id: PARTNER_ID,
      timestamp: String(timestamp),
      access_token: accessToken,
      shop_id: shopId,
      sign: s,
      order_sn_list: orderSn,
      response_optional_fields: "item_list,package_list,cancel_reason,buyer_cancel_reason,cancel_by",
    });
    let json;
    try {
      const res = await fetch(`${HOST}${apiPath}?${params.toString()}`);
      json = await res.json();
    } catch (err) {
      errors += 1;
      console.warn(`[backfill] fetch fail sn=${orderSn}`, err?.message || err);
      await delay(DELAY_MS);
      continue;
    }
    if (json?.error) {
      errors += 1;
      console.warn(`[backfill] api error sn=${orderSn}`, json.error, json.message || "");
      await delay(DELAY_MS);
      continue;
    }
    const list = json?.response?.order_list || json?.order_list || [];
    const detail = Array.isArray(list)
      ? list.find((d) => String(d?.order_sn || "").trim() === orderSn) || list[0]
      : null;
    const itemList = Array.isArray(detail?.item_list) ? detail.item_list : [];
    const rawStatus = String(detail?.order_status || "CANCELLED").toUpperCase();
    const items = itemList.map((it) => mapItem(it, rawStatus)).filter(Boolean);
    if (!items.length) {
      console.log(`[backfill] skip empty detail sn=${orderSn}`);
      await delay(DELAY_MS);
      continue;
    }
    if (dryRun) {
      console.log(`[backfill] DRY sn=${orderSn} items=${items.length} title=${items[0].productTitle}`);
      filled += 1;
      await delay(DELAY_MS);
      continue;
    }
    const _id = `shopee-${orderSn}`;
    const result = await col.updateOne(
      { $or: [{ orderSn }, { _id }, { "data.orderSn": orderSn }] },
      {
        $set: {
          "data.items": items,
          last_synced_at: new Date(),
          "data.last_synced_at": new Date().toISOString(),
        },
      },
    );
    if ((result.modifiedCount || result.matchedCount) > 0) {
      filled += 1;
      console.log(`[backfill] OK sn=${orderSn} items=${items.length}`);
    }
    await delay(DELAY_MS);
  }

  console.log(`[backfill] done filled=${filled} errors=${errors} elapsed=${Date.now() - startedAt}ms`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("[backfill] FATAL", err?.message || err);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
