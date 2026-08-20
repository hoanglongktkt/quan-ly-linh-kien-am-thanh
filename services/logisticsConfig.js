/**
 * Cấu hình GHN / SPX Express — env ưu tiên, fallback data/logistics_config.json.
 * Không hard-code token. File JSON để Settings lưu từ UI xuống server.
 */
import fs from "fs";
import path from "path";
import { resolveAppRoot } from "../utils/appPaths.js";

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

export function loadLogisticsConfig() {
  const file = readJsonFile();
  const ghnFile = file.ghn && typeof file.ghn === "object" ? file.ghn : {};
  const spxFile = file.spx && typeof file.spx === "object" ? file.spx : {};

  const ghnToken = String(
    process.env.GHN_TOKEN || process.env.GHN_API_TOKEN || ghnFile.token || "",
  ).trim();
  const ghnShopId = String(
    process.env.GHN_SHOP_ID || process.env.GHN_SHOPID || ghnFile.shopId || "",
  ).trim();
  const ghnApiUrl = String(
    process.env.GHN_API_URL ||
      ghnFile.apiUrl ||
      "https://online-gateway.ghn.vn/shiip/public-api",
  )
    .trim()
    .replace(/\/$/, "");
  const ghnPrintHost = String(
    process.env.GHN_PRINT_HOST || ghnFile.printHost || "https://online-gateway.ghn.vn",
  )
    .trim()
    .replace(/\/$/, "");

  const spxUserId = String(
    process.env.SPX_USER_ID ||
      process.env.SPX_APP_ID ||
      spxFile.clientId ||
      spxFile.userId ||
      spxFile.appId ||
      "",
  ).trim();
  const spxSecret = String(
    process.env.SPX_SECRET ||
      process.env.SPX_USER_SECRET ||
      spxFile.clientSecret ||
      spxFile.secret ||
      "",
  ).trim();
  const spxMerchantId = String(
    process.env.SPX_MERCHANT_ID || spxFile.merchantId || "",
  ).trim();
  const spxApiUrl = String(
    process.env.SPX_API_URL || spxFile.apiUrl || "https://spx.vn",
  )
    .trim()
    .replace(/\/$/, "");

  return {
    ghn: {
      token: ghnToken,
      shopId: ghnShopId,
      apiUrl: ghnApiUrl,
      printHost: ghnPrintHost,
      service: String(ghnFile.service || "standard").trim() || "standard",
      connected: Boolean(ghnToken),
    },
    spx: {
      userId: spxUserId,
      secret: spxSecret,
      merchantId: spxMerchantId,
      apiUrl: spxApiUrl,
      connected: Boolean(spxUserId && spxSecret),
    },
  };
}

export function saveLogisticsConfig(partial) {
  const current = readJsonFile();
  const next = {
    ghn: { ...(current.ghn || {}), ...(partial?.ghn || {}) },
    spx: { ...(current.spx || {}), ...(partial?.spx || {}) },
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), "utf-8");
  return loadLogisticsConfig();
}

export function maskSecret(value) {
  const s = String(value || "").trim();
  if (!s) return "";
  if (s.length <= 8) return "••••";
  return `${s.slice(0, 4)}••••${s.slice(-4)}`;
}
