/**
 * SPX Express Open API — tạo đơn + lấy waybill PDF gốc (URL hoặc Base64 của hãng).
 * Auth: HMAC-SHA256(app_id + timestamp + body, secret) — chuẩn Open API merchant SPX VN.
 * Endpoint mặc định: {SPX_API_URL}/open/api/v1/...
 * TUYỆT ĐỐI không vẽ barcode HTML — chỉ trả PDF/URL gốc từ SPX.
 */
import crypto from "crypto";
import { loadLogisticsConfig } from "./logisticsConfig.js";

const TIMEOUT_MS = 15_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function spxCreds() {
  const { spx } = loadLogisticsConfig();
  return spx;
}

function signBody(appId, secret, timestamp, rawBody) {
  const payload = `${appId}${timestamp}${rawBody}`;
  return crypto.createHmac("sha256", String(secret)).update(payload).digest("hex");
}

async function spxFetch(apiUrl, path, bodyObj) {
  const creds = spxCreds();
  if (!creds.userId || !creds.secret) {
    throw new Error(
      "Thiếu SPX User ID / Secret. Vào Cài đặt → lưu SPX hoặc set env SPX_USER_ID + SPX_SECRET.",
    );
  }
  const rawBody = JSON.stringify(bodyObj || {});
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sign = signBody(creds.userId, creds.secret, timestamp, rawBody);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${apiUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "app-id": creds.userId,
        appid: creds.userId,
        timestamp,
        sign,
      },
      body: rawBody,
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
      throw new Error(`SPX API timeout (>${TIMEOUT_MS}ms) ${path}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function isSpxSuccess(json) {
  const ret = json?.ret_code ?? json?.retcode ?? json?.code;
  if (ret === 0 || ret === "0" || ret === 200) return true;
  if (json?.success === true) return true;
  return false;
}

function pickTracking(data) {
  if (!data || typeof data !== "object") return "";
  const list = data.orders || data.order_list || data.tracking_no_list || data.data;
  const first = Array.isArray(list) ? list[0] : data;
  return String(
    first?.tracking_no ||
      first?.tracking_number ||
      first?.waybill_no ||
      first?.spx_tn ||
      data.tracking_no ||
      data.tracking_number ||
      "",
  ).trim();
}

function pickWaybill(data) {
  if (!data || typeof data !== "object") return { url: "", base64: "" };
  const list = data.awb_list || data.waybill_list || data.orders || data.list;
  const first = Array.isArray(list) ? list[0] : data;
  const url = String(
    first?.awb_url ||
      first?.waybill_url ||
      first?.pdf_url ||
      first?.file_url ||
      first?.print_url ||
      data.awb_url ||
      data.waybill_url ||
      data.pdf_url ||
      "",
  ).trim();
  const base64 = String(
    first?.awb_file ||
      first?.awb_base64 ||
      first?.file_data ||
      first?.pdf_base64 ||
      first?.label_base64 ||
      data.awb_file ||
      data.file_data ||
      "",
  ).trim();
  return { url, base64 };
}

/**
 * Tạo vận đơn SPX Express. Trả tracking_no thật từ hãng.
 */
export async function createSpxShippingOrder({
  clientOrderCode,
  customer,
  address,
  items,
  weightGrams,
  codAmount,
  note,
}) {
  const creds = spxCreds();
  const apiUrl = creds.apiUrl;
  const itemName = (Array.isArray(items) ? items : [])
    .map((it) => String(it.productTitle || it.name || "Hàng").slice(0, 80))
    .join(", ")
    .slice(0, 200);
  const body = {
    orders: [
      {
        order_id: String(clientOrderCode || "").slice(0, 50),
        merchant_id: creds.merchantId || undefined,
        payment_role: 0,
        cod_collection: Number(codAmount) > 0 ? 1 : 0,
        cod_amount: Math.max(0, Math.round(Number(codAmount) || 0)),
        item_name: itemName || "Hang hoa",
        item_weight: Math.max(1, Math.round(Number(weightGrams) || 500)),
        parcel_weight: Math.max(1, Math.round(Number(weightGrams) || 500)),
        remark: String(note || "").slice(0, 200),
        deliver_info: {
          deliver_name: String(customer?.name || "").slice(0, 80),
          deliver_phone: String(customer?.phone || "").replace(/\s+/g, "").slice(0, 20),
          deliver_detail_address: String(address?.street || "").trim(),
          deliver_address: [
            address?.street,
            address?.ward,
            address?.district,
            address?.province,
          ]
            .filter(Boolean)
            .join(", "),
          deliver_ward: String(address?.ward || "").trim(),
          deliver_district: String(address?.district || "").trim(),
          deliver_province: String(address?.province || "").trim(),
          deliver_ward_id: String(address?.wardCode || "").trim(),
          deliver_district_id: String(address?.districtCode || "").trim(),
          deliver_province_id: String(address?.provinceCode || "").trim(),
        },
      },
    ],
  };

  const paths = [
    "/open/api/v1/order/create_order",
    "/open/api/v1/order/batch_create_order",
    "/open/api/order/create_order",
  ];
  let lastErr = "SPX tạo đơn thất bại";
  for (let i = 0; i < paths.length; i += 1) {
    if (i > 0) await sleep(250);
    const result = await spxFetch(apiUrl, paths[i], body);
    if (isSpxSuccess(result.json)) {
      const trackingNo = pickTracking(result.json?.data || result.json);
      if (trackingNo) {
        return {
          provider: "spx",
          trackingNo,
          orderCode: trackingNo,
          raw: result.json?.data || result.json,
        };
      }
      lastErr = "SPX tạo đơn xong nhưng không trả tracking_no";
      continue;
    }
    lastErr =
      result.json?.message ||
      result.json?.msg ||
      result.json?.error ||
      `SPX ${paths[i]} HTTP ${result.status}`;
  }
  throw new Error(String(lastErr));
}

/**
 * Lấy link PDF / Base64 vận đơn gốc từ SPX theo tracking_no.
 */
export async function getSpxWaybill(trackingNo) {
  const creds = spxCreds();
  const tn = String(trackingNo || "").trim();
  if (!tn) throw new Error("Thiếu mã vận đơn SPX (tracking_no).");

  const payloads = [
    { tracking_no_list: [tn] },
    { tracking_nos: [tn] },
    { order_list: [{ tracking_no: tn }] },
    { tracking_no: tn },
  ];
  const paths = [
    "/open/api/v1/order/batch_get_awb",
    "/open/api/v1/order/get_awb",
    "/open/api/order/batch_get_awb",
    "/open/api/v1/order/print_label",
  ];

  let lastErr = "SPX không trả waybill";
  for (let p = 0; p < paths.length; p += 1) {
    for (let b = 0; b < payloads.length; b += 1) {
      if (p + b > 0) await sleep(200);
      const result = await spxFetch(creds.apiUrl, paths[p], payloads[b]);
      if (!isSpxSuccess(result.json) && result.status >= 400) {
        lastErr =
          result.json?.message ||
          result.json?.msg ||
          `SPX ${paths[p]} HTTP ${result.status}`;
        continue;
      }
      const picked = pickWaybill(result.json?.data || result.json);
      if (picked.url || picked.base64) {
        return { ...picked, trackingNo: tn, raw: result.json?.data || null };
      }
      lastErr =
        result.json?.message ||
        result.json?.msg ||
        "SPX waybill rỗng (không có awb_url / file_data)";
    }
  }
  throw new Error(String(lastErr));
}

export { sleep as spxSleep };
