import { GoogleGenAI } from "@google/genai";
import { updateEnvVar, maskApiKey } from "../utils/env.js";
import {
  loadLogisticsConfig,
  saveLogisticsConfig,
  maskSecret,
} from "../services/logisticsConfig.js";
import { testGhnConnection } from "../services/ghnLogistics.js";
import { testSpxConnection } from "../services/spxLogistics.js";

/** Shared Gemini client — Settings cập nhật key, AI routes dùng chung. */
let ai = null;

export function getGeminiClient() {
  return ai;
}

export function setGeminiClient(client) {
  ai = client;
}

export function initGeminiClient(apiKey) {
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: { "User-Agent": "aistudio-build" },
    },
  });
}

export function ensureGeminiClientFromEnv() {
  if (process.env.GEMINI_API_KEY) {
    ai = initGeminiClient(process.env.GEMINI_API_KEY);
  } else {
    console.warn("Warning: GEMINI_API_KEY is not configured in .env");
  }
  return ai;
}

/** Deps channel settings + Shopee check (chưa tách Phase 6). */
let deps = {
  CHANNEL_SETTINGS_PATH: "",
  DEFAULT_CHANNEL_SETTINGS: {},
  loadChannelSettings: () => ({ shops: [] }),
  saveChannelSettings: () => false,
  upsertShopsInChannelSettings: (_a, b) => (Array.isArray(b) ? b : []),
  logOAuthSaveError: (ctx, err) => console.error(ctx, err),
  checkShopConnectionStatus: async () => ({
    online: false,
    connection_status: "missing",
    message: "not_initialized",
  }),
  enrichShopsWithConnectionStatus: (shops) => (Array.isArray(shops) ? shops : []),
};

export function initSettingsController(partial) {
  deps = { ...deps, ...partial };
}

/** GET /api/settings/channels */
export async function getChannelSettings(_req, res) {
  try {
    const settings = deps.loadChannelSettings();
    const shops = deps.enrichShopsWithConnectionStatus(settings.shops || []);
    return res.json({
      success: true,
      settings: { ...settings, shops },
      path: deps.CHANNEL_SETTINGS_PATH,
      shopCount: shops.length,
    });
  } catch (error) {
    deps.logOAuthSaveError("GET /api/settings/channels", error);
    return res.status(500).json({
      success: false,
      error: error?.message || "load_failed",
      message: "Không đọc được cấu hình gian hàng",
    });
  }
}

/** PUT /api/settings/channels */
export async function putChannelSettings(req, res) {
  try {
    const incoming = req.body?.settings;
    if (!incoming || typeof incoming !== "object") {
      return res.status(400).json({
        success: false,
        error: "invalid_settings",
        message: "Thiếu trường settings trong body",
      });
    }
    const onDisk = deps.loadChannelSettings();
    const incomingShops = Array.isArray(incoming.shops) ? incoming.shops : [];
    const mergedShops = deps.upsertShopsInChannelSettings(onDisk.shops || [], incomingShops);

    if (incomingShops.length > 0 && mergedShops.length === 0) {
      return res.status(400).json({
        success: false,
        error: "invalid_shop_schema",
        message: "Dữ liệu shop thiếu trường bắt buộc (platform, shopId, shopName, apiKey)",
      });
    }

    const payload = { ...deps.DEFAULT_CHANNEL_SETTINGS, ...onDisk, ...incoming, shops: mergedShops };
    if (!deps.saveChannelSettings(payload)) {
      return res.status(500).json({
        success: false,
        error: "save_failed",
        message: "Không ghi được file channel_settings.json trên máy chủ",
      });
    }
    const saved = deps.loadChannelSettings();
    const shops = deps.enrichShopsWithConnectionStatus(saved.shops || []);
    console.log(
      "[Channel Settings] PUT OK — shop_ids:",
      shops.map((s) => s.shopId).join(", ") || "(trống)",
    );
    return res.json({
      success: true,
      settings: { ...saved, shops },
      shopCount: shops.length,
    });
  } catch (error) {
    deps.logOAuthSaveError("PUT /api/settings/channels", error);
    return res.status(500).json({
      success: false,
      error: error?.message || "save_failed",
      message: "Lưu cấu hình gian hàng thất bại",
    });
  }
}

