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
  const merchantId = String(src.merchantId || src.accountId || doc.merchantId || "").trim();
  const apiUrl = String(src.apiUrl || doc.apiUrl || "https://spx.vn")
    .trim()
    .replace(/\/$/, "");
  const createPath = String(
    src.createPath || src.createOrderPath || doc.createPath || "/open/api/v1/order/batch_create_order",
  ).trim();

  return {
    clientId,
    clientSecret,
    userId: clientId,
    secret: clientSecret,
    appId: clientId,
    merchantId,
    apiUrl,
    createPath,
  };
}

function pickSpx(raw) {
  const mapped = extractSpxCredentials({ spx: raw });
  return {
    clientId: mapped.clientId,
    clientSecret: mapped.clientSecret,
    merchantId: mapped.merchantId,
    apiUrl: String(raw && typeof raw === "object" ? raw.apiUrl || mapped.apiUrl || "" : mapped.apiUrl || "")
      .trim()
      .replace(/\/$/, ""),
    createPath: String(raw && typeof raw === "object" ? raw.createPath || mapped.createPath || "" : mapped.createPath || "").trim(),
  };
}

const GHN_SHOP_LABELS = ["Kho hàng nhẹ", "Kho hàng vừa", "Kho hàng nặng"];

function normalizeGhnShopIds(src) {
  const obj = src && typeof src === "object" ? src : {};
  const fromArray = Array.isArray(obj.ghnShopIds)
    ? obj.ghnShopIds.map((id) => String(id || "").trim())
    : [];
  const id1 = String(obj.ghnShopId1 || fromArray[0] || obj.shopId || "").trim();
  const id2 = String(obj.ghnShopId2 || fromArray[1] || "").trim();
  const id3 = String(obj.ghnShopId3 || fromArray[2] || "").trim();
  const ghnShopIds = [id1, id2, id3];
  const shopId = id1 || id2 || id3;
  const shops = ghnShopIds
    .map((id, idx) => ({
      id,
      label: `Shop ID ${idx + 1} (${GHN_SHOP_LABELS[idx]})`,
      slot: idx + 1,
    }))
    .filter((row) => row.id);
  return { shopId, ghnShopId1: id1, ghnShopId2: id2, ghnShopId3: id3, ghnShopIds, shops };
}

function pickGhn(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const shops = normalizeGhnShopIds(src);
  return {
    token: String(src.token || "").trim(),
    shopId: shops.shopId,
    ghnShopId1: shops.ghnShopId1,
    ghnShopId2: shops.ghnShopId2,
    ghnShopId3: shops.ghnShopId3,
    ghnShopIds: shops.ghnShopIds,
    shops: shops.shops,
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
  const envShopId = String(process.env.GHN_SHOP_ID || process.env.GHN_SHOPID || "").trim();
  const mergedShopIds = normalizeGhnShopIds({
    ghnShopId1: mongoGhn.ghnShopId1 || fileGhn.ghnShopId1 || mongoGhn.shopId || fileGhn.shopId || envShopId,
    ghnShopId2: mongoGhn.ghnShopId2 || fileGhn.ghnShopId2,
    ghnShopId3: mongoGhn.ghnShopId3 || fileGhn.ghnShopId3,
    ghnShopIds: [
      mongoGhn.ghnShopIds?.[0] || fileGhn.ghnShopIds?.[0] || "",
      mongoGhn.ghnShopIds?.[1] || fileGhn.ghnShopIds?.[1] || "",
      mongoGhn.ghnShopIds?.[2] || fileGhn.ghnShopIds?.[2] || "",
    ],
  });
  const ghnShopId = mergedShopIds.shopId;
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
  const spxCreatePath = String(
    mongoSpx.createPath || fileSpx.createPath || "/open/api/v1/order/batch_create_order",
  ).trim();

  return {
    ghn: {
      token: ghnToken,
      shopId: ghnShopId,
      ghnShopId1: mergedShopIds.ghnShopId1,
      ghnShopId2: mergedShopIds.ghnShopId2,
      ghnShopId3: mergedShopIds.ghnShopId3,
      ghnShopIds: mergedShopIds.ghnShopIds,
      shops: mergedShopIds.shops,
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
      createPath: spxCreatePath,
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
    createPath: mapped.createPath,
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
  const mergedGhnRaw = { ...(mongoObj.ghn || {}), ...(file.ghn || {}), ...(partial?.ghn || {}) };
  const fromPartialGhn = partial?.ghn && typeof partial.ghn === "object" ? partial.ghn : {};
  const hasExplicitShops =
    fromPartialGhn.ghnShopId1 != null ||
    fromPartialGhn.ghnShopId2 != null ||
    fromPartialGhn.ghnShopId3 != null ||
    Array.isArray(fromPartialGhn.ghnShopIds);
  const mergedGhnShops = normalizeGhnShopIds(
    hasExplicitShops
      ? {
          ghnShopId1: fromPartialGhn.ghnShopId1 ?? mergedGhnRaw.ghnShopId1 ?? "",
          ghnShopId2: fromPartialGhn.ghnShopId2 ?? mergedGhnRaw.ghnShopId2 ?? "",
          ghnShopId3: fromPartialGhn.ghnShopId3 ?? mergedGhnRaw.ghnShopId3 ?? "",
          ghnShopIds: Array.isArray(fromPartialGhn.ghnShopIds)
            ? fromPartialGhn.ghnShopIds
            : mergedGhnRaw.ghnShopIds,
        }
      : mergedGhnRaw,
  );
  const next = {
    ghn: {
      ...mergedGhnRaw,
      shopId: mergedGhnShops.shopId,
      ghnShopId1: mergedGhnShops.ghnShopId1,
      ghnShopId2: mergedGhnShops.ghnShopId2,
      ghnShopId3: mergedGhnShops.ghnShopId3,
      ghnShopIds: mergedGhnShops.ghnShopIds,
    },
    spx: {
      ...mergedSpx,
      clientId: mappedSpx.clientId,
      userId: mappedSpx.clientId,
      ...(mappedSpx.clientSecret
        ? { clientSecret: mappedSpx.clientSecret, secret: mappedSpx.clientSecret }
        : {}),
      merchantId: mappedSpx.merchantId,
      apiUrl: mappedSpx.apiUrl,
      createPath: mappedSpx.createPath,
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
