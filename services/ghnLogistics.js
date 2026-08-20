/**
 * GHN Open API — tạo đơn + in vận đơn PDF gốc (gen-token → printA5/printA6).
 * Tài liệu: https://api.ghn.vn/home/docs/detail?id=100 (gen-token)
 *           https://api.ghn.vn/home/docs/detail?id=63  (create order)
 * TUYỆT ĐỐI không vẽ barcode HTML — chỉ trả URL in chuẩn của GHN.
 */
import { loadLogisticsConfig } from "./logisticsConfig.js";

const TIMEOUT_MS = 15_000;
const PRINT_FORMATS = {
  a5: "printA5",
  a6: "printA6",
  "80x80": "print80x80",
  "52x70": "print52x70",
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

async function ghnCreds() {
  const { ghn } = await loadLogisticsConfig();
  return ghn;
}

async function ghnFetch(apiUrl, path, { method = "POST", token, shopId, body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const headers = {
    "Content-Type": "application/json",
    Token: String(token || "").trim(),
  };
  if (shopId) headers.ShopId = String(shopId).trim();
  try {
    const res = await fetch(`${apiUrl}${path}`, {
      method,
      headers,
      body: body != null ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    return { ok: res.ok, status: res.status, json };
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(`GHN API timeout (>${TIMEOUT_MS}ms) ${path}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function requiredNoteFromText(note) {
  const s = String(note || "").toUpperCase();
  if (s.includes("THU HANG") || s.includes("THỬ")) return "CHOTHUHANG";
  if (s.includes("KHONGCHOXEM") || s.includes("KHÔNG CHO XEM")) return "KHONGCHOXEMHANG";
  return "CHOXEMHANGKHONGTHU";
}

/**
 * Tạo vận đơn GHN. Trả order_code (mã vận đơn thật).
 */
export async function createGhnShippingOrder({
  clientOrderCode,
  customer,
  address,
  items,
  weightGrams,
  codAmount,
  note,
  shippingFeePayer,
}) {
  const creds = await ghnCreds();
  if (!creds.token) {
    throw new Error("Thiếu GHN_TOKEN. Vào Cài đặt → lưu Token GHN hoặc set env GHN_TOKEN.");
  }
  if (!creds.shopId) {
    throw new Error("Thiếu GHN_SHOP_ID. Vào Cài đặt → lưu Shop ID GHN hoặc set env GHN_SHOP_ID.");
  }

  const districtId = Number(address?.districtCode || address?.to_district_id);
  const wardCode = String(address?.wardCode || address?.to_ward_code || "").trim();
  const toAddress = String(address?.street || address?.fullAddress || "").trim();
  const serviceTypeId = creds.service === "fast" ? 1 : 2;
  const paymentTypeId = shippingFeePayer === "shop" ? 1 : 2;
  const weight = Math.max(1, Math.round(Number(weightGrams) || 500));
  const itemRows = (Array.isArray(items) ? items : []).slice(0, 50).map((it) => ({
    name: String(it.productTitle || it.name || "Hàng hóa").slice(0, 120),
    code: String(it.sku || it.productId || "").slice(0, 50),
    quantity: Math.max(1, Math.round(Number(it.quantity) || 1)),
    price: Math.max(0, Math.round(Number(it.price) || 0)),
    weight: Math.max(1, Math.round(weight / Math.max(1, items.length))),
  }));

  const body = {
    payment_type_id: paymentTypeId,
    required_note: requiredNoteFromText(note),
    client_order_code: String(clientOrderCode || "").slice(0, 50),
    to_name: String(customer?.name || "").slice(0, 80),
    to_phone: String(customer?.phone || "").replace(/\s+/g, "").slice(0, 20),
    to_address: toAddress.slice(0, 200),
    to_ward_code: wardCode,
    to_ward_name: String(address?.ward || "").trim(),
    to_district_name: String(address?.district || "").trim(),
    to_province_name: String(address?.province || "").trim(),
    cod_amount: Math.max(0, Math.round(Number(codAmount) || 0)),
    weight,
    length: 10,
    width: 10,
    height: 10,
    service_type_id: serviceTypeId,
    note: String(note || "").slice(0, 200),
    content: itemRows.map((r) => r.name).join(", ").slice(0, 200),
    items: itemRows,
  };
  if (Number.isFinite(districtId) && districtId > 0) {
    body.to_district_id = districtId;
  }

  const result = await ghnFetch(creds.apiUrl, "/v2/shipping-order/create", {
    token: creds.token,
    shopId: creds.shopId,
    body,
  });
  const code = Number(result.json?.code);
  const orderCode = String(
    result.json?.data?.order_code ||
      result.json?.data?.order_codes?.[0] ||
      "",
  ).trim();
  if (!result.ok || code !== 200 || !orderCode) {
    const msg =
      result.json?.message ||
      result.json?.code_message ||
      result.json?.msg ||
      `GHN tạo đơn thất bại (HTTP ${result.status})`;
    throw new Error(String(msg));
  }
  return {
    provider: "ghn",
    trackingNo: orderCode,
    orderCode,
    fee: Number(result.json?.data?.total_fee || result.json?.data?.fee || 0) || 0,
    expectedDelivery: result.json?.data?.expected_delivery_time || null,
    raw: result.json?.data || null,
  };
}

/**
 * Gọi gen-token rồi ghép URL in A5/A6 gốc của GHN.
 * Token in hết hạn ~30 phút — luôn gen mới khi user bấm In.
 */
export async function getGhnPrintUrl(orderCode, format = "a5") {
  const creds = await ghnCreds();
  if (!creds.token) {
    throw new Error("Thiếu GHN_TOKEN để in vận đơn.");
  }
  const code = String(orderCode || "").trim();
  if (!code) throw new Error("Thiếu mã vận đơn GHN (order_code).");

  const key = String(format || "a5").toLowerCase();
  const printPath = PRINT_FORMATS[key] || PRINT_FORMATS.a5;

  const result = await ghnFetch(creds.apiUrl, "/v2/a5/gen-token", {
    token: creds.token,
    shopId: creds.shopId || undefined,
    body: { order_codes: [code] },
  });
  const token = String(result.json?.data?.token || "").trim();
  if (!token) {
    const msg =
      result.json?.message ||
      result.json?.code_message ||
      `GHN gen-token thất bại (HTTP ${result.status})`;
    throw new Error(String(msg));
  }
  await sleep(80);
  const url = `${creds.printHost}/a5/public-api/${printPath}?token=${encodeURIComponent(token)}`;
  return { url, token, format: printPath, expiresInSec: 1800 };
}

export { sleep as ghnSleep };
