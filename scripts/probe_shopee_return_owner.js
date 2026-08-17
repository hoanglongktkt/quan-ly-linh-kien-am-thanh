#!/usr/bin/env node
/**
 * READ-ONLY: hỏi Shopee return_sn 2608140B8KY4TDN thuộc đơn nào,
 * và reverse tracking có phải SPXVN069880087028 không.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
dotenv.config({ path: path.join(ROOT, ".env") });

const PARTNER_ID = String(process.env.SHOPEE_PARTNER_ID || "").trim();
const PARTNER_KEY = String(process.env.SHOPEE_PARTNER_KEY || "").trim();
const HOST = "https://partner.shopeemobile.com";
const TOKENS_PATH = path.join(ROOT, "data", "shopee_tokens.json");
const SHOP_ID = "4127421";
const RETURN_SN = "2608140B8KY4TDN";
const VICTIM = "2608114E0WDYQE";
const LEAKED_TN = "SPXVN069880087028";

function sign(apiPath, timestamp, accessToken, shopId) {
  const base = accessToken
    ? `${PARTNER_ID}${apiPath}${timestamp}${accessToken}${shopId}`
    : `${PARTNER_ID}${apiPath}${timestamp}`;
  return crypto.createHmac("sha256", PARTNER_KEY).update(base).digest("hex");
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

function collectTracking(node, out, depth = 0, pathStr = "$") {
  if (!node || depth > 8) return;
  if (typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((item, i) => collectTracking(item, out, depth + 1, `${pathStr}[${i}]`));
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    const key = String(k).toLowerCase();
    if (
      v != null &&
      String(v).trim() &&
      (key.includes("tracking") || key.includes("shipping_number") || key === "order_sn" || key === "return_sn" || key === "status")
    ) {
      out.push({ path: `${pathStr}.${k}`, key: k, value: String(v) });
    }
    if (v && typeof v === "object") collectTracking(v, out, depth + 1, `${pathStr}.${k}`);
  }
}

async function main() {
  const tokens = JSON.parse(fs.readFileSync(TOKENS_PATH, "utf8"));
  const rec = tokens[SHOP_ID];
  if (!rec?.access_token) {
    console.error("No token for", SHOP_ID);
    process.exit(1);
  }
  const accessToken = rec.access_token;
  const shopId = rec.oauth_shop_id || rec.shop_id || SHOP_ID;

  console.log("=== SHOPEE PROBE (read-only) shop=4127421 LKAT ===");

  const detail = await shopeeGet("/api/v2/returns/get_return_detail", shopId, accessToken, {
    return_sn: RETURN_SN,
  });
  const dbody = detail?.response ?? detail ?? {};
  console.log("\n[get_return_detail]");
  console.log(
    JSON.stringify(
      {
        error: detail?.error || "",
        message: detail?.message || "",
        order_sn: dbody.order_sn || dbody.orderSn || "",
        return_sn: dbody.return_sn || dbody.returnSn || "",
        status: dbody.status || "",
        tracking_number: dbody.tracking_number || "",
        needs_logistics: dbody.needs_logistics,
        return_ship_due_date: dbody.return_ship_due_date,
        victim_match: String(dbody.order_sn || dbody.orderSn || "") === VICTIM,
      },
      null,
      2,
    ),
  );
  const detailHits = [];
  collectTracking(dbody, detailHits);
  const leakedInDetail = detailHits.filter((h) => String(h.value).toUpperCase().includes(LEAKED_TN));
  console.log("[detail tracking/order fields]", JSON.stringify(detailHits.slice(0, 40), null, 2));
  console.log("[detail contains leaked TN]", leakedInDetail.length, JSON.stringify(leakedInDetail, null, 2));

  const reverse = await shopeeGet(
    "/api/v2/returns/get_reverse_tracking_info",
    shopId,
    accessToken,
    { return_sn: RETURN_SN },
  );
  const rbody = reverse?.response ?? reverse ?? {};
  console.log("\n[get_reverse_tracking_info]");
  console.log(
    JSON.stringify(
      {
        error: reverse?.error || "",
        message: reverse?.message || "",
        tracking_number: rbody.tracking_number || "",
        rts_tracking_number: rbody.rts_tracking_number || "",
        tracking_info0: rbody?.tracking_info?.[0]?.tracking_number || "",
        leaked_match:
          String(rbody.tracking_number || "").toUpperCase() === LEAKED_TN ||
          String(rbody.rts_tracking_number || "").toUpperCase() === LEAKED_TN,
      },
      null,
      2,
    ),
  );
  const reverseHits = [];
  collectTracking(rbody, reverseHits);
  console.log("[reverse fields]", JSON.stringify(reverseHits.slice(0, 40), null, 2));

  const now = Math.floor(Date.now() / 1000);
  const list = await shopeeGet("/api/v2/returns/get_return_list", shopId, accessToken, {
    page_no: "1",
    page_size: "50",
    update_time_from: String(now - 15 * 24 * 3600),
    update_time_to: String(now),
  });
  const rows = list?.response?.return || list?.response?.return_list || [];
  const hitVictim = rows.filter((r) => String(r.order_sn || r.orderSn || "") === VICTIM);
  const hitRsn = rows.filter((r) => String(r.return_sn || r.returnSn || "") === RETURN_SN);
  const hitTn = rows.filter((r) => {
    const blob = JSON.stringify(r).toUpperCase();
    return blob.includes(LEAKED_TN);
  });
  console.log("\n[get_return_list 15d]");
  console.log("rows", rows.length, "error", list?.error || "");
  console.log("rows for victim order", JSON.stringify(hitVictim, null, 2));
  console.log("rows for return_sn", JSON.stringify(hitRsn, null, 2));
  console.log("rows containing leaked TN", hitTn.length);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
