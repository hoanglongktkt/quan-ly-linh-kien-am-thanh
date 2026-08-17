#!/usr/bin/env node
/**
 * Chữa cháy: đơn bị đánh CANCELLED vì get_order_detail sai shop_id.
 * Loop mọi shop ủy quyền — shop nào trả đơn thì cập nhật shop_id + trạng thái thật.
 *
 *   node scripts/repair_wrong_shop_cancelled.js
 *   node scripts/repair_wrong_shop_cancelled.js --limit=20
 *   node scripts/repair_wrong_shop_cancelled.js --dry-run
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
const LOOKBACK_DAYS = 14;
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

function mapLocal(raw) {
  const r = String(raw || "").toUpperCase();
  if (r === "SHIPPED" || r === "TO_CONFIRM_RECEIVE") return "shipping";
  if (r === "COMPLETED") return "completed";
  if (r === "CANCELLED" || r === "IN_CANCEL") return "cancelled";
  if (r === "TO_RETURN") return "return_pending";
  if (r === "PROCESSED") return "processed";
  return "unprocessed";
}

async function getOrderDetail(shopId, accessToken, orderSn) {
  const apiPath = "/api/v2/order/get_order_detail";
  const timestamp = unixNow();
  const s = sign(apiPath, timestamp, accessToken, shopId);
  const params = new URLSearchParams({
    partner_id: PARTNER_ID,
    timestamp: String(timestamp),
    access_token: accessToken,
    shop_id: String(shopId),
    sign: s,
    order_sn_list: orderSn,
    response_optional_fields:
      "item_list,package_list,recipient_address,total_amount,buyer_username",
  });
  const res = await fetch(`${HOST}${apiPath}?${params.toString()}`);
  return res.json();
}

async function main() {
  const dryRun = hasFlag("dry-run");
  const limit = Math.max(1, Math.min(HARD_CAP, Number(arg("limit")) || DEFAULT_LIMIT));
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
  const docs = await col
    .find(
      {
        $and: [
          {
            $or: [
              { channel: "shopee" },
              { "data.channel": "shopee" },
              { channel: { $exists: false } },
            ],
          },
          {
            $or: [
              { "data.shopee_not_found": true },
              { shopee_not_found: true },
              { "data.shopee_not_found_reason": { $exists: true, $nin: [null, ""] } },
              {
                $and: [
                  {
                    $or: [
                      { shopee_order_status: { $in: ["CANCELLED", "IN_CANCEL"] } },
                      { "data.shopee_order_status": { $in: ["CANCELLED", "IN_CANCEL"] } },
                      { status: "cancelled" },
                    ],
                  },
                  {
                    $or: [
                      { last_synced_at: { $gte: since } },
                      { "data.date": { $gte: sinceIso } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        projection: {
          orderSn: 1,
          shopId: 1,
          status: 1,
          shopee_order_status: 1,
          "data.orderSn": 1,
          "data.shopId": 1,
          "data.status": 1,
          "data.shopee_order_status": 1,
          "data.shopee_not_found": 1,
        },
        maxTimeMS: 8000,
      },
    )
    .sort({ last_synced_at: -1, _id: -1 })
    .limit(limit)
    .toArray();

  const tokens = loadTokens();
  const shopIds = Object.keys(tokens).map(shopKey).filter(Boolean);
  console.log(
    `[repair] candidates=${docs.length} shops=${shopIds.join(",")} limit=${limit} dryRun=${dryRun}`,
  );

  const startedAt = Date.now();
  let repaired = 0;
  let skipped = 0;
  let errors = 0;

  for (let i = 0; i < docs.length; i += 1) {
    if (Date.now() - startedAt >= DEADLINE_MS) {
      console.log("[repair] deadline reached — stop");
      break;
    }
    const doc = docs[i];
    const orderSn = String(doc?.orderSn || doc?.data?.orderSn || "")
      .replace(/^shopee-/i, "")
      .trim();
    const currentShop = shopKey(doc?.shopId || doc?.data?.shopId);
    if (!orderSn) {
      skipped += 1;
      continue;
    }

    const tryShops = [
      ...new Set([currentShop, ...shopIds].filter(Boolean)),
    ];
    let ownerShop = "";
    let ownerRaw = "";
    let lastErr = "";

    for (const sid of tryShops) {
      const accessToken = await resolveAccessToken(sid, tokens);
      if (!accessToken) continue;
      try {
        const json = await getOrderDetail(sid, accessToken, orderSn);
        if (json?.error) {
          lastErr = `${json.error} ${json.message || ""}`.trim();
          console.error(
            `[repair] order_sn=${orderSn} shop=${sid} API error=${lastErr} — không hủy, thử shop khác`,
          );
          await delay(DELAY_MS);
          continue;
        }
        const list = json?.response?.order_list || json?.order_list || [];
        const hit = Array.isArray(list)
          ? list.find((it) => String(it?.order_sn || "").trim() === orderSn)
          : null;
        if (hit) {
          ownerShop = sid;
          ownerRaw = String(hit.order_status || "").toUpperCase();
          break;
        }
        lastErr = "empty_order_list";
      } catch (err) {
        lastErr = err?.message || String(err);
        console.error(`[repair] exception order_sn=${orderSn} shop=${sid}:`, lastErr);
      }
      await delay(DELAY_MS);
    }

    if (!ownerShop || !ownerRaw) {
      console.error(
        `[repair] KEEP status order_sn=${orderSn} — không shop nào trả đơn (${lastErr || "not_found"})`,
      );
      skipped += 1;
      continue;
    }

    const nextStatus = mapLocal(ownerRaw);
    const needShop = ownerShop !== currentShop;
    const needStatus =
      ownerRaw !== "CANCELLED" &&
      ownerRaw !== "IN_CANCEL" &&
      (String(doc?.shopee_order_status || doc?.data?.shopee_order_status || "").toUpperCase() ===
        "CANCELLED" ||
        String(doc?.status || doc?.data?.status || "").toLowerCase() === "cancelled");
    if (!needShop && !needStatus) {
      skipped += 1;
      continue;
    }

    console.log(
      `[repair] ${orderSn} ${currentShop || "-"}/${doc?.shopee_order_status || doc?.status} → ${ownerShop}/${ownerRaw} local=${nextStatus}`,
    );
    if (dryRun) {
      repaired += 1;
      continue;
    }

    const now = new Date();
    const $set = {
      shopId: ownerShop,
      "data.shopId": ownerShop,
      shopee_order_status: ownerRaw,
      "data.shopee_order_status": ownerRaw,
      status: nextStatus,
      "data.status": nextStatus,
      last_synced_at: now,
      "data.last_synced_at": now.toISOString(),
    };
    const $unset = {
      shopee_not_found: 1,
      "data.shopee_not_found": 1,
      "data.shopee_not_found_at": 1,
      "data.shopee_not_found_reason": 1,
    };
    try {
      await col.updateOne(
        { $or: [{ orderSn }, { "data.orderSn": orderSn }, { _id: `shopee-${orderSn}` }] },
        { $set, $unset },
      );
      repaired += 1;
    } catch (err) {
      errors += 1;
      console.error(`[repair] update fail order_sn=${orderSn}:`, err?.message || err);
    }
    await delay(DELAY_MS);
  }

  console.log(`[repair] DONE repaired=${repaired} skipped=${skipped} errors=${errors}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("[repair] FATAL:", err?.message || err);
  process.exit(1);
});
