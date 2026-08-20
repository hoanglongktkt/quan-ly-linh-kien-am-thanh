/**
 * GHN Open API — tạo đơn + in vận đơn PDF gốc (gen-token → printA5/printA6).
 * Tài liệu: https://api.ghn.vn/home/docs/detail?id=63  (create order)
 * TUYỆT ĐỐI không đẩy mã hành chính VN (provinces.open-api.vn) lên GHN.
 * DistrictID / WardCode phải resolve từ GHN Master Data.
 */
import axios from "axios";
import { loadLogisticsConfig } from "./logisticsConfig.js";

const TIMEOUT_MS = 15_000;
const GHN_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_DISTRICT_SCAN = 40;
const PRINT_FORMATS = {
  a5: "printA5",
  a6: "printA6",
  "80x80": "print80x80",
  "52x70": "print52x70",
};

const ALIASES = {
  hcm: "ho chi minh",
  tphcm: "ho chi minh",
  "tp hcm": "ho chi minh",
  "tp ho chi minh": "ho chi minh",
  "sai gon": "ho chi minh",
  hn: "ha noi",
  "tp ha noi": "ha noi",
  dn: "da nang",
  "tp da nang": "da nang",
};

let ghnMasterCache = {
  at: 0,
  tokenKey: "",
  provinces: [],
  districts: new Map(),
  wards: new Map(),
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

async function ghnCreds() {
  const { ghn } = await loadLogisticsConfig();
  return ghn;
}

function normalizeVnName(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function unitName(unit) {
  return String(
    unit?.ProvinceName ||
      unit?.province_name ||
      unit?.DistrictName ||
      unit?.district_name ||
      unit?.WardName ||
      unit?.ward_name ||
      unit?.name ||
      "",
  ).trim();
}

function matchNamedUnit(list, query) {
  if (!query?.trim() || !Array.isArray(list) || !list.length) return null;
  const raw = normalizeVnName(query);
  const expanded = ALIASES[raw] || raw;
  const stripPrefix = (n) =>
    n.replace(/^(tinh|thanh pho|tp|quan|huyen|thi xa|phuong|xa|thi tran)\s+/, "");

  let best = null;
  let bestScore = 0;
  for (let i = 0; i < list.length; i += 1) {
    const n = normalizeVnName(unitName(list[i]));
    if (!n) continue;
    let score = 0;
    if (n === expanded || n === raw) score = 100;
    else if (n.includes(expanded) || expanded.includes(n)) score = 80;
    else {
      const stripped = stripPrefix(n);
      const qStripped = stripPrefix(expanded);
      if (stripped === qStripped || stripped === expanded) score = 70;
      else if (stripped.includes(qStripped) || qStripped.includes(stripped)) score = 60;
    }
    if (score > bestScore) {
      bestScore = score;
      best = list[i];
    }
  }
  return bestScore >= 60 ? best : null;
}

function getMasterCache(token) {
  const tokenKey = String(token || "").slice(0, 12);
  const now = Date.now();
  if (
    !ghnMasterCache ||
    ghnMasterCache.tokenKey !== tokenKey ||
    now - ghnMasterCache.at > GHN_CACHE_TTL_MS
  ) {
    ghnMasterCache = {
      at: now,
      tokenKey,
      provinces: [],
      districts: new Map(),
      wards: new Map(),
    };
  }
  return ghnMasterCache;
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

async function ghnMasterList(creds, path, body) {
  const result = await ghnFetch(creds.apiUrl, path, {
    method: "POST",
    token: creds.token,
    shopId: creds.shopId || undefined,
    body: body || {},
  });
  const data = result.json?.data;
  return Array.isArray(data) ? data : [];
}

async function loadGhnProvinces(creds) {
  const cache = getMasterCache(creds.token);
  if (cache.provinces.length) return cache.provinces;
  const rows = await ghnMasterList(creds, "/master-data/province", {});
  cache.provinces = rows;
  return rows;
}

async function loadGhnDistricts(creds, provinceId) {
  const key = String(provinceId);
  const cache = getMasterCache(creds.token);
  if (cache.districts.has(key)) return cache.districts.get(key) || [];
  const rows = await ghnMasterList(creds, "/master-data/district", {
    province_id: Number(provinceId) || provinceId,
  });
  const filtered = rows.filter(
    (d) => String(d.ProvinceID ?? d.province_id ?? "") === String(provinceId),
  );
  const list = filtered.length ? filtered : rows;
  cache.districts.set(key, list);
  return list;
}

async function loadGhnWards(creds, districtId) {
  const key = String(districtId);
  const cache = getMasterCache(creds.token);
  if (cache.wards.has(key)) return cache.wards.get(key) || [];
  const rows = await ghnMasterList(creds, "/master-data/ward", {
    district_id: Number(districtId) || districtId,
  });
  cache.wards.set(key, rows);
  return rows;
}

function pickDistrictId(unit) {
  const n = Number(unit?.DistrictID ?? unit?.district_id ?? unit?.id);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function pickWardCode(unit) {
  return String(unit?.WardCode ?? unit?.ward_code ?? unit?.id ?? "").trim();
}

/**
 * Resolve tên Tỉnh/Huyện/Xã → DistrictID + WardCode chuẩn GHN.
 * Không bao giờ trả mã hành chính VN.
 */
export async function resolveGhnAddress(address, credsIn) {
  const creds = credsIn || (await ghnCreds());
  if (!creds?.token) {
    throw new Error("Thiếu Token GHN trên Database. Vào Cài đặt → lưu Token GHN rồi thử lại.");
  }

  const provinceName = String(address?.province || address?.to_province_name || "").trim();
  const districtName = String(address?.district || address?.to_district_name || "").trim();
  const wardName = String(address?.ward || address?.to_ward_name || "").trim();
  if (!provinceName || !wardName) {
    throw new Error("Thiếu Tỉnh/Thành hoặc Phường/Xã để map địa chỉ GHN.");
  }

  const provinces = await loadGhnProvinces(creds);
  const province = matchNamedUnit(provinces, provinceName);
  if (!province) {
    throw new Error(`GHN không nhận diện tỉnh/thành: "${provinceName}".`);
  }
  const provinceId = Number(province.ProvinceID ?? province.province_id ?? province.id);
  if (!Number.isFinite(provinceId) || provinceId <= 0) {
    throw new Error(`GHN không trả ProvinceID cho "${provinceName}".`);
  }

  await sleep(80);
  const districts = await loadGhnDistricts(creds, provinceId);
  let district = districtName ? matchNamedUnit(districts, districtName) : null;

  if (!district && wardName && districts.length) {
    const limit = Math.min(districts.length, MAX_DISTRICT_SCAN);
    for (let i = 0; i < limit; i += 1) {
      const d = districts[i];
      const did = pickDistrictId(d);
      if (!did) continue;
      if (i > 0) await sleep(120);
      const wards = await loadGhnWards(creds, did);
      const w = matchNamedUnit(wards, wardName);
      if (w && pickWardCode(w)) {
        return {
          to_district_id: did,
          to_ward_code: pickWardCode(w),
          to_ward_name: unitName(w) || wardName,
          to_district_name: unitName(d) || districtName,
          to_province_name: unitName(province) || provinceName,
        };
      }
    }
  }

  if (!district) {
    throw new Error(
      `GHN không nhận diện quận/huyện cho "${districtName || wardName}" tại ${provinceName}. Chọn đủ Tỉnh / Quận / Phường (địa chỉ 3 cấp) rồi thử lại.`,
    );
  }

  const districtId = pickDistrictId(district);
  if (!districtId) {
    throw new Error(`GHN không trả DistrictID cho "${districtName || unitName(district)}".`);
  }

  await sleep(80);
  const wards = await loadGhnWards(creds, districtId);
  const ward = matchNamedUnit(wards, wardName);
  const wardCode = ward ? pickWardCode(ward) : "";
  if (!ward || !wardCode) {
    throw new Error(
      `GHN không nhận diện phường/xã: "${wardName}" (huyện ${districtName || districtId}).`,
    );
  }

  return {
    to_district_id: districtId,
    to_ward_code: String(wardCode),
    to_ward_name: unitName(ward) || wardName,
    to_district_name: unitName(district) || districtName,
    to_province_name: unitName(province) || provinceName,
  };
}

function requiredNoteFromFlags({ note, allowInspect, allowTry }) {
  if (allowTry === true || allowTry === "true") return "CHOTHUHANG";
  if (allowInspect === false || allowInspect === "false") return "KHONGCHOXEMHANG";
  if (allowInspect === true || allowInspect === "true") return "CHOXEMHANGKHONGTHU";
  const s = String(note || "").toUpperCase();
  if (s.includes("THU HANG") || s.includes("THỬ")) return "CHOTHUHANG";
  if (s.includes("KHONGCHOXEM") || s.includes("KHÔNG CHO XEM")) return "KHONGCHOXEMHANG";
  return "CHOXEMHANGKHONGTHU";
}

function paymentTypeIdFromPayer(shippingFeePayer) {
  const payer = String(shippingFeePayer || "").toLowerCase();
  if (payer === "shop" || payer === "sender") return 1;
  return 2;
}

function clampCm(value, fallback = 10) {
  const n = Math.round(Number(value) || fallback);
  return Math.max(1, Math.min(150, n));
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
  length: lengthIn,
  width: widthIn,
  height: heightIn,
  allowInspect,
  allowTry,
  partialDelivery,
  shopId: shopIdOverride,
}) {
  const creds = await ghnCreds();
  if (!creds.token) {
    throw new Error("Thiếu Token GHN trên Database. Vào Cài đặt → lưu Token GHN rồi thử lại.");
  }
  const shopId = String(shopIdOverride || creds.shopId || "").trim();
  if (!shopId) {
    throw new Error("Thiếu Shop ID GHN. Vào Cài đặt nhập Shop ID 1/2/3 rồi chọn Kho xuất hàng khi tạo đơn.");
  }

  const resolved = await resolveGhnAddress(address, creds);
  const toAddress = String(address?.street || address?.fullAddress || "").trim();
  if (!toAddress) {
    throw new Error("Thiếu địa chỉ chi tiết người nhận (to_address).");
  }

  const serviceTypeId = creds.service === "fast" ? 1 : 2;
  const paymentTypeId = paymentTypeIdFromPayer(shippingFeePayer);
  const weight = Math.max(1, Math.round(Number(weightGrams) || 500));
  const length = clampCm(lengthIn, 10);
  const width = clampCm(widthIn, 10);
  const height = clampCm(heightIn, 10);
  const itemRows = (Array.isArray(items) ? items : []).slice(0, 50).map((it) => ({
    name: String(it.productTitle || it.name || "Hàng hóa").slice(0, 120),
    code: String(it.sku || it.productId || "").slice(0, 50),
    quantity: Math.max(1, Math.round(Number(it.quantity) || 1)),
    price: Math.max(0, Math.round(Number(it.price) || 0)),
    weight: Math.max(1, Math.round(Number(it.weightGrams || it.weight) || weight / Math.max(1, items.length))),
  }));
  if (itemRows.length === 0) {
    throw new Error("GHN yêu cầu danh sách sản phẩm (Items) không được rỗng.");
  }

  const requiredNote = requiredNoteFromFlags({
    note,
    allowInspect,
    allowTry: allowTry === true || partialDelivery === true,
  });

  const body = {
    payment_type_id: paymentTypeId,
    required_note: requiredNote,
    client_order_code: String(clientOrderCode || "").slice(0, 50),
    to_name: String(customer?.name || "").slice(0, 80),
    to_phone: String(customer?.phone || "").replace(/\s+/g, "").slice(0, 20),
    to_address: toAddress.slice(0, 200),
    to_ward_code: resolved.to_ward_code,
    to_district_id: resolved.to_district_id,
    to_ward_name: resolved.to_ward_name,
    to_district_name: resolved.to_district_name,
    to_province_name: resolved.to_province_name,
    cod_amount: Math.max(0, Math.round(Number(codAmount) || 0)),
    weight,
    length,
    width,
    height,
    service_type_id: serviceTypeId,
    note: String(note || "").slice(0, 200),
    content: itemRows.map((r) => r.name).join(", ").slice(0, 200),
    items: itemRows,
  };

  const result = await ghnFetch(creds.apiUrl, "/v2/shipping-order/create", {
    token: creds.token,
    shopId,
    body,
  });
  const code = Number(result.json?.code);
  const orderCode = String(
    result.json?.data?.order_code || result.json?.data?.order_codes?.[0] || "",
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
    shopId,
    fee: Number(result.json?.data?.total_fee || result.json?.data?.fee || 0) || 0,
    expectedDelivery: result.json?.data?.expected_delivery_time || null,
    resolvedAddress: resolved,
    raw: result.json?.data || null,
  };
}

/**
 * Gọi gen-token rồi ghép URL in A5/A6 gốc của GHN.
 * Token in hết hạn ~30 phút — luôn gen mới khi user bấm In.
 */
export async function getGhnPrintUrl(orderCode, format = "a5", shopIdOverride) {
  const creds = await ghnCreds();
  if (!creds.token) {
    throw new Error("Thiếu Token GHN để in vận đơn.");
  }
  const code = String(orderCode || "").trim();
  if (!code) throw new Error("Thiếu mã vận đơn GHN (order_code).");

  const key = String(format || "a5").toLowerCase();
  const printPath = PRINT_FORMATS[key] || PRINT_FORMATS.a5;
  const shopId = String(shopIdOverride || creds.shopId || "").trim();

  const result = await ghnFetch(creds.apiUrl, "/v2/a5/gen-token", {
    token: creds.token,
    shopId: shopId || undefined,
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

const GHN_SHOP_ALL_URL = "https://online-gateway.ghn.vn/shiip/public-api/v2/shop/all";

function isBlankGhnSecret(value) {
  const s = String(value || "").trim();
  return !s || s.includes("••••") || s.startsWith("ghn-tok-");
}

/**
 * Ping thật tới máy chủ GHN (POST /v2/shop/all — tài liệu chính thức GHN).
 * Chỉ trả success:true khi HTTP status === 200 VÀ body.code === 200 từ GHN.
 */
export async function testGhnConnection({ token, shopId } = {}) {
  const t = String(token || "").trim();
  const sid = String(shopId || "").trim();
  if (isBlankGhnSecret(t) || !sid) {
    return {
      success: false,
      httpStatus: 0,
      message: "Vui lòng nhập Token và Shop ID",
    };
  }

  try {
    const response = await axios.post(
      GHN_SHOP_ALL_URL,
      { offset: 0, limit: 50, client_phone: "" },
      {
        timeout: TIMEOUT_MS,
        headers: {
          "Content-Type": "application/json",
          Token: t,
          ShopId: sid,
        },
      },
    );

    const httpStatus = Number(response.status) || 0;
    const body = response.data && typeof response.data === "object" ? response.data : {};
    const ghnCode = Number(body.code);

    if (httpStatus !== 200) {
      return {
        success: false,
        httpStatus,
        message: body.message || `GHN HTTP ${httpStatus}`,
      };
    }
    if (ghnCode === 401) {
      return { success: false, httpStatus, message: "Token GHN không hợp lệ!" };
    }
    if (ghnCode !== 200) {
      return {
        success: false,
        httpStatus,
        message: String(body.message || body.code_message || "Token GHN không hợp lệ!"),
      };
    }

    const shops = Array.isArray(body?.data?.shops) ? body.data.shops : [];
    if (shops.length > 0) {
      const matched = shops.some(
        (shop) => String(shop?._id ?? shop?.shop_id ?? shop?.id ?? "") === sid,
      );
      if (!matched) {
        return {
          success: false,
          httpStatus,
          message: `Shop ID ${sid} không thuộc Token GHN này.`,
        };
      }
    }

    return {
      success: true,
      httpStatus: 200,
      message: "Kết nối GHN thành công!",
      shopCount: shops.length,
    };
  } catch (err) {
    const httpStatus = Number(err?.response?.status) || 0;
    if (httpStatus === 401 || Number(err?.response?.data?.code) === 401) {
      return { success: false, httpStatus: httpStatus || 401, message: "Token GHN không hợp lệ!" };
    }
    if (err?.code === "ECONNABORTED" || err?.name === "AbortError") {
      return {
        success: false,
        httpStatus: 0,
        message: `Timeout kết nối máy chủ GHN (>${TIMEOUT_MS}ms)`,
      };
    }
    if (!err?.response) {
      return {
        success: false,
        httpStatus: 0,
        message: err?.message || "Không kết nối được máy chủ GHN",
      };
    }
    return {
      success: false,
      httpStatus,
      message: String(
        err?.response?.data?.message || err?.message || "Token GHN không hợp lệ!",
      ),
    };
  }
}

export { sleep as ghnSleep };