/** GET /api/settings/gemini-status */
export async function getGeminiStatus(_req, res) {
  const key = process.env.GEMINI_API_KEY || "";
  const configured = Boolean(key && key !== "chua_co_key_tam_thoi");
  return res.json({
    success: true,
    configured,
    maskedKey: configured ? maskApiKey(key) : "",
  });
}

/** POST /api/settings/update-gemini-key */
export async function updateGeminiKey(req, res) {
  try {
    const { apiKey } = req.body || {};
    const trimmed = String(apiKey || "").trim();
    if (!trimmed) {
      return res.status(400).json({ success: false, error: "Vui lòng nhập Gemini API Key." });
    }
    updateEnvVar("GEMINI_API_KEY", trimmed);
    ai = initGeminiClient(trimmed);
    return res.json({ success: true, message: "Đã cập nhật API Key thành công!" });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || "Lưu API Key thất bại" });
  }
}

/** POST /api/settings/test-gemini-key */
export async function testGeminiKey(req, res) {
  try {
    const testKey = String(req.body?.apiKey || process.env.GEMINI_API_KEY || "").trim();
    if (!testKey || testKey === "chua_co_key_tam_thoi") {
      return res.status(400).json({ success: false, error: "API Key không hợp lệ" });
    }
    const testAi = initGeminiClient(testKey);
    await testAi.models.generateContent({
      model: "gemini-3.5-flash",
      contents: "Reply with exactly: OK",
    });
    return res.json({ success: true, message: "Kết nối thành công!" });
  } catch (error) {
    console.error("[Gemini test]", error);
    return res.status(400).json({ success: false, error: "API Key không hợp lệ" });
  }
}

/** POST /api/settings/shop-connection-status */
export async function postShopConnectionStatus(req, res) {
  try {
    const shops = Array.isArray(req.body?.shops) ? req.body.shops : [];
    const statuses = {};
    // Cách ly từng shop — 1 shop lỗi không làm fail toàn bộ (Promise.allSettled).
    const settled = await Promise.allSettled(
      shops.map(async (shop) => {
        if (!shop?.id) return null;
        try {
          const result = await new Promise((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error("Timeout kiểm tra kết nối (15s)")),
              15_000,
            );
            Promise.resolve(deps.checkShopConnectionStatus(shop)).then(
              (v) => {
                clearTimeout(timer);
                resolve(v);
              },
              (e) => {
                clearTimeout(timer);
                reject(e);
              },
            );
          });
          return { id: shop.id, status: result };
        } catch (shopErr) {
          console.error("[Shop connection-status] shop failed:", shop?.id, shopErr);
          return {
            id: shop.id,
            status: {
              online: false,
              connection_status: "missing",
              message: shopErr?.message || "Lỗi kiểm tra kết nối gian hàng",
            },
          };
        }
      }),
    );
    for (const item of settled) {
      if (item.status !== "fulfilled" || !item.value?.id) continue;
      statuses[item.value.id] = item.value.status;
    }
    return res.json({ success: true, statuses });
  } catch (error) {
    console.error("[Shop connection-status] fatal:", error);
    return res.status(500).json({
      success: false,
      error: error?.message || "Kiểm tra kết nối thất bại",
      message: error?.message || "Kiểm tra kết nối thất bại",
    });
  }
}

