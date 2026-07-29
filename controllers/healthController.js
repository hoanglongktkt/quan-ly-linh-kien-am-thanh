import fs from "fs";
import path from "path";
import { resolveAppRoot, resolveAppBaseUrl } from "../utils/appPaths.js";

const APP_ROOT = resolveAppRoot();
const APP_BASE_URL = resolveAppBaseUrl();

function resolveShopeeCallbackUrl() {
  const explicit = String(process.env.SHOPEE_CALLBACK_URL || "")
    .trim()
    .replace(/\/$/, "");
  if (explicit) return explicit;
  return `${APP_BASE_URL}/api/shopee/callback`;
}

const SHOPEE_CALLBACK_URL = resolveShopeeCallbackUrl();
const SHOPEE_WEBHOOK_URL = `${APP_BASE_URL}/api/webhook/shopee`;

/** Deps từ server.ts (Shopee token helpers chưa tách). */
let deps = {
  ensureDataDirs: () => {
    fs.mkdirSync(path.join(APP_ROOT, "data"), { recursive: true });
  },
  listShopeeOAuthShopIds: () => [],
  loadLastOAuthAudit: () => null,
  tokensPath: path.resolve(APP_ROOT, "data", "shopee_tokens.json"),
  appRoot: APP_ROOT,
  appBaseUrl: APP_BASE_URL,
  shopeeCallbackUrl: SHOPEE_CALLBACK_URL,
  shopeeWebhookUrl: SHOPEE_WEBHOOK_URL,
};

export function initHealthController(partial) {
  deps = { ...deps, ...partial };
}

/**
 * GET /api/config/public
 */
export function getPublicConfig(_req, res) {
  res.json({
    appUrl: deps.appBaseUrl,
    apiBaseUrl: deps.appBaseUrl,
    shopeeCallbackUrl: deps.shopeeCallbackUrl,
    shopeeWebhookUrl: deps.shopeeWebhookUrl,
  });
}

/**
 * POST /api/debug/client-log
 */
export function postClientLog(req, res) {
  try {
    deps.ensureDataDirs();
    const logPath = path.join(deps.appRoot, "data", "debug-556dce.ndjson");
    const payload = {
      sessionId: "556dce",
      runId: req.body?.runId || "post-fix",
      hypothesisId: req.body?.hypothesisId || null,
      location: req.body?.location || "client",
      message: req.body?.message || "",
      data: req.body?.data || {},
      timestamp: Date.now(),
    };
    fs.appendFileSync(logPath, `${JSON.stringify(payload)}\n`, "utf-8");
    return res.status(200).json({ ok: true });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * GET /api/debug/client-log
 */
export function getClientLog(_req, res) {
  try {
    const logPath = path.join(deps.appRoot, "data", "debug-556dce.ndjson");
    if (!fs.existsSync(logPath)) return res.json({ ok: true, lines: [] });
    const lines = fs
      .readFileSync(logPath, "utf-8")
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-80)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { raw: line };
        }
      });
    return res.json({ ok: true, lines });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * GET /api/health
 */
export function getHealth(_req, res) {
  const shopIds = deps.listShopeeOAuthShopIds();
  let dataDirWritable = false;
  try {
    deps.ensureDataDirs();
    fs.accessSync(path.join(deps.appRoot, "data"), fs.constants.W_OK);
    dataDirWritable = true;
  } catch {
    dataDirWritable = false;
  }
  res.status(200).json({
    ok: true,
    service: "cpanel-backend",
    host: deps.appBaseUrl,
    appRoot: deps.appRoot,
    tokensPath: deps.tokensPath,
    tokensFileExists: fs.existsSync(deps.tokensPath),
    dataDirWritable,
    shopeeOAuthShopIds: shopIds,
    lastOAuth: deps.loadLastOAuthAudit(),
    oauthHint:
      shopIds.length > 0
        ? "Vào Cài đặt → shop Shopee → bấm OAuth (shop_id phải khớp). Sau OAuth kiểm tra lastOAuth.success=true."
        : "Chưa có shop OAuth — bấm nút OAuth trong Cài đặt.",
    checkedAt: new Date().toISOString(),
    routes: {
      mappingProducts: true,
    },
  });
}
