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

function pickSpx(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const clientId = String(src.clientId || src.userId || src.appId || "").trim();
  const clientSecret = String(src.clientSecret || src.secret || "").trim();
  const merchantId = String(src.merchantId || "").trim();
  const apiUrl = String(src.apiUrl || "").trim().replace(/\/$/, "");
  return { clientId, clientSecret, merchantId, apiUrl };
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

/** Tạo đơn SPX: chỉ đọc MongoDB meta._id = logistics_config (clientId / clientSecret / merchantId). */
export async function loadSpxCredentialsFromMongo() {
  if (!isMongoReady()) {
    throw new Error("Chưa kết nối Database, không tạo được vận đơn SPX.");
  }
  const stored = await loadLogisticsSettingsFromStore();
  const spxRaw = stored?.spx && typeof stored.spx === "object" ? stored.spx : stored || {};
  const clientId = String(
    spxRaw.clientId || spxRaw.userId || spxRaw.appId || stored?.clientId || "",
  ).trim();
  const clientSecret = String(
    spxRaw.clientSecret || spxRaw.secret || stored?.clientSecret || "",
  ).trim();
  const merchantId = String(spxRaw.merchantId || stored?.merchantId || "").trim();
  const apiUrl = String(spxRaw.apiUrl || stored?.apiUrl || "https://spx.vn")
    .trim()
    .replace(/\/$/, "");
  if (!clientId || !clientSecret) {
    throw new Error(
      "Thiếu SPX Client ID / Client Secret trên Database. Vào Cài đặt → nhập Client ID, Client Secret, Merchant ID rồi bấm Lưu cấu hình SPX.",
    );
  }
  return {
    clientId,
    clientSecret,
    merchantId,
    apiUrl,
    userId: clientId,
    secret: clientSecret,
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
  const next = {
    ghn: { ...(mongoDoc?.ghn || {}), ...(file.ghn || {}), ...(partial?.ghn || {}) },
    spx: { ...(mongoDoc?.spx || {}), ...(file.spx || {}), ...(partial?.spx || {}) },
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
