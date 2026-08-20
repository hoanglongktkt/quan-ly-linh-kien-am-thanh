/**
 * Cấu hình GHN / SPX Express.
 * SPX: MongoDB (meta.logistics_config) là nguồn chính — KHÔNG đọc process.env.SPX_*.
 * GHN: MongoDB → file JSON → env (giữ tương thích tab GHN).
 */
import fs from "fs";
import path from "path";
import { resolveAppRoot } from "../utils/appPaths.js";
import {
  isMongoReady,
  loadLogisticsSettingsFromStore,
  saveLogisticsSettingsToStore,
} from "../src/db/mongoStore.ts";

const CONFIG_PATH = path.join(resolveAppRoot(), "data", "logistics_config.json");

function readJsonFile() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return {};
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    console.warn("[Logistics config] read failed:", err?.message || err);
    return {};
  }
}

function unwrapJson(value, depth = 0) {
  if (depth > 3) return value;
  if (typeof value === "string") {
    const s = value.trim();
    if (s.startsWith("{") || s.startsWith("[")) {
      try {
        return unwrapJson(JSON.parse(s), depth + 1);
      } catch {
        return value;
      }
    }
  }
  return value;
}

/**
 * Chuẩn hóa SPX credentials từ Mongo.
 * DB ghi clientId/clientSecret (form Cài đặt) → map sang userId/secret cho HMAC.
 */
function extractSpxCredentials(stored) {
  const root = unwrapJson(stored);
  const doc = root && typeof root === "object" ? root : {};
  let src = doc.spx != null ? unwrapJson(doc.spx) : doc;
  if (!src || typeof src !== "object") src = {};

  const clientId = String(
    src.clientId ||
      src.userId ||
      src.spxUserId ||
      src.appId ||
      src.app_id ||
      src.user_id ||
      doc.clientId ||
      doc.userId ||
      "",
  ).trim();
  const clientSecretRaw = String(
    src.clientSecret ||
      src.secret ||
      src.userSecret ||
      src.spxSecret ||
      src.client_secret ||
      src.user_secret ||
      doc.clientSecret ||
      doc.secret ||
      "",
  ).trim();
  const clientSecret = clientSecretRaw.includes("••••") ? "" : clientSecretRaw;
  const merchantId = String(src.merchantId || doc.merchantId || "").trim();
  const apiUrl = String(src.apiUrl || doc.apiUrl || "https://spx.vn")
    .trim()
    .replace(/\/$/, "");

  return {
    clientId,
    clientSecret,
    userId: clientId,
    secret: clientSecret,
    appId: clientId,
    merchantId,
    apiUrl,
  };
}

function pickSpx(raw) {
  const mapped = extractSpxCredentials({ spx: raw });
  return {
    clientId: mapped.clientId,
    clientSecret: mapped.clientSecret,
    merchantId: mapped.merchantId,
    apiUrl: String(raw && typeof raw === "object" ? raw.apiUrl || "" : "").trim().replace(/\/$/, ""),
  };
}

function pickGhn(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    token: String(src.token || "").trim(),
    shopId: String(src.shopId || "").trim(),
    apiUrl: String(src.apiUrl || "").trim().replace(/\/$/, ""),
    printHost: String(src.printHost || "").trim().replace(/\/$/, ""),
    service: String(src.service || "").trim(),
  };
}

function mergeLogisticsSources(mongoDoc, fileDoc) {
  const mongoGhn = pickGhn(mongoDoc?.ghn);
  const fileGhn = pickGhn(fileDoc?.ghn);
  const mongoSpx = pickSpx(mongoDoc?.spx);
  const fileSpx = pickSpx(fileDoc?.spx);

  const ghnToken = String(
    mongoGhn.token || fileGhn.token || process.env.GHN_TOKEN || process.env.GHN_API_TOKEN || "",
  ).trim();
  const ghnShopId = String(
    mongoGhn.shopId || fileGhn.shopId || process.env.GHN_SHOP_ID || process.env.GHN_SHOPID || "",
  ).trim();
  const ghnApiUrl = String(
    mongoGhn.apiUrl ||
      fileGhn.apiUrl ||
      process.env.GHN_API_URL ||
      "https://online-gateway.ghn.vn/shiip/public-api",
  )
    .trim()
    .replace(/\/$/, "");
  const ghnPrintHost = String(
    mongoGhn.printHost ||
      fileGhn.printHost ||
      process.env.GHN_PRINT_HOST ||
      "https://online-gateway.ghn.vn",
  )
    .trim()
    .replace(/\/$/, "");

  // SPX: chỉ MongoDB → file JSON đã lưu từ Cài đặt. Không đọc SPX_USER_ID / SPX_SECRET.
  const spxClientId = mongoSpx.clientId || fileSpx.clientId;
  const spxClientSecret = mongoSpx.clientSecret || fileSpx.clientSecret;
  const spxMerchantId = mongoSpx.merchantId || fileSpx.merchantId;
  const spxApiUrl = String(mongoSpx.apiUrl || fileSpx.apiUrl || "https://spx.vn")
    .trim()
    .replace(/\/$/, "");

  return {
    ghn: {
      token: ghnToken,
      shopId: ghnShopId,
      apiUrl: ghnApiUrl,
      printHost: ghnPrintHost,
      service: mongoGhn.service || fileGhn.service || "standard",
      connected: Boolean(ghnToken),
    },
    spx: {
      clientId: spxClientId,
      clientSecret: spxClientSecret,
      merchantId: spxMerchantId,
      apiUrl: spxApiUrl,
      userId: spxClientId,
      secret: spxClientSecret,
      connected: Boolean(spxClientId && spxClientSecret),
    },
  };
}