/** GET /api/settings/logistics */
export async function getLogisticsSettings(_req, res) {
  try {
    const cfg = await loadLogisticsConfig();
    return res.json({
      success: true,
      ghn: {
        connected: cfg.ghn.connected,
        shopId: cfg.ghn.shopId,
        tokenMasked: maskSecret(cfg.ghn.token),
        hasToken: Boolean(cfg.ghn.token),
        service: cfg.ghn.service,
      },
      spx: {
        connected: cfg.spx.connected,
        clientId: cfg.spx.clientId,
        userId: cfg.spx.clientId || cfg.spx.userId,
        merchantId: cfg.spx.merchantId,
        secretMasked: maskSecret(cfg.spx.clientSecret || cfg.spx.secret),
        hasSecret: Boolean(cfg.spx.clientSecret || cfg.spx.secret),
        apiUrl: cfg.spx.apiUrl,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error?.message || "Không đọc được cấu hình GHN/SPX",
    });
  }
}

/** POST /api/settings/logistics */
export async function saveLogisticsSettings(req, res) {
  try {
    const body = req.body || {};
    const patch = {};
    if (body.ghn && typeof body.ghn === "object") {
      patch.ghn = {};
      if (body.ghn.token != null && String(body.ghn.token).trim() && !String(body.ghn.token).includes("••••")) {
        patch.ghn.token = String(body.ghn.token).trim();
      }
      if (body.ghn.shopId != null) patch.ghn.shopId = String(body.ghn.shopId).trim();
      if (body.ghn.service != null) patch.ghn.service = String(body.ghn.service).trim();
    }
    if (body.spx && typeof body.spx === "object") {
      patch.spx = {};
      const clientId = String(
        body.spx.clientId || body.spx.userId || body.spx.spxUserId || "",
      ).trim();
      const clientSecret = String(
        body.spx.clientSecret || body.spx.secret || body.spx.userSecret || "",
      ).trim();
      if (clientId) {
        patch.spx.clientId = clientId;
        patch.spx.userId = clientId;
      }
      if (clientSecret && !clientSecret.includes("••••")) {
        patch.spx.clientSecret = clientSecret;
        patch.spx.secret = clientSecret;
      }
      if (body.spx.merchantId != null) patch.spx.merchantId = String(body.spx.merchantId).trim();
      if (body.spx.apiUrl != null) patch.spx.apiUrl = String(body.spx.apiUrl).trim();
    }
    const cfg = await saveLogisticsConfig(patch);
    return res.json({
      success: true,
      message: "Đã lưu cấu hình GHN/SPX trên server.",
      ghnConnected: cfg.ghn.connected,
      spxConnected: cfg.spx.connected,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error?.message || "Lưu cấu hình logistics thất bại",
    });
  }
}

/** POST /api/settings/test-ghn — Axios thật tới máy chủ GHN, không mock. */
export async function testGhnSettings(req, res) {
  const token = String(req.body?.token || "").trim();
  const shopId = String(req.body?.shopId || "").trim();
  if (!token || !shopId || token.includes("••••") || token.startsWith("ghn-tok-")) {
    return res.status(400).json({
      success: false,
      message: "Vui lòng nhập Token và Shop ID",
    });
  }
  try {
    const result = await testGhnConnection({ token, shopId });
    if (!result?.success || result.httpStatus !== 200) {
      const status = result?.httpStatus === 401 ? 401 : 400;
      return res.status(status).json({
        success: false,
        message: result?.message || "Token GHN không hợp lệ!",
      });
    }
    return res.json({
      success: true,
      message: result.message || "Kết nối GHN thành công!",
      httpStatus: 200,
    });
  } catch (error) {
    const httpStatus = Number(error?.response?.status) || 0;
    if (httpStatus === 401) {
      return res.status(401).json({ success: false, message: "Token GHN không hợp lệ!" });
    }
    return res.status(400).json({
      success: false,
      message: error?.message || "Token GHN không hợp lệ!",
    });
  }
}

/** POST /api/settings/test-spx — Axios + HMAC-SHA256 thật tới máy chủ SPX, không mock. */
export async function testSpxSettings(req, res) {
  const userId = String(
    req.body?.userId || req.body?.clientId || req.body?.spxUserId || "",
  ).trim();
  const secret = String(
    req.body?.secret || req.body?.clientSecret || req.body?.userSecret || "",
  ).trim();
  const apiUrl = String(req.body?.apiUrl || "").trim();
  if (!userId || !secret || secret.includes("••••")) {
    return res.status(400).json({
      success: false,
      message: "Vui lòng nhập User ID và Secret",
    });
  }
  try {
    const result = await testSpxConnection({ userId, secret, apiUrl });
    if (!result?.success || result.httpStatus !== 200) {
      const status = result?.httpStatus === 401 || result?.httpStatus === 403 ? result.httpStatus : 400;
      return res.status(status).json({
        success: false,
        message: result?.message || "User ID / Secret SPX không hợp lệ!",
      });
    }
    return res.json({
      success: true,
      message: result.message || "Kết nối SPX thành công!",
      httpStatus: 200,
    });
  } catch (error) {
    const httpStatus = Number(error?.response?.status) || 0;
    if (httpStatus === 401 || httpStatus === 403) {
      return res.status(httpStatus).json({
        success: false,
        message: "User ID / Secret SPX không hợp lệ!",
      });
    }
    return res.status(400).json({
      success: false,
      message: error?.message || "User ID / Secret SPX không hợp lệ!",
    });
  }
}
