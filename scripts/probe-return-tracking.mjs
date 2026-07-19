/**
 * Probe Shopee Returns + Order APIs — tìm key chứa mã vận đơn hoàn.
 * node scripts/probe-return-tracking.mjs [order_sn]
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const ORDER_SN = process.argv[2] || "260703PQ2D6RUK";
const HINT = "SPXVN064782062347";

function loadEnv() {
  const envPath = path.join(root, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}

loadEnv();

const PARTNER_ID = process.env.SHOPEE_PARTNER_ID || "";
const PARTNER_KEY = process.env.SHOPEE_PARTNER_KEY || "";
const HOST = "https://partner.shopeemobile.com";

function sign(apiPath, timestamp, accessToken, shopId) {
  const base = accessToken
    ? `${PARTNER_ID}${apiPath}${timestamp}${accessToken}${shopId}`
    : `${PARTNER_ID}${apiPath}${timestamp}`;
  return crypto.createHmac("sha256", PARTNER_KEY).update(base).digest("hex");
}

async function shopeeGet(apiPath, shopId, accessToken, extra = {}) {
  const timestamp = Math.floor(Date.now() / 1000);
  const params = new URLSearchParams({
    partner_id: PARTNER_ID,
    timestamp: String(timestamp),
    access_token: accessToken,
    shop_id: shopId,
    sign: sign(apiPath, timestamp, accessToken, shopId),
  });
  for (const [k, v] of Object.entries(extra)) params.set(k, String(v));
  const res = await fetch(`${HOST}${apiPath}?${params}`);
  return res.json();
}

function findPaths(obj, target, prefix = "") {
  const hits = [];
  if (obj == null) return hits;
  if (typeof obj === "string" || typeof obj === "number") {
    if (String(obj).includes(target)) hits.push({ path: prefix || "(root)", value: String(obj) });
    return hits;
  }
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => hits.push(...findPaths(v, target, `${prefix}[${i}]`)));
    return hits;
  }
  if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      hits.push(...findPaths(v, target, prefix ? `${prefix}.${k}` : k));
    }
  }
  return hits;
}

async function refreshToken(shopId, refreshToken) {
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

async function main() {
  if (!PARTNER_ID || !PARTNER_KEY) {
    console.error("Missing SHOPEE_PARTNER_ID/KEY");
    process.exit(1);
  }
  const tokens = JSON.parse(
    fs.readFileSync(path.join(root, "data/shopee_tokens.json"), "utf8"),
  );
  const shopId = Object.keys(tokens)[0];
  const rj = await refreshToken(shopId, tokens[shopId].refresh_token);
  const accessToken = rj.access_token || tokens[shopId].access_token;
  console.log("refresh:", rj.error || "ok", "shop=", shopId, "order=", ORDER_SN);

  const now = Math.floor(Date.now() / 1000);
  const summary = { shopId, orderSn: ORDER_SN, lists: [], detail: null, reverse: null, orderDetail: null, logistics: null };

  // 1) get_return_list — no time
  let list = await shopeeGet("/api/v2/returns/get_return_list", shopId, accessToken, {
    page_no: 1,
    page_size: 50,
  });
  console.log(
    "list no-time:",
    "err=",
    list.error || "-",
    "msg=",
    String(list.message || "").slice(0, 160),
    "respKeys=",
    Object.keys(list.response || {}),
    "rows=",
    (list?.response?.return || []).length,
  );
  summary.lists.push({ label: "no-time", error: list.error, message: list.message, rows: (list?.response?.return || []).length, rawKeys: Object.keys(list.response || {}) });

  // 2) by status + 90d
  let returnSn = "";
  for (const st of ["REQUESTED", "PROCESSING", "ACCEPTED", "COMPLETED", "CANCELLED", ""]) {
    const extra = {
      page_no: 1,
      page_size: 100,
      update_time_from: now - 90 * 86400,
      update_time_to: now,
    };
    if (st) extra.status = st;
    list = await shopeeGet("/api/v2/returns/get_return_list", shopId, accessToken, extra);
    const rows = Array.isArray(list?.response?.return) ? list.response.return : [];
    console.log(
      `list status=${st || "ALL"} err=${list.error || "-"} rows=${rows.length} more=${list?.response?.more} sample=${rows[0]?.order_sn || "-"}`,
    );
    summary.lists.push({
      label: st || "ALL-90d",
      error: list.error,
      message: list.message,
      rows: rows.length,
      more: list?.response?.more,
      sample: rows[0]?.order_sn || null,
    });
    for (const row of rows) {
      if (String(row.order_sn) === ORDER_SN) {
        returnSn = String(row.return_sn);
        console.log("FOUND return_sn=", returnSn, row);
      }
    }
    // paginate if needed
    let page = 2;
    while (!returnSn && list?.response?.more && page <= 30) {
      extra.page_no = page;
      list = await shopeeGet("/api/v2/returns/get_return_list", shopId, accessToken, extra);
      const moreRows = Array.isArray(list?.response?.return) ? list.response.return : [];
      console.log(`  page=${page} rows=${moreRows.length}`);
      for (const row of moreRows) {
        if (String(row.order_sn) === ORDER_SN) {
          returnSn = String(row.return_sn);
          console.log("FOUND return_sn=", returnSn);
        }
      }
      if (!moreRows.length) break;
      page++;
      await new Promise((r) => setTimeout(r, 250));
    }
    if (returnSn) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  if (returnSn) {
    const detail = await shopeeGet("/api/v2/returns/get_return_detail", shopId, accessToken, {
      return_sn: returnSn,
    });
    const reverse = await shopeeGet(
      "/api/v2/returns/get_reverse_tracking_info",
      shopId,
      accessToken,
      { return_sn: returnSn },
    );
    summary.detail = detail;
    summary.reverse = reverse;
    console.log("detail.tracking_number=", detail?.response?.tracking_number);
    console.log("reverse.tracking_number=", reverse?.response?.tracking_number);
    console.log("reverse.rts_tracking_number=", reverse?.response?.rts_tracking_number);
    console.log("PATHS detail:", findPaths(detail, HINT));
    console.log("PATHS reverse:", findPaths(reverse, HINT));
  } else {
    console.warn("return_sn NOT FOUND via get_return_list");
  }

  const od = await shopeeGet("/api/v2/order/get_order_detail", shopId, accessToken, {
    order_sn_list: ORDER_SN,
    response_optional_fields: "package_list,item_list,shipping_carrier",
  });
  summary.orderDetail = {
    error: od.error,
    message: od.message,
    status: od?.response?.order_list?.[0]?.order_status,
    package0: od?.response?.order_list?.[0]?.package_list?.[0] || null,
  };
  console.log("order_detail err=", od.error || "-", "status=", summary.orderDetail.status);
  console.log("package0=", JSON.stringify(summary.orderDetail.package0)?.slice(0, 400));
  console.log("PATHS order_detail:", findPaths(od, HINT));

  const tn = await shopeeGet("/api/v2/logistics/get_tracking_number", shopId, accessToken, {
    order_sn: ORDER_SN,
  });
  summary.logistics = tn;
  console.log("logistics.tracking_number=", tn?.response?.tracking_number, "err=", tn.error || "-");
  console.log("PATHS logistics:", findPaths(tn, HINT));

  // Count CANCELLED / TO_RETURN last 30d
  for (const st of ["TO_RETURN", "CANCELLED", "IN_CANCEL"]) {
    const ol = await shopeeGet("/api/v2/order/get_order_list", shopId, accessToken, {
      time_range_field: "update_time",
      time_from: now - 15 * 86400,
      time_to: now,
      page_size: 50,
      order_status: st,
      request_order_status_pending: "true",
    });
    const rows = ol?.response?.order_list || [];
    console.log(`order_list ${st}: err=${ol.error || "-"} rows=${rows.length} more=${ol?.response?.more}`);
  }

  const outPath = path.join(root, "data", "debug-return-probe.json");
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log("Wrote", outPath);
  process.exit(returnSn || summary.orderDetail.status ? 0 : 2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
