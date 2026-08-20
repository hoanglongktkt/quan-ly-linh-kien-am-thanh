/**
 * SPX Express Open API — tạo đơn + lấy waybill PDF gốc (URL hoặc Base64 của hãng).
 * Auth: HMAC-SHA256(user_id + timestamp + body, secret) — User ID / Secret trên MongoDB.
 * TUYỆT ĐỐI không đọc process.env.SPX_*. Không vẽ barcode HTML.
 */
import crypto from "crypto";
import { loadSpxCredentialsFromMongo } from "./logisticsConfig.js";

const TIMEOUT_MS = 15_000;
const MAX_CREATE_PATHS = 3;
const MAX_WAYBILL_PATHS = 4;
const MAX_WAYBILL_BODIES = 4;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function signBody(appId, secret, timestamp, rawBody) {
  const payload = `${appId}${timestamp}${rawBody}`;
  return crypto.createHmac("sha256", String(secret)).update(payload).digest("hex");
}

function pickSpxAppId(creds) {
  return String(creds?.clientId || creds?.userId || creds?.appId || "").trim();
}

function pickSpxSecret(creds) {
  return String(creds?.clientSecret || creds?.secret || "").trim();
}

async function spxFetch(apiUrl, path, bodyObj, creds) {
  const appId = pickSpxAppId(creds);
  const secret = pickSpxSecret(creds);
  if (!appId || !secret) {
    throw new Error(
      "Thiếu SPX User ID / Secret trên Database. Vào Cài đặt → nhập User ID (hoặc Client ID) và Secret rồi bấm Lưu cấu hình SPX.",
    );
  }
  const rawBody = JSON.stringify(bodyObj || {});
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sign = signBody(appId, secret, timestamp, rawBody);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${apiUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "app-id": appId,
        appid: appId,
        "user-id": appId,
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
      first?.order_sn ||
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

function buildItemList(items, fallbackWeight) {
  const rows = (Array.isArray(items) ? items : []).slice(0, 50);
  if (!rows.length) {
    return [
      {
        item_name: "Hang hoa",
        name: "Hang hoa",
        quantity: 1,
        item_quantity: 1,
        price: 0,
        item_price: 0,
        weight: Math.max(1, Math.round(Number(fallbackWeight) || 500)),
        item_weight: Math.max(1, Math.round(Number(fallbackWeight) || 500)),
      },
    ];
  }
  return rows.map((it) => {
    const name = String(it.productTitle || it.name || "Hang hoa").slice(0, 120);
    const qty = Math.max(1, Math.round(Number(it.quantity) || 1));
    const price = Math.max(0, Math.round(Number(it.price) || 0));
    const weight = Math.max(
      1,
      Math.round(Number(it.weightGrams || it.weight || it.item_weight) || 100),
    );
    return {
      item_name: name,
      name,
      quantity: qty,
      item_quantity: qty,
      price,
      item_price: price,
      weight,
      item_weight: weight,
    };
  });
}

function buildReceiverAddress(address) {
  return [
    address?.street,
    address?.ward,
    address?.district,
    address?.province,
  ]
    .filter(Boolean)
    .join(", ");
}

/**
 * Tạo vận đơn SPX Express. Trả tracking_no thật từ hãng.
 * Credentials: chỉ MongoDB (User ID / Secret hoặc Client ID / Client Secret).
 */
export async function createSpxShippingOrder({
  clientOrderCode,
  customer,
  address,
  items,
  weightGrams,
  codAmount,
  note,
  allowInspect,
  creds: credsIn,
}) {
  const creds = credsIn || (await loadSpxCredentialsFromMongo());
  const apiUrl = creds.apiUrl;
  const userId = pickSpxAppId(creds);
  const weight = Math.max(1, Math.round(Number(weightGrams) || 500));
  const itemList = buildItemList(items, weight);
  const receiverAddress = buildReceiverAddress(address) || String(address?.street || "").trim();
  if (!receiverAddress) {
    throw new Error("Thiếu địa chỉ người nhận (receiver_address) để tạo đơn SPX.");
  }

  const orderRow = {
    order_sn: String(clientOrderCode || "").slice(0, 50),
    merchant_id: creds.merchantId || undefined,
    user_id: userId || undefined,
    weight,
    allow_inspect: allowInspect !== false && allowInspect !== "false",
    cod_amount: Math.max(0, Math.round(Number(codAmount) || 0)),
    receiver_name: String(customer?.name || "").slice(0, 80),
    receiver_phone: String(customer?.phone || "").replace(/\s+/g, "").slice(0, 20),
    receiver_address: receiverAddress,
    item_list: itemList,
    remark: String(note || "").slice(0, 200),
  };

  const payloads = [{ user_id: userId || undefined, orders: [orderRow] }, { ...orderRow, user_id: userId || undefined }];
  const paths = [
    "/open/api/v1/order/create_order",
    "/open/api/v1/order/batch_create_order",
    "/open/api/order/create_order",
  ].slice(0, MAX_CREATE_PATHS);

  let lastErr = "SPX tạo đơn thất bại";
  for (let i = 0; i < paths.length; i += 1) {
    for (let p = 0; p < payloads.length; p += 1) {
      if (i + p > 0) await sleep(250);
      const result = await spxFetch(apiUrl, paths[i], payloads[p], creds);
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
  }
  throw new Error(String(lastErr));
}

/**
 * Lấy link PDF / Base64 vận đơn gốc từ SPX theo tracking_no.
 */
export async function getSpxWaybill(trackingNo) {
  const creds = await loadSpxCredentialsFromMongo();
  const tn = String(trackingNo || "").trim();
  if (!tn) throw new Error("Thiếu mã vận đơn SPX (tracking_no).");

  const payloads = [
    { tracking_no_list: [tn] },
    { tracking_nos: [tn] },
    { order_list: [{ tracking_no: tn }] },
    { tracking_no: tn },
  ].slice(0, MAX_WAYBILL_BODIES);
  const paths = [
    "/open/api/v1/order/batch_get_awb",
    "/open/api/v1/order/get_awb",
    "/open/api/order/batch_get_awb",
    "/open/api/v1/order/print_label",
  ].slice(0, MAX_WAYBILL_PATHS);

  let lastErr = "SPX không trả waybill";
  for (let p = 0; p < paths.length; p += 1) {
    for (let b = 0; b < payloads.length; b += 1) {
      if (p + b > 0) await sleep(200);
      const result = await spxFetch(creds.apiUrl, paths[p], payloads[b], creds);
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
