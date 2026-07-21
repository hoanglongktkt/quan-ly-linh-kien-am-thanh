/**
 * Probe v2.logistics.get_tracking_number — xuất request/response cho ticket Shopee.
 *
 *   node scripts/probe-get-tracking-number.mjs --order=2607207181SXFP
 *   node scripts/probe-get-tracking-number.mjs --order=XXX --package=OFG...
 *   node scripts/probe-get-tracking-number.mjs --auto-ghn
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

function loadEnv() {
  const envPath = path.join(root, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : "";
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

loadEnv();

const PARTNER_ID = process.env.SHOPEE_PARTNER_ID || "";
const PARTNER_KEY = process.env.SHOPEE_PARTNER_KEY || "";
const HOST = "https://partner.shopeemobile.com";
const APP_URL = (process.env.APP_URL || process.env.APP_BASE_URL || "").replace(/\/$/, "");

function sign(apiPath, timestamp, accessToken, shopId) {
  const base = accessToken
    ? `${PARTNER_ID}${apiPath}${timestamp}${accessToken}${shopId}`
    : `${PARTNER_ID}${apiPath}${timestamp}`;
  return crypto.createHmac("sha256", PARTNER_KEY).update(base).digest("hex");
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

async function shopeeGet(apiPath, shopId, accessToken, extra = {}) {
  const timestamp = Math.floor(Date.now() / 1000);
  const params = new URLSearchParams({
    partner_id: PARTNER_ID,
    timestamp: String(timestamp),
    access_token: accessToken,
    shop_id: shopId,
    sign: sign(apiPath, timestamp, accessToken, shopId),
  });
  for (const [k, v] of Object.entries(extra)) {
    if (v != null && v !== "") params.set(k, String(v));
  }
  const request = {
    method: "GET",
    path: apiPath,
    partner_id: Number(PARTNER_ID),
    shop_id: Number(shopId),
    ...extra,
    timestamp: Number(params.get("timestamp")),
    access_token: "(omitted)",
    sign: "(omitted)",
  };
  const res = await fetch(`${HOST}${apiPath}?${params.toString()}`);
  const response = await res.json();
  return { httpStatus: res.status, request, response };
}

async function findGhnOrderFromApp(accessToken, shopId) {
  if (!APP_URL || !process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD) return null;
  const login = await (
    await fetch(`${APP_URL}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: process.env.ADMIN_USERNAME.trim(),
        password: process.env.ADMIN_PASSWORD.trim(),
      }),
    })
  ).json();
  if (!login?.token) return null;
  const ordersRes = await (
    await fetch(`${APP_URL}/api/orders`, {
      headers: { Authorization: `Bearer ${login.token}` },
    })
  ).json();
  const orders = Array.isArray(ordersRes) ? ordersRes : ordersRes.orders || [];
  const candidates = orders
    .filter((o) => String(o.channel) === "shopee")
    .filter((o) => {
      const st = String(o.status || "");
      const raw = String(o.shopee_order_status || "").toUpperCase();
      return (
        st === "shipping" ||
        st === "processed" ||
        st.includes("return") ||
        st === "cancelled" ||
        ["SHIPPED", "PROCESSED", "CANCELLED", "TO_RETURN"].includes(raw)
      );
    })
    .slice(0, 60);

  for (const o of candidates) {
    const detail = await shopeeGet("/api/v2/order/get_order_detail", shopId, accessToken, {
      order_sn_list: o.orderSn,
      response_optional_fields: "package_list,shipping_carrier,checkout_shipping_carrier",
    });
    const item = detail.response?.response?.order_list?.[0] || detail.response?.order_list?.[0];
    if (!item) continue;
    const pkg = item.package_list?.[0] || {};
    const carrier =
      item.shipping_carrier ||
      item.checkout_shipping_carrier ||
      pkg.shipping_carrier ||
      pkg.checkout_shipping_carrier ||
      "";
    if (!/ghn|giao hàng nhanh|giao hang nhanh/i.test(String(carrier))) continue;
    return {
      orderSn: o.orderSn,
      packageNumber: pkg.package_number || o.packageNumber || "",
      status: item.order_status,
      carrier,
      logistics_channel_id: pkg.logistics_channel_id || null,
      detail_pkg_tracking: pkg.tracking_number ?? null,
    };
  }
  return null;
}

function printTicket(out) {
  console.log("\n---");
  console.log("- API Category: Logistics");
  console.log("- API Name: v2.logistics.get_tracking_number");
  console.log("- Request:", JSON.stringify(out.request, null, 2));
  console.log("- Response:", JSON.stringify(out.response, null, 2));
  console.log("- Request ID:", out.request_id || "(missing)");
  console.log("- Request Time:", out.request_time_local, `(${out.request_time})`);
  console.log("---\n");
}

async function main() {
  if (!PARTNER_ID || !PARTNER_KEY) {
    console.error("Missing SHOPEE_PARTNER_ID/KEY in .env");
    process.exit(1);
  }

  let orderSn = arg("order") || process.env.ORDER_SN || "";
  let packageNumber = arg("package") || process.env.PACKAGE_NUMBER || "";

  const tokens = JSON.parse(fs.readFileSync(path.join(root, "data/shopee_tokens.json"), "utf8"));
  const shopId = arg("shop") || Object.keys(tokens)[0];
  const rj = await refreshToken(shopId, tokens[shopId].refresh_token);
  const accessToken = rj.access_token || tokens[shopId].access_token;
  if (!accessToken) {
    console.error("Cannot get access_token", rj);
    process.exit(1);
  }

  if (!orderSn && (hasFlag("auto-ghn") || hasFlag("auto"))) {
    console.log("[probe] Đang tìm đơn GHN từ APP_URL…");
    const found = await findGhnOrderFromApp(accessToken, shopId);
    if (!found) {
      console.error("Không tìm thấy đơn GHN. Truyền --order=ORDER_SN");
      process.exit(1);
    }
    orderSn = found.orderSn;
    if (!packageNumber) packageNumber = found.packageNumber || "";
    console.log("[probe] Picked:", JSON.stringify(found, null, 2));
  }

  if (!orderSn) {
    console.error("Thiếu mã đơn. Ví dụ:");
    console.error("  node scripts/probe-get-tracking-number.mjs --order=2607207181SXFP");
    console.error("  node scripts/probe-get-tracking-number.mjs --auto-ghn");
    process.exit(1);
  }

  console.log("[probe] shop=", shopId, "order=", orderSn, "pkg=", packageNumber || "-");

  const requestTime = new Date();
  const extra = {
    order_sn: orderSn,
    response_optional_fields: "plp_number,first_mile_tracking_number,last_mile_tracking_number",
  };
  if (packageNumber) extra.package_number = packageNumber;

  const result = await shopeeGet(
    "/api/v2/logistics/get_tracking_number",
    shopId,
    accessToken,
    extra,
  );

  const out = {
    api_category: "Logistics",
    api_name: "v2.logistics.get_tracking_number",
    order_sn: orderSn,
    package_number: packageNumber || null,
    shop_id: shopId,
    request: result.request,
    response: result.response,
    request_id: result.response?.request_id || null,
    request_time: requestTime.toISOString(),
    request_time_local: requestTime.toLocaleString("vi-VN", {
      timeZone: "Asia/Ho_Chi_Minh",
    }),
  };

  fs.writeFileSync(
    path.join(root, "scripts/_last-tracking-probe.json"),
    JSON.stringify(out, null, 2),
  );
  printTicket(out);

  const tn = result.response?.response?.tracking_number;
  if (tn === "" || tn == null) {
    console.log("[probe] tracking_number RỖNG — dùng khối trên để paste ticket.");
  } else {
    console.log(`[probe] tracking_number hiện có: ${tn} (API đang trả mã, chưa tái hiện empty).`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
