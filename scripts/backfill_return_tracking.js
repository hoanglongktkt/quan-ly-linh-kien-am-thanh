#!/usr/bin/env node
/**
 * BACKFILL mã vận đơn chiều hoàn (return_tracking_no).
 *
 * Đơn return_sn mà return_tracking_no trống hoặc đang copy nhầm mã chiều đi
 * → GET /api/v2/returns/get_reverse_tracking_info → ghi 4 field UPPER.
 *
 *   node scripts/backfill_return_tracking.js
 *   node scripts/backfill_return_tracking.js --limit=50
 *   node scripts/backfill_return_tracking.js --shop=4127421
 *   node scripts/backfill_return_tracking.js --dry-run
 *   node scripts/backfill_return_tracking.js --verify=SPXVN123 --order=250101XXXXXX
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
const DELAY_MS = 400;

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
function normalizeShopIdKey(shopId) {
  const key = String(shopId ?? "").trim();
  return /^\d+$/.test(key) ? key : "";
}
function normTn(raw) {
  const s = String(raw || "").trim().toUpperCase();
  if (!s || s.length < 4 || /^0FG/i.test(s)) return "";
  return s;
}
function distinctReturn(candidate, outbound) {
  const ret = normTn(candidate);
  const out = normTn(outbound);
  if (!ret) return "";
  if (out && ret === out) return "";
  return ret;
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
  return Object.keys(tokens || {}).map(normalizeShopIdKey).filter(Boolean).sort();
}

function resolveTokenRecordForOrderShop(tokens, orderShopId) {
  const key = normalizeShopIdKey(orderShopId);
  let record = key ? getShopeeTokenRecord(tokens, key) : null;
  let fileKey = key;
  if (!record) {
    const oauthIds = listOAuthShopIds(tokens);
    if (oauthIds.length === 1) {
      fileKey = oauthIds[0];
      record = tokens[fileKey] || getShopeeTokenRecord(tokens, fileKey);
    }
  } else {
    fileKey = normalizeShopIdKey(record.shop_id) || key;
  }
  if (!record) return null;
  return { record, fileKey, apiShopId: resolveShopeeApiShopId(record, fileKey) };
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

async function getAccessToken(shopId, tokenCache, tokens) {
  const key = normalizeShopIdKey(shopId) || String(shopId || "").trim();
  if (!key) return null;
  if (tokenCache.has(key)) return tokenCache.get(key);
  const resolved = resolveTokenRecordForOrderShop(tokens, key);
  if (!resolved?.record?.access_token && !resolved?.record?.refresh_token) {
    tokenCache.set(key, null);
    return null;
  }
  const { record, fileKey, apiShopId } = resolved;
  let accessToken = record.access_token || "";
  const obtainedAt = Number(record.obtained_at || 0);
  const expireIn = Number(record.expire_in || 14400);
  const now = Math.floor(Date.now() / 1000);
  const expired = !accessToken || (obtainedAt > 0 && now - obtainedAt >= expireIn - 60);
  if (expired && record.refresh_token) {
    try {
      const refreshed = await refreshAccessToken(apiShopId, record.refresh_token);
      if (refreshed?.access_token) {
        accessToken = refreshed.access_token;
        tokens[fileKey] = {
          ...record,
          access_token: refreshed.access_token,
          refresh_token: refreshed.refresh_token || record.refresh_token,
          expire_in: refreshed.expire_in || record.expire_in,
          obtained_at: Math.floor(Date.now() / 1000),
        };
        saveTokens(tokens);
      }
    } catch (err) {
      console.warn(`[Token] Refresh exception shop=${fileKey}:`, err?.message || err);
    }
  }
  const result = accessToken ? { accessToken, apiShopId } : null;
  tokenCache.set(key, result);
  return result;
}

async function shopeeGet(apiPath, shopId, accessToken, extra) {
  const timestamp = Math.floor(Date.now() / 1000);
  const params = new URLSearchParams({
    partner_id: PARTNER_ID,
    timestamp: String(timestamp),
    access_token: accessToken,
    shop_id: String(shopId),
    sign: sign(apiPath, timestamp, accessToken, shopId),
    ...extra,
  });
  const res = await fetch(`${HOST}${apiPath}?${params.toString()}`);
  return res.json();
}

function pickReverseTracking(json) {
  const body = json?.response ?? json ?? {};
  return distinctReturn(
    normTn(body.tracking_number) ||
      normTn(body.rts_tracking_number) ||
      normTn(body?.tracking_info?.[0]?.tracking_number),
    "",
  );
}

function orderSnOf(doc) {
  return String(doc?.orderSn || doc?.data?.orderSn || doc?._id || "")
    .replace(/^shopee-/i, "")
    .trim();
}
function shopIdOf(doc) {
  return (
    normalizeShopIdKey(doc?.shopId || doc?.data?.shopId) ||
    String(doc?.shopId || doc?.data?.shopId || "").trim()
  );
}
function returnSnOf(doc) {
  return String(doc?.return_sn || doc?.data?.return_sn || "").trim();
}
function outboundOf(doc) {
  return normTn(
    doc?.tracking_no || doc?.trackingNumber || doc?.data?.tracking_no || doc?.data?.trackingNumber,
  );
}
function returnOf(doc) {
  return normTn(
    doc?.return_tracking_no ||
      doc?.returnTrackingNumber ||
      doc?.data?.return_tracking_no ||
      doc?.data?.returnTrackingNumber,
  );
}

function missingReturnFilter() {
  return {
    $and: [
      {
        $or: [
          { return_sn: { $exists: true, $nin: [null, ""] } },
          { "data.return_sn": { $exists: true, $nin: [null, ""] } },
          { shopee_order_status: "TO_RETURN" },
          { status: { $in: ["return_pending", "return_received"] } },
        ],
      },
      {
        $or: [
          { return_tracking_no: { $exists: false } },
          { return_tracking_no: null },
          { return_tracking_no: "" },
          { "data.return_tracking_no": { $exists: false } },
          { "data.return_tracking_no": null },
          { "data.return_tracking_no": "" },
          {
            $expr: {
              $let: {
                vars: {
                  rtn: {
                    $toUpper: {
                      $ifNull: [
                        "$return_tracking_no",
                        { $ifNull: ["$data.return_tracking_no", ""] },
                      ],
                    },
                  },
                  out: {
                    $toUpper: {
                      $ifNull: ["$tracking_no", { $ifNull: ["$data.tracking_no", ""] }],
                    },
                  },
                },
                in: {
                  $and: [
                    { $gt: [{ $strLenCP: "$$rtn" }, 0] },
                    { $gt: [{ $strLenCP: "$$out" }, 0] },
                    { $eq: ["$$rtn", "$$out"] },
                  ],
                },
              },
            },
          },
        ],
      },
    ],
  };
}

async function persistReturnTn(col, doc, rtn) {
  const sn = orderSnOf(doc);
  if (!sn || !rtn) return false;
  const filter = {
    $or: [
      { orderSn: sn },
      { "data.orderSn": sn },
      { _id: `shopee-${sn}` },
      ...(doc?._id != null ? [{ _id: doc._id }] : []),
    ],
  };
  const $set = {
    return_tracking_no: rtn,
    returnTrackingNumber: rtn,
    "data.return_tracking_no": rtn,
    "data.returnTrackingNumber": rtn,
  };
  const result = await col.updateOne(filter, { $set });
  return result.modifiedCount > 0 || result.matchedCount > 0;
}

/** Verify scan exact $eq — cùng filter findOrderByScanCodeInStore. */
async function verifyScanEq(col, scannedCode, expectedOrderSn) {
  const code = String(scannedCode || "").trim().toUpperCase();
  if (!code) return false;
  const doc = await col.findOne({
    $or: [
      { returnTrackingNumber: code },
      { return_tracking_no: code },
      { "data.returnTrackingNumber": code },
      { "data.return_tracking_no": code },
    ],
  });
  const sn = orderSnOf(doc || {});
  const ok = Boolean(sn) && (!expectedOrderSn || sn === String(expectedOrderSn).trim());
  console.log(
    `[VERIFY] scan=${code} hit=${sn || "(none)"} expected=${expectedOrderSn || "-"} ok=${ok}`,
  );
  return ok;
}