export async function loadLogisticsConfig() {
  const file = readJsonFile();
  let mongoDoc = null;
  if (isMongoReady()) {
    try {
      mongoDoc = await loadLogisticsSettingsFromStore();
    } catch (err) {
      console.warn("[Logistics config] Mongo read failed:", err?.message || err);
    }
  }
  return mergeLogisticsSources(mongoDoc, file);
}

/** Tạo đơn SPX: chỉ đọc MongoDB. Map clientId/clientSecret → userId/secret (HMAC). */
export async function loadSpxCredentialsFromMongo() {
  if (!isMongoReady()) {
    throw new Error("Chưa kết nối Database, không tạo được vận đơn SPX.");
  }
  const stored = unwrapJson(await loadLogisticsSettingsFromStore());
  const mapped = extractSpxCredentials(stored);
  if (!mapped.clientId || !mapped.clientSecret) {
    throw new Error(
      "Thiếu SPX User ID / Secret trên Database. Vào Cài đặt → nhập SPX User ID (hoặc Client ID) và Secret Key rồi bấm Lưu cấu hình SPX.",
    );
  }
  return {
    userId: mapped.clientId,
    secret: mapped.clientSecret,
    clientId: mapped.clientId,
    clientSecret: mapped.clientSecret,
    appId: mapped.clientId,
    merchantId: mapped.merchantId,
    apiUrl: mapped.apiUrl,
  };
}

export async function saveLogisticsConfig(partial) {
  const file = readJsonFile();
  let mongoDoc = null;
  if (isMongoReady()) {
    try {
      mongoDoc = await loadLogisticsSettingsFromStore();
    } catch (err) {
      console.warn("[Logistics config] Mongo read before save failed:", err?.message || err);
    }
  }
  const mongoNorm = unwrapJson(mongoDoc);
  const mongoObj = mongoNorm && typeof mongoNorm === "object" ? mongoNorm : {};
  const mongoSpx = unwrapJson(mongoObj.spx);
  const mergedSpx = {
    ...(mongoSpx && typeof mongoSpx === "object" ? mongoSpx : {}),
    ...(file.spx || {}),
    ...(partial?.spx || {}),
  };
  const mappedSpx = extractSpxCredentials({ spx: mergedSpx });
  const next = {
    ghn: { ...(mongoObj.ghn || {}), ...(file.ghn || {}), ...(partial?.ghn || {}) },
    spx: {
      ...mergedSpx,
      clientId: mappedSpx.clientId,
      userId: mappedSpx.clientId,
      ...(mappedSpx.clientSecret
        ? { clientSecret: mappedSpx.clientSecret, secret: mappedSpx.clientSecret }
        : {}),
      merchantId: mappedSpx.merchantId,
    },
    updatedAt: new Date().toISOString(),
  };

  if (!isMongoReady()) {
    throw new Error("Chưa kết nối được Database, không lưu được cấu hình GHN/SPX.");
  }
  await saveLogisticsSettingsToStore(next);

  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), "utf-8");
  } catch (err) {
    console.warn("[Logistics config] JSON backup write failed:", err?.message || err);
  }
  return loadLogisticsConfig();
}

export function maskSecret(value) {
  const s = String(value || "").trim();
  if (!s) return "";
  if (s.length <= 8) return "••••";
  return `${s.slice(0, 4)}••••${s.slice(-4)}`;
}
