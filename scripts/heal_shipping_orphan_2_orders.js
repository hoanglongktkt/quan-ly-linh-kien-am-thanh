#!/usr/bin/env node
/**
 * HEAL — 2 đơn orphan status=shipping + raw=PROCESSED → Shopee SHIPPED/PICKUP_DONE.
 * node scripts/heal_shipping_orphan_2_orders.js
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
const SNS = ["260909GXJ30VUN", "260908GU10U7EJ"];

function normalizeShopIdKey(shopId) {
  const key = String(shopId ?? "").trim();
  return /^\d+$/.test(key) ? key : "";
}

function sign(apiPath, timestamp, accessToken, shopId) {
  const base = accessToken
    ? `${PARTNER_ID}${apiPath}${timestamp}${accessToken}${shopId}`
    : `${PARTNER_ID}${apiPath}${timestamp}`;
  return crypto.createHmac("sha256", PARTNER_KEY).update(base).digest("hex");
}

function loadTokens() {
  return JSON.parse(fs.readFileSync(TOKENS_PATH, "utf8"));
}

function saveTokens(tokens) {
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2) + "\n", "utf8");
}

async function refreshAccessToken(shopId, refreshToken) {
  const apiPath = "/api/v2/auth/access_token/get";
  const timestamp = Math.floor(Date.now() / 1000);
  const url = `${HOST}${apiPath}?partner_id=${PARTNER_ID}&timestamp=${timestamp}&sign=${sign(apiPath, timestamp)}`;
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

async function ensureToken(tokens, shopId) {
  const key = normalizeShopIdKey(shopId);
  const record = tokens[key];
  if (!record?.refresh_token && !record?.access_token) return null;
  const obtainedAt = Number(record.obtained_at || 0);
  const expireIn = Number(record.expire_in || 14400);
  const now = Math.floor(Date.now() / 1000);
  const expired = !record.access_token || obtainedAt === 0 || now - obtainedAt >= expireIn - 60;
  if (expired && record.refresh_token) {
    const refreshed = await refreshAccessToken(key, record.refresh_token);
    if (!refreshed?.access_token) {
      console.error("[auth] refresh failed", refreshed?.error, refreshed?.message);
      return null;
    }
    tokens[key] = {
      ...record,
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token || record.refresh_token,
      expire_in: refreshed.expire_in || record.expire_in,
      obtained_at: now,
    };
    saveTokens(tokens);
  }
  return { accessToken: tokens[key].access_token, apiShopId: key };
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
  const res = await fetch(`${HOST}${apiPath}?${params}`);
  return res.json();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  if (!URI || !PARTNER_ID || !PARTNER_KEY) {
    console.error("Thiếu MONGODB_URI / SHOPEE credentials");
    process.exit(1);
  }
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 20000 });
  const col = mongoose.connection.db.collection("orders");
  const tokens = loadTokens();
  const auth = await ensureToken(tokens, "4127421");
  if (!auth?.accessToken) {
    console.error("Không lấy được access_token");
    process.exit(1);
  }

  console.log("=== HEAL 2 SHIPPING ORPHANS ===");
  for (const orderSn of SNS) {
    const json = await shopeeGet(
      "/api/v2/order/get_order_detail",
      auth.apiShopId,
      auth.accessToken,
      {
        order_sn_list: orderSn,
        response_optional_fields:
          "package_list,shipping_carrier,checkout_shipping_carrier,pickup_done_time,fulfillment_flag",
      },
    );
    const detail = (json?.response?.order_list || []).find(
      (o) => String(o.order_sn) === orderSn,
    );
    if (!detail) {
      console.error(orderSn, "detail miss", json?.error, json?.message);
      await sleep(400);
      continue;
    }
    const pkg = Array.isArray(detail.package_list) ? detail.package_list[0] : null;
    const raw = String(detail.order_status || "").toUpperCase();
    const logistics = String(pkg?.logistics_status || "").toUpperCase();
    const carrier = String(
      detail.shipping_carrier || pkg?.shipping_carrier || "SPX Express",
    ).trim();
    const tracking = String(pkg?.tracking_number || "").trim();
    const packageNumber = String(pkg?.package_number || "").trim();
    const updateAt = detail.update_time
      ? new Date(Number(detail.update_time) * 1000)
      : new Date();
    const localStatus =
      raw === "COMPLETED"
        ? "completed"
        : raw === "SHIPPED" || raw === "TO_CONFIRM_RECEIVE"
          ? "shipping"
          : "processed";

    const now = new Date();
    const $set = {
      status: localStatus,
      shopee_order_status: raw,
      logistics_status: logistics || undefined,
      is_handed_over: false,
      is_pending_shopee_check: false,
      last_synced_at: now,
      last_shopee_update_at: updateAt,
      shipping_carrier: carrier || undefined,
      "data.status": localStatus,
      "data.shopee_order_status": raw,
      "data.logistics_status": logistics || undefined,
      "data.is_handed_over": false,
      "data.isHandedOverToCarrier": false,
      "data.is_handed_over_to_carrier": false,
      "data.is_handed_over_to_courier": false,
      "data.local_status": "NONE",
      "data.localStatus": "NONE",
      "data.internal_status": "NONE",
      "data.is_pending_shopee_check": false,
      "data.last_synced_at": now.toISOString(),
      "data.last_shopee_update_at": updateAt.toISOString(),
      "data.shipping_carrier": carrier || undefined,
      "data.isPrepared": true,
    };
    if (tracking && !/^0FG/i.test(tracking)) {
      $set.tracking_no = tracking;
      $set.trackingNumber = tracking;
      $set["data.tracking_no"] = tracking;
      $set["data.trackingNumber"] = tracking;
    }
    if (packageNumber) {
      $set["data.package_number"] = packageNumber;
      $set["data.packageNumber"] = packageNumber;
    }
    // drop undefined
    for (const k of Object.keys($set)) {
      if ($set[k] === undefined) delete $set[k];
    }

    const result = await col.updateOne(
      {
        $or: [
          { orderSn },
          { "data.orderSn": orderSn },
          { _id: `shopee-${orderSn}` },
        ],
      },
      { $set },
    );
    console.log(
      JSON.stringify(
        {
          orderSn,
          shopee_raw: raw,
          logistics,
          localStatus,
          matched: result.matchedCount,
          modified: result.modifiedCount,
        },
        null,
        2,
      ),
    );
    await sleep(500);
  }

  // verify
  for (const orderSn of SNS) {
    const doc = await col.findOne({ orderSn });
    console.log("VERIFY", {
      orderSn,
      status: doc?.status,
      raw: doc?.shopee_order_status,
      logistics: doc?.logistics_status || doc?.data?.logistics_status,
    });
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