async function main() {
  console.log("=== BACKFILL RETURN TRACKING (get_reverse_tracking_info) ===");
  if (!URI) {
    console.error("Thiếu MONGODB_URI / MONGO_URL trong .env");
    process.exit(1);
  }

  const dryRun = hasFlag("dry-run");
  const limitArg = arg("limit");
  const limit = limitArg ? Math.max(1, Number(limitArg) || 0) : 200;
  const shopFilter = String(arg("shop") || "").trim();
  const verifyCode = String(arg("verify") || "").trim().toUpperCase();
  const verifyOrder = String(arg("order") || "").trim();

  await mongoose.connect(URI, { serverSelectionTimeoutMS: 20000 });
  const col = mongoose.connection.db.collection("orders");

  if (verifyCode) {
    await verifyScanEq(col, verifyCode, verifyOrder);
    await mongoose.disconnect();
    return;
  }

  if (!PARTNER_ID || !PARTNER_KEY) {
    console.error("Thiếu SHOPEE_PARTNER_ID / SHOPEE_PARTNER_KEY trong .env");
    process.exit(1);
  }

  const tokens = loadTokens();
  const tokenCache = new Map();
  if (dryRun) console.log("[Mode] DRY-RUN — gọi API, không UPDATE DB");

  const filter = missingReturnFilter();
  if (shopFilter) {
    filter.$and.push({
      $or: [{ shopId: shopFilter }, { "data.shopId": shopFilter }],
    });
  }

  const docs = await col.find(filter).limit(limit).toArray();
  console.log(`[Query] candidates=${docs.length} limit=${limit}`);

  let filled = 0;
  let pending = 0;
  let skipped = 0;
  let errors = 0;
  let verified = 0;

  for (const doc of docs) {
    const sn = orderSnOf(doc);
    const shopId = shopIdOf(doc);
    const returnSn = returnSnOf(doc);
    const outbound = outboundOf(doc);
    const existingRet = returnOf(doc);
    if (!sn || !shopId) {
      skipped += 1;
      continue;
    }
    if (existingRet && existingRet !== outbound) {
      skipped += 1;
      continue;
    }
    if (!returnSn) {
      skipped += 1;
      console.log(`[Skip] ${sn} — thiếu return_sn`);
      continue;
    }

    const auth = await getAccessToken(shopId, tokenCache, tokens);
    if (!auth?.accessToken) {
      errors += 1;
      console.warn(`[Token] ${sn} shop=${shopId} — không có access_token`);
      continue;
    }

    try {
      const reverse = await shopeeGet(
        "/api/v2/returns/get_reverse_tracking_info",
        auth.apiShopId,
        auth.accessToken,
        { return_sn: returnSn },
      );
      let rtn = distinctReturn(pickReverseTracking(reverse), outbound);
      if (!rtn && !reverse?.error) {
        const detail = await shopeeGet(
          "/api/v2/returns/get_return_detail",
          auth.apiShopId,
          auth.accessToken,
          { return_sn: returnSn },
        );
        const body = detail?.response ?? detail ?? {};
        rtn = distinctReturn(body.tracking_number, outbound);
      }
      if (!rtn) {
        pending += 1;
        const errText = `${reverse?.error || ""} ${reverse?.message || ""}`.trim();
        console.log(`[Pending] ${sn} return_sn=${returnSn} ${errText || "chưa có reverse TN"}`);
      } else if (dryRun) {
        filled += 1;
        console.log(`[Dry] ${sn} → ${rtn}`);
      } else {
        const ok = await persistReturnTn(col, doc, rtn);
        if (ok) {
          filled += 1;
          const hit = await verifyScanEq(col, rtn, sn);
          if (hit) verified += 1;
          console.log(`[OK] ${sn} return_sn=${returnSn} rtn=${rtn} scanEq=${hit}`);
        } else {
          errors += 1;
          console.warn(`[DB] ${sn} update failed rtn=${rtn}`);
        }
      }
    } catch (err) {
      errors += 1;
      console.warn(`[Err] ${sn}:`, err?.message || err);
    }
    await delay(DELAY_MS);
  }

  console.log(
    `[DONE] filled=${filled} verified=${verified} pending=${pending} skipped=${skipped} errors=${errors}`,
  );
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
