import { GoogleGenAI } from "@google/genai";
import { updateEnvVar, maskApiKey } from "../utils/env.js";

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
  checkShopConnectionStatus: async () => ({ online: false, message: "not_initialized" }),
};

export function initSettingsController(partial) {
  deps = { ...deps, ...partial };
}

/** GET /api/settings/channels */
export async function getChannelSettings(_req, res) {
  try {
    const settings = deps.loadChannelSettings();
    return res.json({
      success: true,
      settings,
      path: deps.CHANNEL_SETTINGS_PATH,
      shopCount: Array.isArray(settings.shops) ? settings.shops.length : 0,
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
    console.log(
      "[Channel Settings] PUT OK — shop_ids:",
      (saved.shops || []).map((s) => s.shopId).join(", ") || "(trống)",
    );
    return res.json({ success: true, settings: saved, shopCount: saved.shops?.length ?? 0 });
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
    for (const shop of shops) {
      if (!shop?.id) continue;
      try {
        statuses[shop.id] = await Promise.race([
          deps.checkShopConnectionStatus(shop),
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error("Timeout kiểm tra kết nối (15s)")), 15_000);
          }),
        ]);
      } catch (shopErr) {
        console.error("[Shop connection-status] shop failed:", shop?.id, shopErr);
        statuses[shop.id] = {
          online: false,
          message: shopErr?.message || "Lỗi kiểm tra kết nối gian hàng",
        };
      }
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
