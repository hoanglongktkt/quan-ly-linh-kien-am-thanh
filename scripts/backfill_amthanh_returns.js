#!/usr/bin/env node
/**
 * Backfill get_return_list 30 ngày cho shop Âm thanh (LKAT 4127421)
 * + heal đơn CANCELLED bị gắn RTS chỉ vì có tracking_no.
 *
 *   node scripts/backfill_amthanh_returns.js
 *   node scripts/backfill_amthanh_returns.js --shop=4127421
 *   node scripts/backfill_amthanh_returns.js --dry-run
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
const DEFAULT_SHOP = "4127421";
const LOOKBACK_SEC = 30 * 24 * 60 * 60;
const WINDOW_SEC = 15 * 24 * 60 * 60;
const PAGE_SIZE = 100;
const MAX_PAGES = 50;
const DELAY_MS = 400;
const RTS_RE =
  /FAILED[_\s-]?DELIVERY|UNDELIVERABLE|PARCEL[_\s-]?LOST|PARCEL\s+IS\s+LOST|COD[_\s-]?REJECTED|COD[_\s-]?NOT[_\s-]?SUPPORTED/;

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
function toSn(raw) {
  return String(raw || "").replace(/^shopee-/i, "").trim();
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
        console.log(`[token] refreshed shop=${shopId}`);
      } else {
        console.warn(`[token] refresh fail shop=${shopId}`, refreshed?.error || refreshed?.message || "");
      }
    } catch (err) {
      console.warn(`[token] refresh exception shop=${shopId}`, err?.message || err);
    }
  }
  return accessToken;
}

async function shopeeGet(apiPath, shopId, accessToken, extra) {
  const timestamp = unixNow();
  const s = sign(apiPath, timestamp, accessToken, shopId);
  const params = new URLSearchParams({
    partner_id: PARTNER_ID,
    timestamp: String(timestamp),
    access_token: accessToken,
    shop_id: String(shopId),
    sign: s,
    ...extra,
  });
  const res = await fetch(`${HOST}${apiPath}?${params.toString()}`);
  return res.json();
}

function isCarrierRts(order) {
  const log = String(order.logistics_status || "").toUpperCase();
  if (log.includes("REQUEST_CANCELED") || log.includes("REQUEST_CANCELLED")) return false;
  if (
    log.includes("LOGISTICS_DELIVERY_FAILED") ||
    log.includes("LOGISTICS_LOST") ||
    log.includes("LOGISTICS_COD_REJECTED") ||
    (log.includes("DELIVERY_FAILED") && !log.includes("PICKUP"))
  ) {
    return true;
  }
  const blob = `${order.cancel_reason || ""} ${order.buyer_cancel_reason || ""}`.toUpperCase();
  return Boolean(blob) && RTS_RE.test(blob);
}

async function paginateReturnList(shopId, accessToken, timeFrom, timeTo, out) {
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const extra = {
      page_no: String(page),
      page_size: String(PAGE_SIZE),
      update_time_from: String(timeFrom),
      update_time_to: String(timeTo),
    };
    const json = await shopeeGet("/api/v2/returns/get_return_list", shopId, accessToken, extra);
    if (json?.error) {
      console.warn(`[return] shop=${shopId} page=${page} err=${json.error} ${json.message || ""}`);
      break;
    }
    const rows = json?.response?.return || json?.response?.return_list || json?.return || [];
    for (const row of rows) {
      const sn = toSn(row?.order_sn || row?.orderSn);
      const rsn = String(row?.return_sn || row?.returnSn || "").trim();
      if (sn && rsn) out.set(sn, { returnSn: rsn, status: String(row?.status || ""), raw: row });
    }
    const more = Boolean(json?.response?.more ?? json?.more);
    console.log(`[return] shop=${shopId} page=${page} rows=${rows.length} map=${out.size} more=${more}`);
    if (!more || rows.length === 0) break;
    await delay(DELAY_MS);
  }
}

async function healFalseRts(Order, shopId, dryRun) {
  const shopFilter = shopId
    ? {
        $or: [
          { shopId },
          { shopId: Number(shopId) },
          { "data.shopId": shopId },
          { "data.shopId": Number(shopId) },
        ],
      }
    : null;
  const docs = await Order.find({
    $and: [
      ...(shopFilter ? [shopFilter] : []),
      {
        $or: [
          { shopee_cancel_return_kind: "failed_delivery" },
          { "data.shopee_cancel_return_kind": "failed_delivery" },
          { is_rts: true },
          { "data.is_rts": true },
          { sub_status: "RTS" },
        ],
      },
    ],
  }).toArray();
  let updated = 0;
  const ops = [];
  for (const doc of docs) {
    const data = doc.data && typeof doc.data === "object" ? doc.data : {};
    const order = {
      logistics_status: data.logistics_status || doc.logistics_status,
      cancel_reason: data.cancel_reason,
      buyer_cancel_reason: data.buyer_cancel_reason,
    };
    if (isCarrierRts(order)) continue;
    const returnSn = String(doc.return_sn || data.return_sn || "").trim();
    const kind = returnSn ? "refund_return" : "cancelled";
    ops.push({
      updateOne: {
        filter: { _id: doc._id },
        update: {
          $set: {
            shopee_cancel_return_kind: kind,
            "data.shopee_cancel_return_kind": kind,
            is_rts: false,
            "data.is_rts": false,
            is_return: kind === "refund_return",
            "data.is_return": kind === "refund_return",
            sub_status: kind === "refund_return" ? "RETURN" : "CANCELLED",
            "data.sub_status": kind === "refund_return" ? "RETURN" : "CANCELLED",
          },
        },
      },
    });
    updated += 1;
  }
  if (ops.length && !dryRun) await Order.bulkWrite(ops, { ordered: false });
  console.log(`[heal-rts] shop=${shopId} scanned=${docs.length} fixed=${updated} dry=${dryRun}`);
  return updated;
}

async function main() {
  const dryRun = hasFlag("dry-run");
  const shopId = shopKey(arg("shop") || DEFAULT_SHOP);
  if (!URI) {
    console.error("Missing MONGODB_URI");
    process.exit(1);
  }
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 15000 });
  const Order = mongoose.connection.collection("orders");
  const tokens = loadTokens();
  const accessToken = await resolveAccessToken(shopId, tokens);
  if (!accessToken) {
    console.warn(`[shop ${shopId}] no access_token — chỉ heal Mongo, không gọi Shopee`);
  }

  const returnMap = new Map();
  if (accessToken && PARTNER_ID && PARTNER_KEY) {
    const now = unixNow();
    const from = now - LOOKBACK_SEC;
    for (let w = 0; w < 2; w += 1) {
      const timeTo = now - w * WINDOW_SEC;
      const timeFrom = Math.max(from, timeTo - WINDOW_SEC + 1);
      if (timeFrom >= timeTo) break;
      await paginateReturnList(shopId, accessToken, timeFrom, timeTo, returnMap);
      await delay(DELAY_MS);
    }
    if (returnMap.size === 0) {
      console.log(`[return] shop=${shopId} fallback no-time + discard >30d`);
      const historyFrom = unixNow() - LOOKBACK_SEC;
      let oldStreak = 0;
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const json = await shopeeGet("/api/v2/returns/get_return_list", shopId, accessToken, {
          page_no: String(page),
          page_size: String(PAGE_SIZE),
        });
        if (json?.error) {
          console.warn(`[return] no-time page=${page} err=${json.error} ${json.message || ""}`);
          break;
        }
        const rows = json?.response?.return || json?.response?.return_list || json?.return || [];
        let kept = 0;
        for (const row of rows) {
          const ts = Number(row?.update_time || row?.create_time || 0);
          if (ts > 0 && ts < historyFrom) {
            oldStreak += 1;
            continue;
          }
          oldStreak = 0;
          const sn = toSn(row?.order_sn || row?.orderSn);
          const rsn = String(row?.return_sn || row?.returnSn || "").trim();
          if (sn && rsn) {
            returnMap.set(sn, { returnSn: rsn, status: String(row?.status || ""), raw: row });
            kept += 1;
          }
        }
        const more = Boolean(json?.response?.more ?? json?.more);
        console.log(`[return] no-time page=${page} kept=${kept} map=${returnMap.size} more=${more}`);
        if (!more || rows.length === 0) break;
        if (oldStreak >= PAGE_SIZE) break;
        await delay(DELAY_MS);
      }
    }
  }

  let written = 0;
  const ops = [];
  for (const [sn, row] of returnMap) {
    const returnSn = row.returnSn;
    const existing = await Order.findOne({
      $or: [{ orderSn: sn }, { _id: `shopee-${sn}` }, { "data.orderSn": sn }],
    });
    const data = existing?.data && typeof existing.data === "object" ? existing.data : {};
    const rts = existing
      ? isCarrierRts({
          logistics_status: data.logistics_status || existing.logistics_status,
          cancel_reason: data.cancel_reason,
          buyer_cancel_reason: data.buyer_cancel_reason,
        })
      : false;
    const kind = rts ? "failed_delivery" : "refund_return";
    ops.push({
      updateOne: {
        filter: { $or: [{ orderSn: sn }, { _id: `shopee-${sn}` }, { "data.orderSn": sn }] },
        update: {
          $set: {
            return_sn: returnSn,
            "data.return_sn": returnSn,
            is_return: kind === "refund_return",
            "data.is_return": kind === "refund_return",
            shopee_cancel_return_kind: kind,
            "data.shopee_cancel_return_kind": kind,
            sub_status: kind === "refund_return" ? "RETURN" : "RTS",
            "data.sub_status": kind === "refund_return" ? "RETURN" : "RTS",
            is_rts: kind === "failed_delivery",
            "data.is_rts": kind === "failed_delivery",
          },
        },
      },
    });
    written += 1;
  }
  if (ops.length && !dryRun) {
    const res = await Order.bulkWrite(ops, { ordered: false });
    console.log(
      `[write] shop=${shopId} returns=${returnMap.size} matched=${res.matchedCount} modified=${res.modifiedCount} dry=${dryRun}`,
    );
  } else {
    console.log(`[write] shop=${shopId} returns=${returnMap.size} ops=${ops.length} dry=${dryRun}`);
  }

  await healFalseRts(Order, "", dryRun);
  console.log(`[done] shop=${shopId} return_sn_rows=${written}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("[FATAL]", err?.message || err);
  process.exit(1);
});
