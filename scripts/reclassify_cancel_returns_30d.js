#!/usr/bin/env node
/**
 * Quét Shopee 30 ngày + phân loại thép Hủy / RTS / Trả hàng.
 *
 *   node scripts/reclassify_cancel_returns_30d.js
 *   node scripts/reclassify_cancel_returns_30d.js --shop=4127421
 *   node scripts/reclassify_cancel_returns_30d.js --mongo-only
 *   node scripts/reclassify_cancel_returns_30d.js --dry-run
 *   node scripts/reclassify_cancel_returns_30d.js --limit=800
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

const LOOKBACK_SEC = 30 * 24 * 60 * 60;
const WINDOW_SEC = 15 * 24 * 60 * 60;
const PAGE_SIZE = 100;
const MAX_PAGES = 50;
const MAX_SNS = 4000;
const DETAIL_BATCH = 20;
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

function listShopIds(tokens, only) {
  const want = shopKey(only);
  const keys = Object.keys(tokens || {}).map(shopKey).filter(Boolean);
  if (want) return keys.filter((k) => k === want);
  return [...new Set(keys)];
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

function isCancelledStatus(order) {
  const raw = String(order.shopee_order_status || order.order_status || "").toUpperCase();
  const st = String(order.status || "").toUpperCase();
  return raw === "CANCELLED" || raw === "IN_CANCEL" || st === "CANCELLED";
}
function hasReturnSn(order) {
  return Boolean(String(order.return_sn || "").trim());
}
function isRts(order) {
  if (order.is_rts === true) return true;
  if (String(order.sub_status || "").toUpperCase() === "RTS") return true;
  const log = String(order.logistics_status || "").toUpperCase();
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
function classify(order, returnSnSet) {
  if (isRts(order)) return "failed_delivery";
  const sn = toSn(order.orderSn || order.order_sn);
  if (returnSnSet.has(sn) && hasReturnSn(order) && !isCancelledStatus(order)) {
    return "refund_return";
  }
  if (hasReturnSn(order) && !isCancelledStatus(order) && !isRts(order)) {
    return "refund_return";
  }
  if (isCancelledStatus(order)) return "cancelled";
  return null;
}
function subOf(kind) {
  if (kind === "failed_delivery") return "RTS";
  if (kind === "cancelled") return "CANCELLED";
  if (kind === "refund_return") return "RETURN";
  return "";
}

async function paginateOrderList(shopId, accessToken, status, timeFrom, timeTo, out) {
  let cursor = "";
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    if (out.size >= MAX_SNS) break;
    const extra = {
      time_range_field: "update_time",
      time_from: String(timeFrom),
      time_to: String(timeTo),
      page_size: String(PAGE_SIZE),
      cursor,
      order_status: status,
    };
    const json = await shopeeGet("/api/v2/order/get_order_list", shopId, accessToken, extra);
    if (json?.error) {
      console.warn(`[list] shop=${shopId} ${status} page=${page} err=${json.error} ${json.message || ""}`);
      break;
    }
    const rows = json?.response?.order_list || json?.order_list || [];
    for (const row of rows) {
      const sn = toSn(row?.order_sn || row?.orderSn);
      if (sn) out.add(sn);
      if (out.size >= MAX_SNS) break;
    }
    const more = Boolean(json?.response?.more ?? json?.more);
    console.log(`[list] shop=${shopId} ${status} page=${page} +${rows.length} total=${out.size} more=${more}`);
    if (!more || rows.length === 0) break;
    cursor = String(json?.response?.next_cursor || json?.next_cursor || "");
    if (!cursor) break;
    await delay(DELAY_MS);
  }
}

async function paginateReturnList(shopId, accessToken, timeFrom, timeTo, out) {
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    if (out.size >= MAX_SNS) break;
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
      if (sn && rsn) out.set(sn, rsn);
      if (out.size >= MAX_SNS) break;
    }
    const more = Boolean(json?.response?.more ?? json?.more);
    console.log(`[return] shop=${shopId} page=${page} rows=${rows.length} map=${out.size} more=${more}`);
    if (!more || rows.length === 0) break;
    await delay(DELAY_MS);
  }
}

async function fetchDetails(shopId, accessToken, sns) {
  const extra = {
    order_sn_list: sns.join(","),
    request_order_status_pending: "true",
    response_optional_fields:
      "cancel_reason,buyer_cancel_reason,cancel_by,order_status,item_list",
  };
  const json = await shopeeGet("/api/v2/order/get_order_detail", shopId, accessToken, extra);
  if (json?.error) {
    console.warn(`[detail] shop=${shopId} err=${json.error} ${json.message || ""}`);
    return [];
  }
  return json?.response?.order_list || json?.order_list || [];
}

async function mongoOnlyReclassify(Order, limit, dryRun) {
  const since = new Date(Date.now() - LOOKBACK_SEC * 1000);
  const pageSize = 50;
  const maxPages = Math.ceil(limit / pageSize);
  let scanned = 0;
  let updated = 0;
  const filter = {
    $and: [
      {
        $or: [
          { status: { $in: ["cancelled", "return_pending", "return_received"] } },
          { shopee_order_status: { $in: ["CANCELLED", "IN_CANCEL", "TO_RETURN"] } },
          { "data.shopee_order_status": { $in: ["CANCELLED", "IN_CANCEL", "TO_RETURN"] } },
        ],
      },
      {
        $or: [
          { "data.date": { $gte: since.toISOString() } },
          { last_synced_at: { $gte: since } },
        ],
      },
    ],
  };
  for (let page = 0; page < maxPages; page += 1) {
    if (scanned >= limit) break;
    const docs = await Order.find(filter)
      .sort({ "data.date": -1, _id: -1 })
      .skip(page * pageSize)
      .limit(pageSize)
      .toArray();
    if (!docs.length) break;
    const ops = [];
    for (const doc of docs) {
      if (scanned >= limit) break;
      scanned += 1;
      const data = doc.data && typeof doc.data === "object" ? doc.data : {};
      const order = {
        orderSn: doc.orderSn || data.orderSn,
        status: doc.status || data.status,
        shopee_order_status: doc.shopee_order_status || data.shopee_order_status,
        return_sn: doc.return_sn || data.return_sn,
        is_return: doc.is_return === true || data.is_return === true,
        is_rts: doc.is_rts === true || data.is_rts === true,
        sub_status: doc.sub_status || data.sub_status,
        cancel_reason: data.cancel_reason,
        buyer_cancel_reason: data.buyer_cancel_reason,
        logistics_status: data.logistics_status,
        shopee_cancel_return_kind: doc.shopee_cancel_return_kind || data.shopee_cancel_return_kind,
      };
      const kind = classify(order, new Set());
      if (!kind) continue;
      const clearReturn = kind !== "refund_return";
      const prev = String(doc.shopee_cancel_return_kind || data.shopee_cancel_return_kind || "");
      if (prev === kind && !(clearReturn && String(order.return_sn || "").trim())) continue;
      const $set = {
        shopee_cancel_return_kind: kind,
        "data.shopee_cancel_return_kind": kind,
        is_return: kind === "refund_return",
        "data.is_return": kind === "refund_return",
        is_rts: kind === "failed_delivery",
        "data.is_rts": kind === "failed_delivery",
        sub_status: subOf(kind),
        "data.sub_status": subOf(kind),
      };
      const $unset = {};
      if (clearReturn) {
        $unset.return_sn = 1;
        $unset["data.return_sn"] = 1;
      }
      ops.push({
        updateOne: {
          filter: { _id: doc._id },
          update: { $set, ...(Object.keys($unset).length ? { $unset } : {}) },
        },
      });
      updated += 1;
    }
    if (ops.length && !dryRun) await Order.bulkWrite(ops, { ordered: false });
    console.log(`[mongo] page=${page + 1} scanned=${scanned} pendingWrite=${ops.length} dry=${dryRun}`);
    if (docs.length < pageSize) break;
    await delay(80);
  }
  return { scanned, updated };
}

async function main() {
  const dryRun = hasFlag("dry-run");
  const mongoOnly = hasFlag("mongo-only");
  const limit = Math.max(50, Math.min(4000, Number(arg("limit") || 2000) || 2000));
  if (!URI) {
    console.error("Missing MONGODB_URI");
    process.exit(1);
  }
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 15000 });
  const Order = mongoose.connection.collection("orders");
  const tokens = loadTokens();
  const shops = listShopIds(tokens, arg("shop"));
  console.log(
    `[start] shops=${shops.join(",") || "(none)"} mongoOnly=${mongoOnly} dry=${dryRun} limit=${limit} lookback=30d`,
  );

  if (!mongoOnly && shops.length && PARTNER_ID && PARTNER_KEY) {
    const now = unixNow();
    const from = now - LOOKBACK_SEC;
    for (const shopId of shops) {
      const accessToken = await resolveAccessToken(shopId, tokens);
      if (!accessToken) {
        console.warn(`[shop ${shopId}] skip — no access_token`);
        continue;
      }
      const cancelSns = new Set();
      const returnMap = new Map();
      for (let w = 0; w < 2; w += 1) {
        const timeTo = now - w * WINDOW_SEC;
        const timeFrom = Math.max(from, timeTo - WINDOW_SEC + 1);
        if (timeFrom >= timeTo) break;
        for (const st of ["CANCELLED", "IN_CANCEL"]) {
          await paginateOrderList(shopId, accessToken, st, timeFrom, timeTo, cancelSns);
          await delay(DELAY_MS);
        }
        await paginateReturnList(shopId, accessToken, timeFrom, timeTo, returnMap);
        await delay(DELAY_MS);
      }
      if (returnMap.size === 0) {
        console.log(`[return] shop=${shopId} fallback no-time + discard >30d`);
        const historyFrom = unixNow() - LOOKBACK_SEC;
        let oldStreak = 0;
        for (let page = 1; page <= MAX_PAGES; page += 1) {
          if (returnMap.size >= MAX_SNS) break;
          const json = await shopeeGet("/api/v2/returns/get_return_list", shopId, accessToken, {
            page_no: String(page),
            page_size: String(PAGE_SIZE),
          });
          if (json?.error) {
            console.warn(`[return] no-time page=${page} err=${json.error}`);
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
              returnMap.set(sn, rsn);
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
      const returnSnSet = new Set(returnMap.keys());
      const allSns = [...new Set([...cancelSns, ...returnSnSet])].slice(0, MAX_SNS);
      console.log(
        `[shop ${shopId}] cancel=${cancelSns.size} returns=${returnMap.size} detail=${allSns.length}`,
      );
      for (let i = 0; i < allSns.length; i += DETAIL_BATCH) {
        const chunk = allSns.slice(i, i + DETAIL_BATCH);
        const details = await fetchDetails(shopId, accessToken, chunk);
        const ops = [];
        for (const item of details) {
          const sn = toSn(item?.order_sn);
          if (!sn) continue;
          const mappedReturn = returnMap.get(sn) || "";
          const order = {
            orderSn: sn,
            shopee_order_status: String(item.order_status || "").toUpperCase(),
            status: String(item.order_status || "").toUpperCase() === "CANCELLED" ? "cancelled" : "",
            cancel_reason: item.cancel_reason,
            buyer_cancel_reason: item.buyer_cancel_reason,
            cancel_by: item.cancel_by,
            return_sn: mappedReturn,
            is_return: Boolean(mappedReturn) && String(item.order_status || "").toUpperCase() !== "CANCELLED",
          };
          const kind = classify(order, returnSnSet);
          if (!kind) continue;
          const $set = {
            shopee_cancel_return_kind: kind,
            "data.shopee_cancel_return_kind": kind,
            "data.cancel_reason": item.cancel_reason || "",
            "data.buyer_cancel_reason": item.buyer_cancel_reason || "",
            is_return: kind === "refund_return",
            "data.is_return": kind === "refund_return",
            is_rts: kind === "failed_delivery",
            "data.is_rts": kind === "failed_delivery",
            sub_status: subOf(kind),
            "data.sub_status": subOf(kind),
            shopee_order_status: String(item.order_status || "").toUpperCase(),
            "data.shopee_order_status": String(item.order_status || "").toUpperCase(),
          };
          if (kind === "cancelled" || kind === "failed_delivery") {
            $set.status = "cancelled";
            $set["data.status"] = "cancelled";
          }
          const update = { $set };
          if (kind === "refund_return" && mappedReturn) {
            $set.return_sn = mappedReturn;
            $set["data.return_sn"] = mappedReturn;
          } else {
            update.$unset = { return_sn: 1, "data.return_sn": 1 };
          }
          ops.push({
            updateOne: {
              filter: { $or: [{ orderSn: sn }, { _id: `shopee-${sn}` }] },
              update,
            },
          });
        }
        if (ops.length && !dryRun) await Order.bulkWrite(ops, { ordered: false });
        console.log(
          `[detail] shop=${shopId} chunk=${Math.floor(i / DETAIL_BATCH) + 1} n=${chunk.length} ops=${ops.length} dry=${dryRun}`,
        );
        await delay(DELAY_MS);
        if (i + DETAIL_BATCH >= allSns.length) break;
      }
    }
  } else if (!mongoOnly) {
    console.warn("[shopee] skip API scan — missing token/partner. Mongo-only reclassify.");
  }

  const rec = await mongoOnlyReclassify(Order, limit, dryRun);
  console.log(`[done] mongo scanned=${rec.scanned} updated=${rec.updated} dry=${dryRun}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("[FATAL]", err?.message || err);
  process.exit(1);
});
