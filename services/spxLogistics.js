/**
 * SPX Express Open API — tạo đơn + lấy waybill PDF gốc (URL hoặc Base64 của hãng).
 * Auth: HMAC-SHA256(user_id + timestamp + body, secret) — User ID / Secret trên MongoDB.
 * TUYỆT ĐỐI không đọc process.env.SPX_*. Không vẽ barcode HTML.
 */
import crypto from "crypto";
import axios from "axios";
import { loadSpxCredentialsFromMongo } from "./logisticsConfig.js";

const TIMEOUT_MS = 15_000;
/** Host VN trong tài liệu Open API đối tác. Path tạo đơn chuẩn là batch_create_order (kể cả 1 đơn). */
const SPX_DEFAULT_HOST = "https://spx.vn";
const SPX_CREATE_ORDER_PATH = "/open/api/v1/order/batch_create_order";
const SPX_FORBIDDEN_CREATE_PATH = "/open/api/v1/order/create_order";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

/**
 * Ghép host + path từ DB / form. Không bao giờ gọi path giả create_order trên website spx.vn.
 * apiUrl có thể là host (https://spx.vn) hoặc full URL endpoint từ tài liệu đối tác.
 */
export function resolveSpxGateway({ apiUrl, createPath } = {}) {
  let host = String(apiUrl || "").trim();
  let path = String(createPath || "").trim();

  if (/^https?:\/\//i.test(host)) {
    try {
      const parsed = new URL(host);
      const pathname = String(parsed.pathname || "").replace(/\/$/, "");
      host = `${parsed.protocol}//${parsed.host}`.replace(/\/$/, "");
      if (!path && pathname && pathname !== "/") {
        path = pathname;
      }
    } catch {
      host = host.replace(/\/$/, "");
    }
  } else {
    host = host.replace(/\/$/, "");
  }

  if (!host) host = SPX_DEFAULT_HOST;
  if (!path || path === SPX_FORBIDDEN_CREATE_PATH || /\/order\/create_order\/?$/i.test(path)) {
    path = SPX_CREATE_ORDER_PATH;
  }
  if (!path.startsWith("/")) path = `/${path}`;

  return { host, path, url: `${host}${path}` };
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
  const gateway = resolveSpxGateway({
    apiUrl: creds.apiUrl,
    createPath: creds.createPath,
  });
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

  const payload = { user_id: userId || undefined, orders: [orderRow] };
  const result = await spxFetch(gateway.host, gateway.path, payload, creds);
  if (result.status === 404) {
    throw new Error(
      `SPX HTTP 404 tại ${gateway.url}. Nhập đúng API Gateway URL từ tài liệu đối tác SPX (Cài đặt → Logistics).`,
    );
  }
  if (!isSpxSuccess(result.json)) {
    throw new Error(
      String(
        result.json?.message ||
          result.json?.msg ||
          result.json?.error ||
          `SPX ${gateway.path} HTTP ${result.status}`,
      ),
    );
  }
  const data = result.json?.data || result.json;
  const trackingNo = pickTracking(data);
  if (!trackingNo) {
    throw new Error("SPX tạo đơn xong nhưng không trả tracking_no");
  }
  const waybill = pickWaybill(data);
  return {
    provider: "spx",
    trackingNo,
    orderCode: trackingNo,
    url: waybill.url,
    base64: waybill.base64,
    raw: data,
  };
}

/**
 * Phiếu in SPX lấy từ response create_order (awb_url / file_data) đã lưu trên đơn.
 * Không gọi endpoint giả batch_get_awb / get_awb / print_label.
 */
export async function getSpxWaybill(trackingNo, storedWaybill) {
  const tn = String(trackingNo || "").trim();
  if (!tn) throw new Error("Thiếu mã vận đơn SPX (tracking_no).");
  const picked = pickWaybill(storedWaybill && typeof storedWaybill === "object" ? storedWaybill : {});
  if (picked.url || picked.base64) {
    return { ...picked, trackingNo: tn, raw: storedWaybill || null };
  }
  throw new Error(
    "Không có phiếu vận đơn SPX từ lúc tạo đơn (create_order). Hệ thống không gọi endpoint giả batch_get_awb.",
  );
}

function isBlankSpxSecret(value) {
  const s = String(value || "").trim();
  return !s || s.includes("••••");
}

function looksLikeHtmlPayload(value) {
  const s = String(value || "").trimStart();
  return (
    s.startsWith("<") ||
    /^<!doctype\s+html/i.test(s) ||
    /<html[\s>]/i.test(s)
  );
}

function isSpxAuthFailure(httpStatus, json) {
  if (httpStatus === 401 || httpStatus === 403) return true;
  if (!json || typeof json !== "object") return false;
  const ret = json.ret_code ?? json.retcode ?? json.code;
  if (ret === 401 || ret === 403 || ret === "401" || ret === "403") return true;
  const msg = String(json.message || json.msg || json.error || "").toLowerCase();
  if (!msg || looksLikeHtmlPayload(msg)) return false;
  return /unauthor|forbidden|invalid sign|sign error|signature|invalid.*(secret|app-id|appid|user.?id)/i.test(
    msg,
  );
}

function classifySpxTestFailure(error) {
  const status = Number(error?.response?.status) || 0;
  const rawData = error?.response?.data;
  if (status) {
    console.error("[SPX test] HTTP error", status, rawData);
  }
  const text =
    typeof rawData === "string"
      ? rawData
      : rawData != null && typeof rawData === "object"
        ? ""
        : String(rawData || "");

  if (error?.response) {
    if (status === 404) {
      return {
        success: false,
        httpStatus: 404,
        message: "Lỗi 404: Sai API Gateway URL hoặc Path. Máy chủ từ chối kết nối.",
      };
    }
    if (status === 401 || status === 403) {
      return {
        success: false,
        httpStatus: status,
        message: "Lỗi 401/403: Sai User ID hoặc Secret Key (Chữ ký HMAC không khớp).",
      };
    }
    if (looksLikeHtmlPayload(text) || error?.isJsonParseError) {
      return {
        success: false,
        httpStatus: status,
        message: "Lỗi Data: Máy chủ SPX trả về định dạng không hợp lệ (HTML). Sai API Gateway URL.",
      };
    }
    return {
      success: false,
      httpStatus: status,
      message: `Lỗi HTTP ${status}: Vui lòng kiểm tra lại cấu hình.`,
    };
  }

  if (
    error?.isJsonParseError ||
    error?.name === "SyntaxError" ||
    looksLikeHtmlPayload(error?.message)
  ) {
    return {
      success: false,
      httpStatus: 0,
      message: "Lỗi Data: Máy chủ SPX trả về định dạng không hợp lệ (HTML). Sai API Gateway URL.",
    };
  }
  if (error?.code === "ECONNABORTED") {
    return {
      success: false,
      httpStatus: 0,
      message: `Timeout kết nối máy chủ SPX (>${TIMEOUT_MS}ms)`,
    };
  }
  return {
    success: false,
    httpStatus: 0,
    message: error?.message || "Kiểm tra kết nối SPX thất bại",
  };
}

/**
 * Ping thật tới máy chủ SPX (HMAC-SHA256 + Axios).
 * Chỉ trả success:true khi HTTP status === 200 từ SPX và không phải lỗi 401/403.
 */
export async function testSpxConnection({ userId, secret, apiUrl, createPath } = {}) {
  const uid = String(userId || "").trim();
  const sec = String(secret || "").trim();
  if (isBlankSpxSecret(uid) || isBlankSpxSecret(sec)) {
    return {
      success: false,
      httpStatus: 0,
      message: "Vui lòng nhập User ID và Secret",
    };
  }

  const gateway = resolveSpxGateway({ apiUrl, createPath });
  const body = { user_id: uid };
  const rawBody = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sign = signBody(uid, sec, timestamp, rawBody);

  try {
    const response = await axios.post(gateway.url, rawBody, {
      timeout: TIMEOUT_MS,
      responseType: "text",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "app-id": uid,
        appid: uid,
        "user-id": uid,
        timestamp,
        sign,
      },
      transformRequest: [(data) => data],
    });
    const httpStatus = Number(response.status) || 0;
    const text = String(response.data ?? "");
    if (looksLikeHtmlPayload(text)) {
      return {
        success: false,
        httpStatus: httpStatus || 0,
        message: "Lỗi Data: Máy chủ SPX trả về định dạng không hợp lệ (HTML). Sai API Gateway URL.",
      };
    }
    let json = null;
    try {
      json = text ? JSON.parse(text) : {};
    } catch (parseErr) {
      parseErr.isJsonParseError = true;
      return classifySpxTestFailure(parseErr);
    }
    if (isSpxAuthFailure(httpStatus, json)) {
      return {
        success: false,
        httpStatus: httpStatus || 401,
        message: "Lỗi 401/403: Sai User ID hoặc Secret Key (Chữ ký HMAC không khớp).",
      };
    }
    if (httpStatus === 200) {
      return {
        success: true,
        httpStatus: 200,
        message: "Kết nối SPX thành công!",
      };
    }
    return {
      success: false,
      httpStatus,
      message: `Lỗi HTTP ${httpStatus}: Vui lòng kiểm tra lại cấu hình.`,
    };
  } catch (error) {
    return classifySpxTestFailure(error);
  }
}

export { sleep as spxSleep };
