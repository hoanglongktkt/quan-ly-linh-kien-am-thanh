import express from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { createRequire } from "node:module";
import { PDFDocument } from "pdf-lib";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { enrichOrdersFromCatalog } from "./src/utils/orderItemVariation.ts";
import {
  initMongo,
  loadProductsFromStore,
  loadProductByIdFromStore,
  loadProductsByIdsFromStore,
  saveProductsToStoreAsync,
  loadChannelListingsFromStore,
  saveChannelListingsToStoreAsync,
  upsertChannelListingToStore,
  buildLocalInventoryCacheFromStore,
  countProducts,
  countChannelListings,
  seedStoreFromArrays,
  flushDbWrites,
  reloadCachesFromDb,
  isMongoReady,
  getMongoUriMasked,
  bulkUpsertOrdersToStore,
  type LocalInventoryCache,
} from "./src/db/mongoStore.ts";

/** Hard Crash Catcher — ghi file để xem trên cPanel khi Passenger kill process. */
function writeCpanelCrashLog(kind: string, err: unknown): void {
  try {
    const stack =
      err instanceof Error
        ? err.stack || err.message
        : typeof err === "string"
          ? err
          : JSON.stringify(err);
    const line = `${kind}: ${stack}\n---\n${new Date().toISOString()}\n`;
    const targets = [
      path.join(process.cwd(), "cpanel_error_log.txt"),
      typeof __dirname !== "undefined" ? path.join(__dirname, "cpanel_error_log.txt") : "",
    ].filter(Boolean);
    for (const file of targets) {
      try {
        fs.writeFileSync(file, line);
      } catch {
        /* ignore */
      }
    }
    console.error(line);
  } catch {
    /* ignore */
  }
}
process.on("uncaughtException", (err) => {
  writeCpanelCrashLog("Exception", err);
});
process.on("unhandledRejection", (err) => {
  writeCpanelCrashLog("Rejection", err);
});

/** Thư mục gốc app — Passenger/cPanel có thể khác process.cwd(). */
function resolveAppRoot(): string {
  const candidates = [
    process.env.PASSENGER_APP_ROOT,
    typeof __dirname !== "undefined" ? __dirname : "",
    process.cwd(),
  ]
    .map((c) => String(c || "").trim())
    .filter(Boolean);

  for (const candidate of candidates) {
    const abs = path.resolve(candidate);
    if (
      fs.existsSync(path.join(abs, "server.cjs")) ||
      fs.existsSync(path.join(abs, "data")) ||
      fs.existsSync(path.join(abs, ".htaccess")) ||
      fs.existsSync(path.join(abs, ".env"))
    ) {
      return abs;
    }
  }
  return path.resolve(candidates[0] || process.cwd());
}

const APP_ROOT = resolveAppRoot();

// Load .env — ưu tiên APP_ROOT (cPanel/Passenger), rồi cwd, rồi mặc định dotenv.
const dotenvCandidates = [
  path.join(APP_ROOT, ".env"),
  path.join(process.cwd(), ".env"),
  path.resolve(".env"),
];
for (const envPath of dotenvCandidates) {
  if (fs.existsSync(envPath)) {
    const loaded = dotenv.config({ path: envPath });
    if (loaded.error) {
      console.error(`[Config] dotenv lỗi khi đọc ${envPath}:`, loaded.error.message);
    } else {
      console.log(`[Config] dotenv loaded: ${envPath}`);
    }
  }
}
dotenv.config(); // fallback: process.cwd()/.env nếu còn biến thiếu
console.log(
  `[Config] APP_ROOT=${APP_ROOT} cwd=${process.cwd()} | MONGODB_URI=${process.env.MONGODB_URI || process.env.MONGO_URL ? "set" : "MISSING"}`
);

/** Ghi crash log thêm vào APP_ROOT (cPanel app root). */
function writeCpanelCrashLogToAppRoot(kind: string, err: unknown): void {
  try {
    const stack =
      err instanceof Error
        ? err.stack || err.message
        : typeof err === "string"
          ? err
          : JSON.stringify(err);
    fs.writeFileSync(
      path.join(APP_ROOT, "cpanel_error_log.txt"),
      `${kind}: ${stack}\n---\n${new Date().toISOString()}\n`
    );
  } catch {
    /* ignore */
  }
}
process.on("uncaughtException", (err) => writeCpanelCrashLogToAppRoot("Exception", err));
process.on("unhandledRejection", (err) => writeCpanelCrashLogToAppRoot("Rejection", err));
/** Thư mục tập trung lưu PDF vận đơn (tương đương public/waybills/ trên hosting, nhưng ngoài Vite publicDir). */
const WAYBILLS_DIR = path.join(APP_ROOT, "storage", "waybills");
const LEGACY_WAYBILLS_DIR = path.join(APP_ROOT, "storage", "labels");
const SHIPPING_DOCS_DIR = WAYBILLS_DIR;
const WAYBILLS_MAX_AGE_MS = 20 * 24 * 60 * 60 * 1000;
const WAYBILL_FILE_RE = /\.(pdf|zip|html)$/i;

function ensureWaybillsDir(): void {
  try {
    fs.mkdirSync(WAYBILLS_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
}

function migrateLegacyWaybillFiles(): void {
  try {
    if (!fs.existsSync(LEGACY_WAYBILLS_DIR)) return;
    ensureWaybillsDir();
    for (const name of fs.readdirSync(LEGACY_WAYBILLS_DIR)) {
      if (!WAYBILL_FILE_RE.test(name)) continue;
      const src = path.join(LEGACY_WAYBILLS_DIR, name);
      const dst = path.join(WAYBILLS_DIR, name);
      if (fs.existsSync(dst)) continue;
      try {
        fs.renameSync(src, dst);
      } catch {
        try {
          fs.copyFileSync(src, dst);
        } catch {
          /* ignore per-file */
        }
      }
    }
  } catch (err) {
    console.warn("[Waybills] Không migrate được thư mục cũ storage/labels:", err);
  }
}

type WaybillCleanupResult = { scanned: number; deleted: number; skipped: number; errors: number };

function cleanupExpiredWaybills(
  dir: string = WAYBILLS_DIR,
  maxAgeMs: number = WAYBILLS_MAX_AGE_MS
): WaybillCleanupResult {
  const result: WaybillCleanupResult = { scanned: 0, deleted: 0, skipped: 0, errors: 0 };
  try {
    if (!fs.existsSync(dir)) return result;
    const now = Date.now();
    for (const name of fs.readdirSync(dir)) {
      if (!WAYBILL_FILE_RE.test(name)) continue;
      const full = path.join(dir, name);
      result.scanned += 1;
      try {
        const stat = fs.statSync(full);
        if (!stat.isFile()) {
          result.skipped += 1;
          continue;
        }
        const ageMs = now - stat.mtimeMs;
        if (ageMs > maxAgeMs) {
          fs.unlinkSync(full);
          result.deleted += 1;
          console.log(
            `[Waybills Cleanup] Đã xóa ${name} (tuổi ${Math.floor(ageMs / 86400000)} ngày, dir=${path.basename(dir)})`
          );
        }
      } catch {
        result.errors += 1;
      }
    }
  } catch (err) {
    console.warn(`[Waybills Cleanup] Quét thư mục thất bại (${dir}):`, err);
  }
  if (result.deleted > 0) {
    console.log(
      `[Waybills Cleanup] Hoàn tất: scanned=${result.scanned} deleted=${result.deleted} errors=${result.errors}`
    );
  }
  return result;
}

let waybillCleanupRunning = false;

function scheduleWaybillsCleanup(): void {
  if (waybillCleanupRunning) return;
  waybillCleanupRunning = true;
  setImmediate(() => {
    try {
      ensureWaybillsDir();
      const primary = cleanupExpiredWaybills(WAYBILLS_DIR);
      const legacy =
        fs.existsSync(LEGACY_WAYBILLS_DIR) && LEGACY_WAYBILLS_DIR !== WAYBILLS_DIR
          ? cleanupExpiredWaybills(LEGACY_WAYBILLS_DIR)
          : { scanned: 0, deleted: 0, skipped: 0, errors: 0 };
    } finally {
      waybillCleanupRunning = false;
    }
  });
}

ensureWaybillsDir();

function safeLabelFilename(raw: string): string | null {
  const base = path.basename(String(raw || "").trim());
  if (!base || base.includes("..") || !/\.pdf$/i.test(base)) return null;
  return base;
}

function isPdfBuffer(buffer: Buffer, contentType?: string): boolean {
  if (contentType?.includes("pdf")) return true;
  return buffer.length > 4 && buffer.subarray(0, 4).toString() === "%PDF";
}

type ServeLabelPdfResult = "sent" | "not_found" | "invalid";

function resolveLabelFilePath(filename: string): string | null {
  const safe = safeLabelFilename(filename);
  if (!safe) return null;
  const primary = path.join(SHIPPING_DOCS_DIR, safe);
  if (fs.existsSync(primary)) return primary;
  const legacy = path.join(LEGACY_WAYBILLS_DIR, safe);
  if (fs.existsSync(legacy)) return legacy;
  return null;
}

function serveLabelPdfFromDisk(filename: string, res: any): ServeLabelPdfResult {
  const safe = safeLabelFilename(filename);
  if (!safe) {
    res.status(400).type("text/plain").send("Tên file vận đơn không hợp lệ.");
    return "invalid";
  }
  const filePath = resolveLabelFilePath(safe);
  if (!filePath) {
    return "not_found";
  }
  const buf = fs.readFileSync(filePath);
  if (!isPdfBuffer(buf)) {
    console.error(
      `[Labels] File không phải PDF hợp lệ: ${safe}, size=${buf.length}, head=${buf.subarray(0, 20).toString("hex")}`
    );
    res.status(415).type("text/plain").send("File vận đơn không phải PDF hợp lệ.");
    return "invalid";
  }
  res.status(200);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${safe}"`);
  res.setHeader("Content-Length", String(buf.length));
  res.setHeader("Cache-Control", "no-store");
  res.end(buf);
  console.log(`[Labels] Served PDF ${safe} (${buf.length} bytes)`);
  return "sent";
}

const JWT_SECRET = process.env.JWT_SECRET || "omnisales-vn-super-secret-key-2026";
const ENV_PATH = path.join(APP_ROOT, ".env");

const PRODUCTION_APP_URL = "https://quanly.linhkienamthanh.net";

function resolveAppBaseUrl(): string {
  const fromEnv = String(process.env.APP_URL || process.env.API_BASE_URL || "").trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  if (process.env.NODE_ENV === "production") return PRODUCTION_APP_URL;
  return PRODUCTION_APP_URL;
}

const APP_BASE_URL = resolveAppBaseUrl();

function resolveLabelsPublicBaseUrl(): string {
  const explicit = String(process.env.LABELS_BASE_URL || process.env.CPANEL_PUBLIC_URL || "").trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const host = APP_BASE_URL.replace(/^https?:\/\//, "").toLowerCase();
  if (host.startsWith("quanly.") || host === "www.quanly.linhkienamthanh.net") {
    return "https://api.linhkienamthanh.net";
  }
  return APP_BASE_URL.replace(/\/$/, "");
}

function absoluteLabelUrl(relativePath: string | null | undefined): string | null {
  if (!relativePath) return null;
  if (/^https?:\/\//i.test(relativePath)) {
    try {
      const u = new URL(relativePath);
      if (u.hostname.includes("quanly.linhkienamthanh.net")) {
        const fn = decodeURIComponent(u.pathname.split("/").pop() || "");
        if (fn) return `${resolveLabelsPublicBaseUrl()}/api/public/labels/${encodeURIComponent(fn)}`;
      }
    } catch {
      /* keep as-is */
    }
    return relativePath;
  }
  let p = relativePath.startsWith("/") ? relativePath : `/${relativePath}`;
  if (p.startsWith("/labels/")) {
    const fn = decodeURIComponent(p.replace(/^\/labels\//, ""));
    if (fn) p = `/api/public/labels/${encodeURIComponent(fn)}`;
  }
  return `${resolveLabelsPublicBaseUrl()}${p}`;
}

async function runInBatches<T>(
  items: T[],
  batchSize: number,
  worker: (item: T) => Promise<void>,
  opts?: { itemDelayMs?: number; batchPauseMs?: number },
): Promise<void> {
  const size = Math.max(1, batchSize);
  const itemDelayMs = opts?.itemDelayMs ?? SHOPEE_PRODUCT_API_DELAY_MS;
  const batchPauseMs = opts?.batchPauseMs ?? SHOPEE_PRODUCT_BATCH_PAUSE_MS;
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    for (const item of batch) {
      await worker(item);
      await sleep(itemDelayMs);
    }
    if (i + size < items.length) {
      await sleep(batchPauseMs);
    }
  }
}

/** Shopee console khai báo domain quanly — redirect_uri phải cùng domain đó. */
function resolveShopeeCallbackUrl(): string {
  const explicit = String(process.env.SHOPEE_CALLBACK_URL || "").trim().replace(/\/$/, "");
  if (explicit) return explicit;
  return `${APP_BASE_URL}/api/shopee/callback`;
}

const SHOPEE_CALLBACK_URL = resolveShopeeCallbackUrl();
const SHOPEE_WEBHOOK_URL = `${APP_BASE_URL}/api/shopee/webhook`;
const SHOPEE_CALLBACK_IDLE_MSG =
  "Callback route is active. Waiting for Shopee parameters (code, shop_id)...";

function updateEnvVar(key: string, value: string): void {
  let content = "";
  if (fs.existsSync(ENV_PATH)) {
    content = fs.readFileSync(ENV_PATH, "utf-8");
  }
  const regex = new RegExp(`^${key}\\s*=.*$`, "m");
  const line = `${key}=${value}`;
  if (regex.test(content)) {
    content = content.replace(regex, line);
  } else {
    content = (content.trimEnd() ? content.trimEnd() + "\n" : "") + line + "\n";
  }
  fs.writeFileSync(ENV_PATH, content, "utf-8");
  process.env[key] = value;
}

function maskApiKey(key: string): string {
  if (!key || key.length < 8) return "••••••••";
  return key.slice(0, 4) + "••••" + key.slice(-4);
}

// ---------------------------------------------------------------------------
// Shopee Open Platform (Partner API v2) — REAL integration, not sandbox mock.
// Credentials must be the LIVE Partner ID / Live API Partner Key issued for
// your production App on https://open.shopee.com (NOT the old Sandbox app).
// ---------------------------------------------------------------------------
const SHOPEE_ENV = (process.env.SHOPEE_ENV || "live").toLowerCase();
const SHOPEE_HOST = "https://partner.shopeemobile.com";
if (SHOPEE_ENV !== "live") {
  console.warn(`[Shopee API] SHOPEE_ENV=${SHOPEE_ENV} — chỉ dùng host Live: ${SHOPEE_HOST}`);
}
const SHOPEE_PARTNER_ID = process.env.SHOPEE_PARTNER_ID || "";
const SHOPEE_PARTNER_KEY = process.env.SHOPEE_PARTNER_KEY || "";

// Partner_id from Shopee MUST be a plain integer. Anything else (empty, or a
// leftover placeholder like "CHUA_CO_LIVE_PARTNER_ID") means the real Live
// credentials were never filled in — every Shopee call will fail with
// "error_param" before it even reaches the order APIs.
function isShopeeConfigValid(): boolean {
  return /^\d+$/.test(SHOPEE_PARTNER_ID) && SHOPEE_PARTNER_KEY.length > 0 && !/CHUA_CO|YOUR_LIVE/i.test(SHOPEE_PARTNER_KEY);
}

if (!isShopeeConfigValid()) {
  console.warn(
    `[Shopee API] \u26A0\uFE0F SHOPEE_PARTNER_ID (hi\u1EC7n t\u1EA1i: "${SHOPEE_PARTNER_ID || "(r\u1ED7ng)"}") ho\u1EB7c SHOPEE_PARTNER_KEY ch\u01B0a \u0111\u01B0\u1EE3c \u0111i\u1EC1n \u0111\xFAng trong .env. ` +
      "Partner_id ph\u1EA3i l\xE0 m\u1ED9t s\u1ED1 nguy\xEAn (v\xED d\u1EE5: 2001234), l\u1EA5y t\u1EEB App PRODUCTION (Live) tr\xEAn open.shopee.com, KH\xD4NG d\xF9ng Sandbox. M\u1ECDi l\u1EA7n g\u1ECDi API Shopee s\u1EBD b\u1EC3 tr\u1EA3 l\u1ED7i error_param cho \u0111\u1EBFn khi s\u1EEDa \u0111\xFAng gi\xE1 tr\u1ECB n\xE0y."
  );
}

// Local JSON-file token store: shop_id -> { access_token, refresh_token, expire_in, obtained_at }
const SHOPEE_TOKENS_PATH = path.resolve(APP_ROOT, "data", "shopee_tokens.json");
const SHOPEE_OAUTH_LAST_PATH = path.resolve(APP_ROOT, "data", "shopee_oauth_last.json");

function ensureDataDirs(): void {
  const dataDir = path.join(APP_ROOT, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(SHOPEE_TOKENS_PATH)) {
    fs.writeFileSync(SHOPEE_TOKENS_PATH, "{}\n", "utf-8");
  }
}

function saveOAuthAudit(entry: Record<string, any>): void {
  try {
    ensureDataDirs();
    fs.writeFileSync(
      SHOPEE_OAUTH_LAST_PATH,
      JSON.stringify({ ...entry, at: new Date().toISOString() }, null, 2),
      "utf-8",
    );
  } catch (error) {
    console.error("[Shopee OAuth] Failed to write shopee_oauth_last.json:", error);
  }
}

function loadLastOAuthAudit(): Record<string, any> | null {
  try {
    if (!fs.existsSync(SHOPEE_OAUTH_LAST_PATH)) return null;
    return JSON.parse(fs.readFileSync(SHOPEE_OAUTH_LAST_PATH, "utf-8"));
  } catch {
    return null;
  }
}

ensureDataDirs();
try {
  const normalized = normalizeTokenStore(loadShopeeTokens());
  if (Object.keys(normalized).length > 0) {
    saveShopeeTokens(normalized);
    console.log(`[Boot] Normalized shopee_tokens.json keys: [${Object.keys(normalized).join(", ")}]`);
  }
} catch (error) {
  console.error("[Boot] Failed to normalize shopee_tokens.json:", error);
}
console.log(
  `[Boot] APP_ROOT=${APP_ROOT} | cwd=${process.cwd()} | SHOPEE_TOKENS_PATH=${SHOPEE_TOKENS_PATH} | exists=${fs.existsSync(SHOPEE_TOKENS_PATH)} | SHOPEE_CALLBACK_URL=${SHOPEE_CALLBACK_URL}`,
);

function loadShopeeTokens(): Record<string, any> {
  try {
    if (!fs.existsSync(SHOPEE_TOKENS_PATH)) return {};
    const raw = fs.readFileSync(SHOPEE_TOKENS_PATH, "utf-8");
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const map: Record<string, any> = {};
      for (const row of parsed) {
        const k = normalizeShopIdKey(row?.shop_id ?? row?.shopId);
        if (k) map[k] = row;
      }
      return map;
    }
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    console.error("[Shopee Tokens] Failed to read shopee_tokens.json:", error);
    return {};
  }
}

function maskTokenStoreForLog(tokens: Record<string, any>): Record<string, any> {
  const masked: Record<string, any> = {};
  for (const [key, record] of Object.entries(tokens || {})) {
    masked[key] = {
      shop_id: record?.shop_id ?? key,
      oauth_shop_id: record?.oauth_shop_id ?? null,
      shop_id_list: record?.shop_id_list ?? [],
      merchant_id_list: record?.merchant_id_list ?? [],
      expire_in: record?.expire_in ?? null,
      obtained_at: record?.obtained_at ?? null,
      access_token: record?.access_token ? `${String(record.access_token).slice(0, 16)}…` : null,
      refresh_token: record?.refresh_token ? `${String(record.refresh_token).slice(0, 16)}…` : null,
    };
  }
  return masked;
}

function saveShopeeTokens(tokensToWrite: Record<string, any>): boolean {
  const absPath = path.resolve(SHOPEE_TOKENS_PATH);
  try {
    ensureDataDirs();

    // Luôn merge với file trên đĩa — không ghi đè mất shop cũ
    const onDisk = normalizeTokenStore(loadShopeeTokens());
    const tokensData: Record<string, any> = { ...onDisk };
    const keysBefore = Object.keys(tokensData);

    for (const [rawKey, record] of Object.entries(tokensToWrite || {})) {
      const shop_id = normalizeShopIdKey(record?.shop_id ?? rawKey);
      if (!shop_id || !record) continue;
      tokensData[shop_id] = {
        ...tokensData[shop_id],
        ...record,
        shop_id,
      };
      console.log(`[Shopee Tokens] UPSERT shop_id=${shop_id}`);
    }

    const keysAfter = Object.keys(tokensData);
    console.log(
      "DEBUG SAVE: Merge keys",
      JSON.stringify({ keysBefore, keysAfter, addedOrUpdated: keysAfter.filter((k) => !keysBefore.includes(k) || tokensToWrite[k]) }),
    );
    console.log("DEBUG SAVE: Full tokensData file keys:", keysAfter);
    console.log(
      "DEBUG SAVE: Full tokensData (masked):",
      JSON.stringify(maskTokenStoreForLog(tokensData)),
    );

    const payload = JSON.stringify(tokensData, null, 2);
    console.log(
      "[Shopee Tokens] fs.writeFileSync — TRƯỚC KHI GHI",
      JSON.stringify({
        absPath,
        SHOPEE_TOKENS_PATH,
        APP_ROOT,
        keys: keysAfter,
        byteLength: Buffer.byteLength(payload, "utf-8"),
      }),
    );
    fs.writeFileSync(absPath, payload, "utf-8");
    console.log(
      "[Shopee Tokens] fs.writeFileSync — GHI THÀNH CÔNG",
      JSON.stringify({ absPath, keys: keysAfter, fileSize: fs.statSync(absPath).size }),
    );
    return true;
  } catch (error: any) {
    logOAuthSaveError("saveShopeeTokens", error);
    console.error(
      "[Shopee Tokens] fs.writeFileSync — LỖI GHI FILE",
      JSON.stringify({
        absPath,
        SHOPEE_TOKENS_PATH,
        errorMessage: error?.message || String(error),
        errorCode: error?.code || null,
      }),
    );
    return false;
  }
}

function normalizeShopIdKey(shopId: string | number | undefined): string {
  const key = String(shopId ?? "").trim();
  return /^\d+$/.test(key) ? key : "";
}

function queryParamOne(value: unknown): string {
  if (Array.isArray(value)) return String(value[0] ?? "").trim();
  return String(value ?? "").trim();
}

function shouldOAuthRedirectToFrontend(req: any): boolean {
  if (queryParamOne(req.query?.format) === "json") return false;
  if (queryParamOne(req.query?.redirect) === "0") return false;
  return true;
}

function buildOAuthFrontendRedirectUrl(req: any, result: any): string {
  const oauthShopId = String(result.oauth_shop_id || queryParamOne(req.query.shop_id) || "");
  const expectedShop = queryParamOne(req.query?.expected_shop) || String(result.expected_shop_id || "");
  if (result.success) {
    const savedQuery = encodeURIComponent((result.saved_shop_ids || []).join(","));
    const expectedQuery = expectedShop ? `&expected_shop=${encodeURIComponent(expectedShop)}` : "";
    return `${APP_BASE_URL}/?shopee_linked=1&shop_id=${encodeURIComponent(oauthShopId)}&saved_shops=${savedQuery}${expectedQuery}`;
  }
  const errMsg = result.message || result.error || "token_exchange_failed";
  return `${APP_BASE_URL}/?shopee_linked=0&shop_id=${encodeURIComponent(oauthShopId)}&error=${encodeURIComponent(errMsg)}`;
}

/** Chuẩn hóa response Shopee — hỗ trợ wrapper `response`, tên field khác nhau. */
function normalizeShopeeTokenResponse(raw: any): Record<string, any> {
  const inner =
    raw?.response && typeof raw.response === "object" && !Array.isArray(raw.response)
      ? raw.response
      : raw?.data && typeof raw.data === "object"
        ? raw.data
        : raw;

  const access_token =
    inner?.access_token ?? inner?.accessToken ?? raw?.access_token ?? raw?.accessToken ?? "";
  const refresh_token =
    inner?.refresh_token ?? inner?.refreshToken ?? raw?.refresh_token ?? raw?.refreshToken ?? "";
  const expire_in = Number(
    inner?.expire_in ?? inner?.expire_time ?? inner?.expires_in ?? raw?.expire_in ?? raw?.expire_time ?? 0,
  );

  const shop_id_list = inner?.shop_id_list ?? raw?.shop_id_list ?? inner?.shop_ids ?? [];
  const merchant_id_list = inner?.merchant_id_list ?? raw?.merchant_id_list ?? [];

  return {
    ...raw,
    access_token: access_token || undefined,
    refresh_token: refresh_token || undefined,
    expire_in: expire_in > 0 ? expire_in : undefined,
    shop_id_list: Array.isArray(shop_id_list) ? shop_id_list : [],
    merchant_id_list: Array.isArray(merchant_id_list) ? merchant_id_list : [],
    shop_id: inner?.shop_id ?? raw?.shop_id,
    error: raw?.error ?? inner?.error,
    message: raw?.message ?? inner?.message,
    _raw: raw,
  };
}

/** Cấu trúc token đồng nhất cho mọi shop trong shopee_tokens.json */
function buildShopeeTokenRecord(
  shopKey: string,
  authJson: any,
  oauthShopId: string,
  existing?: Record<string, any>,
): Record<string, any> {
  const key = normalizeShopIdKey(shopKey);
  const oauth = normalizeShopIdKey(oauthShopId) || key;
  const fromAuthList = Array.isArray(authJson?.shop_id_list)
    ? authJson.shop_id_list.map((x: unknown) => normalizeShopIdKey(x)).filter(Boolean)
    : [];
  const fromExistingList = Array.isArray(existing?.shop_id_list)
    ? existing.shop_id_list.map((x: unknown) => normalizeShopIdKey(x)).filter(Boolean)
    : [];
  const shopIdList = [...new Set([...fromAuthList, ...fromExistingList, key].filter(Boolean))];

  const fromAuthMerchants = Array.isArray(authJson?.merchant_id_list)
    ? authJson.merchant_id_list.map((x: unknown) => String(x)).filter(Boolean)
    : [];
  const fromExistingMerchants = Array.isArray(existing?.merchant_id_list)
    ? existing.merchant_id_list.map((x: unknown) => String(x)).filter(Boolean)
    : [];
  const merchantIdList = [...new Set([...fromAuthMerchants, ...fromExistingMerchants])];

  return {
    shop_id: key,
    access_token: String(authJson?.access_token ?? existing?.access_token ?? ""),
    refresh_token: String(authJson?.refresh_token ?? existing?.refresh_token ?? ""),
    expire_in: Number(authJson?.expire_in ?? existing?.expire_in ?? 14400),
    obtained_at: Number(authJson?.obtained_at ?? Math.floor(Date.now() / 1000)),
    oauth_shop_id: existing?.oauth_shop_id || oauth,
    shop_id_list: shopIdList,
    merchant_id_list: merchantIdList,
  };
}

/** Ghi token đầy đủ access_token / refresh_token / expire_in vào đúng key shop_id. */
function saveShopeeTokenFromAuth(shopId: string, authJson: any, oauthShopId: string): boolean {
  const key = normalizeShopIdKey(shopId);
  if (!key || !authJson?.access_token) return false;

  const new_token_data = buildShopeeTokenRecord(key, authJson, oauthShopId || key);
  console.log(
    "DEBUG SAVE: Saving data for shop:",
    key,
    "Full Data:",
    JSON.stringify(new_token_data),
  );

  const tokensData = normalizeTokenStore(loadShopeeTokens());
  tokensData[key] = new_token_data;
  return saveShopeeTokens(tokensData);
}

/** Chuẩn hóa key = shop_id và bổ sung trường thiếu cho shop cũ (VD: 4127421). */
function normalizeTokenStore(tokens: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [rawKey, record] of Object.entries(tokens || {})) {
    if (!record || typeof record !== "object") continue;
    const key = normalizeShopIdKey(record.shop_id ?? rawKey);
    if (!key || !record.access_token) continue;
    const oauthShopId = normalizeShopIdKey(record.oauth_shop_id) || key;
    out[key] = buildShopeeTokenRecord(key, record, oauthShopId, record);
  }
  return out;
}

function getShopeeTokenRecord(tokens: Record<string, any>, shopId: string): any | null {
  const key = normalizeShopIdKey(shopId);
  if (!key) return null;
  if (tokens[key]) return tokens[key];
  for (const [k, v] of Object.entries(tokens)) {
    if (normalizeShopIdKey(k) === key) return v;
    const linked = Array.isArray(v?.shop_id_list) ? v.shop_id_list : [];
    if (linked.some((id: unknown) => normalizeShopIdKey(id) === key)) return v;
  }
  return null;
}

/** Gom mọi shop_id cần lưu token sau OAuth (callback + shop_id_list từ Shopee + expected). */
function collectShopIdsForTokenSave(
  requestShopId: string,
  authJson: any,
  expectedShopId?: string,
): string[] {
  const ids = new Set<string>();
  const primary = normalizeShopIdKey(requestShopId);
  if (primary) ids.add(primary);

  const expected = normalizeShopIdKey(expectedShopId);
  if (expected) ids.add(expected);

  for (const raw of authJson?.shop_id_list || []) {
    const k = normalizeShopIdKey(raw);
    if (k) ids.add(k);
  }

  const fromBody = normalizeShopIdKey(authJson?.shop_id);
  if (fromBody) ids.add(fromBody);

  return [...ids];
}

/** Lưu token cho nhiều shop — ghi một lần (atomic merge), key = shop_id. */
function persistOAuthTokens(
  authJson: any,
  opts: { oauthShopId?: string; mainAccountId?: string; expectedShopId?: string },
): string[] {
  if (!authJson?.access_token) return [];

  const oauthShopId = normalizeShopIdKey(opts.oauthShopId);
  const mainAccountId = normalizeShopIdKey(opts.mainAccountId);
  const expected = normalizeShopIdKey(opts.expectedShopId);
  const shopIds = new Set(collectShopIdsForTokenSave(oauthShopId || mainAccountId, authJson, expected));

  // Main account OAuth: Shopee trả shop_id_list — lưu token cho TỪNG shop trong list
  if (mainAccountId && Array.isArray(authJson?.shop_id_list)) {
    for (const raw of authJson.shop_id_list) {
      const k = normalizeShopIdKey(raw);
      if (k) shopIds.add(k);
    }
  }

  const shopMismatch = Boolean(expected && oauthShopId && expected !== oauthShopId);
  if (shopMismatch && !shopIds.has(expected)) {
    console.warn(
      `[Shopee OAuth] Shop mismatch: expected=${expected}, oauth=${oauthShopId}, shop_id_list=[${(authJson?.shop_id_list || []).join(", ")}] — không lưu alias token sai shop.`,
    );
    shopIds.delete(expected);
  }

  if (shopIds.size === 0 && oauthShopId) shopIds.add(oauthShopId);

  const keysBeforeMerge = Object.keys(normalizeTokenStore(loadShopeeTokens()));
  const tokenOwner = oauthShopId || mainAccountId || "";
  const updates: Record<string, any> = {};

  for (const id of shopIds) {
    updates[id] = buildShopeeTokenRecord(id, authJson, tokenOwner || id, loadShopeeTokens()[id]);
    console.log("DEBUG SAVE: Saving data for shop:", id, "Full Data:", JSON.stringify(updates[id]));
  }

  saveShopeeTokens(updates);

  const saved = [...shopIds];
  const tokensData = normalizeTokenStore(loadShopeeTokens());
  console.log(
    "[Shopee Tokens] persistOAuthTokens — SAU MERGE",
    JSON.stringify({
      oauthShopId,
      mainAccountId: mainAccountId || null,
      expectedShopId: expected || null,
      shopMismatch,
      keysBefore: keysBeforeMerge,
      keysAfter: Object.keys(tokensData),
      shopIdsSaved: saved,
      shopee_shop_id_list: authJson?.shop_id_list || [],
      tokensPath: SHOPEE_TOKENS_PATH,
    }),
  );
  return saved;
}

/** Đọc lại file sau khi lưu — xác minh shop_id đã có token. */
function verifyTokenSaved(shopId: string): boolean {
  const key = normalizeShopIdKey(shopId);
  if (!key) return false;
  const tokens = loadShopeeTokens();
  return Boolean(getShopeeTokenRecord(tokens, key)?.access_token);
}

type ShopeeOAuthCallbackParams = {
  shopIdRaw?: string;
  mainAccountIdRaw?: string;
  expectedShopId?: string;
};

/** Luồng OAuth đầy đủ: đổi code → lưu file → audit. Dùng cho callback + Vercel proxy JSON. */
async function completeShopeeOAuthFlow(code: string, params: ShopeeOAuthCallbackParams) {
  const oauthShopId = normalizeShopIdKey(params.shopIdRaw);
  const mainAccountId = normalizeShopIdKey(params.mainAccountIdRaw);
  const expected = normalizeShopIdKey(params.expectedShopId);

  if (!oauthShopId && !mainAccountId) {
    return {
      success: false,
      oauth_shop_id: "",
      saved_shop_ids: [] as string[],
      verified_in_file: false,
      error: "invalid_shop_id",
      message: `Thiếu shop_id hoặc main_account_id hợp lệ trong callback (shop_id=${params.shopIdRaw || ""}, main_account_id=${params.mainAccountIdRaw || ""})`,
    };
  }

  console.log(
    "[Shopee OAuth] completeShopeeOAuthFlow BẮT ĐẦU",
    JSON.stringify({
      oauthShopId: oauthShopId || null,
      mainAccountId: mainAccountId || null,
      expectedShopId: expected || null,
      shop_mismatch: expected && oauthShopId ? expected !== oauthShopId : false,
      code_preview: `${code.slice(0, 8)}…`,
      tokensPath: SHOPEE_TOKENS_PATH,
    }),
  );

  const tokenResult = await exchangeShopeeCodeForToken(code, {
    shopId: oauthShopId || undefined,
    mainAccountId: mainAccountId || undefined,
  });
  let savedIds: string[] = [];

  if (tokenResult.access_token) {
    savedIds = persistOAuthTokens(tokenResult, {
      oauthShopId: oauthShopId || undefined,
      mainAccountId: mainAccountId || undefined,
      expectedShopId: expected || undefined,
    });
    tokenResult.saved_shop_ids = savedIds;
    if (savedIds.length > 0) {
      syncOAuthShopsToChannelSettings(savedIds, { expectedShopId: expected || undefined });
    }
  }

  const shopMismatch = Boolean(
    expected &&
      oauthShopId &&
      expected !== oauthShopId &&
      !savedIds.includes(expected),
  );
  const verified = expected
    ? savedIds.includes(expected) && verifyTokenSaved(expected)
    : oauthShopId
      ? verifyTokenSaved(oauthShopId)
      : savedIds.length > 0;

  saveOAuthAudit({
    callback_shop_id: oauthShopId || null,
    main_account_id: mainAccountId || null,
    expected_shop_id: expected || null,
    shop_mismatch: shopMismatch,
    callback_code_present: Boolean(code),
    success: Boolean(tokenResult.access_token) && verified && !shopMismatch,
    verified_in_file: verified,
    error: tokenResult.error || null,
    message: tokenResult.message || null,
    saved_shop_ids: savedIds,
    shopee_shop_id_list: tokenResult.shop_id_list || [],
    file_keys_after: Object.keys(loadShopeeTokens()),
    tokens_path: SHOPEE_TOKENS_PATH,
    app_root: APP_ROOT,
  });

  return {
    success: Boolean(tokenResult.access_token) && verified && !shopMismatch,
    oauth_shop_id: oauthShopId || savedIds[0] || "",
    expected_shop_id: expected || null,
    shop_mismatch: shopMismatch,
    saved_shop_ids: savedIds,
    verified_in_file: verified,
    error: tokenResult.error || (shopMismatch ? "shop_mismatch" : verified ? null : "token_not_persisted"),
    message: shopMismatch
      ? `Shopee trả về shop ${oauthShopId}, KHÔNG phải shop bạn yêu cầu ${expected}. Token KHÔNG thể dùng cho shop khác — hãy đăng xuất Shopee Seller Center, đăng nhập đúng shop ${expected}, rồi bấm OAuth lại.`
      : tokenResult.message ||
        (verified
          ? `OAuth thành công. Token đã lưu cho: [${savedIds.join(", ")}].`
          : "Token không ghi được vào shopee_tokens.json"),
    shopee_response: tokenResult.access_token
      ? { shop_id_list: tokenResult.shop_id_list || [], expire_in: tokenResult.expire_in }
      : tokenResult,
  };
}

function buildShopeeAuthPartnerUrl(shopId?: string): string {
  const apiPath = "/api/v2/shop/auth_partner";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp);
  const sid = normalizeShopIdKey(shopId);
  const redirectTarget = sid
    ? `${SHOPEE_CALLBACK_URL}?redirect=1&expected_shop=${sid}`
    : `${SHOPEE_CALLBACK_URL}?redirect=1`;
  const redirect = encodeURIComponent(redirectTarget);
  let url = `${SHOPEE_HOST}${apiPath}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&sign=${sign}&redirect=${redirect}`;
  if (sid) url += `&shop_id=${sid}`;
  console.log(`[Shopee OAuth] auth_partner URL cho shop_id=${sid || "(none)"}: ${url.replace(/sign=[^&]+/, "sign=***")}`);
  return url;
}

function saveShopeeTokenForShop(shopId: string, record: Record<string, any>): void {
  const key = normalizeShopIdKey(shopId);
  if (!key) return;
  let tokens = normalizeTokenStore(loadShopeeTokens());
  const existing = tokens[key];
  tokens[key] = buildShopeeTokenRecord(
    key,
    { ...existing, ...record, obtained_at: record.obtained_at ?? Math.floor(Date.now() / 1000) },
    existing?.oauth_shop_id || key,
    existing,
  );
  saveShopeeTokens(tokens);
  console.log(`[Shopee Tokens] Saved token for shop_id=${key}. All shops: [${Object.keys(tokens).join(", ")}]`);
}

function listShopeeOAuthShopIds(): string[] {
  return Object.keys(loadShopeeTokens())
    .map(normalizeShopIdKey)
    .filter(Boolean)
    .sort();
}

// Signature per Shopee v2 spec: HMAC-SHA256(partner_key, partner_id + path + timestamp [+ access_token + shop_id])
function shopeeSign(apiPath: string, timestamp: number, accessToken?: string, shopId?: string | number): string {
  const baseString = accessToken && shopId
    ? `${SHOPEE_PARTNER_ID}${apiPath}${timestamp}${accessToken}${shopId}`
    : `${SHOPEE_PARTNER_ID}${apiPath}${timestamp}`;
  return crypto.createHmac("sha256", SHOPEE_PARTNER_KEY).update(baseString).digest("hex");
}

// Exchange the OAuth `code` for a real access_token/refresh_token pair (Live Shop).
async function exchangeShopeeCodeForToken(
  code: string,
  opts: { shopId?: string; mainAccountId?: string },
) {
  const shopId = normalizeShopIdKey(opts.shopId);
  const mainAccountId = normalizeShopIdKey(opts.mainAccountId);

  if (!isShopeeConfigValid()) {
    const error = {
      error: "invalid_partner_config",
      message: `SHOPEE_PARTNER_ID/"${SHOPEE_PARTNER_ID}" ho\u1EB7c SHOPEE_PARTNER_KEY trong .env ch\u01B0a ph\u1EA3i gi\xE1 tr\u1ECB Live th\u1EF1c. Vui l\xF2ng \u0111i\u1EC1n \u0111\xFAng Partner ID (s\u1ED1 nguy\xEAn) v\xE0 Partner Key t\u1EEB App PRODUCTION tr\xEAn open.shopee.com r\u1ED3i th\u1EED l\u1EA1i.`,
    };
    console.error(`[Shopee OAuth] \u274C Kh\xF4ng th\u1EC3 \u0111\u1ED5i code: ${error.message}`);
    return error;
  }

  if (!shopId && !mainAccountId) {
    return {
      error: "missing_shop_or_main_account",
      message: "Shopee token/get cần shop_id HOẶC main_account_id (không được thiếu cả hai).",
    };
  }

  const apiPath = "/api/v2/auth/token/get";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp);
  const url = `${SHOPEE_HOST}${apiPath}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&sign=${sign}`;

  const body: Record<string, unknown> = {
    code,
    partner_id: Number(SHOPEE_PARTNER_ID),
  };
  if (mainAccountId) {
    body.main_account_id = Number(mainAccountId);
  } else if (shopId) {
    body.shop_id = Number(shopId);
  }

  console.log(
    "[Shopee OAuth] token/get request",
    JSON.stringify({
      shop_id: shopId || null,
      main_account_id: mainAccountId || null,
      partner_id: SHOPEE_PARTNER_ID,
      url_host: SHOPEE_HOST,
    }),
  );

  let res: Response;
  let rawText: string;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    rawText = await res.text();
  } catch (error: any) {
    logOAuthSaveError("exchangeShopeeCodeForToken fetch", error);
    return {
      error: "network_error",
      message: error?.message || "Không gọi được Shopee token/get",
    };
  }
  console.log("DEBUG RAW RESPONSE:", rawText);

  let json: any;
  try {
    json = rawText ? JSON.parse(rawText) : {};
  } catch (parseErr) {
    console.error("[Shopee OAuth] Không parse được JSON từ Shopee:", parseErr);
    return { error: "invalid_json", message: rawText.slice(0, 500) };
  }

  json = normalizeShopeeTokenResponse(json);
  console.log("DEBUG NORMALIZED RESPONSE:", JSON.stringify(json));
  console.log(`[Shopee API] POST ${apiPath} (env=${SHOPEE_ENV}) -> HTTP ${res.status}`);

  if (json.access_token && json.refresh_token) {
    console.log(
      "[Shopee OAuth] ĐÃ LẤY TOKEN TỪ SHOPEE",
      JSON.stringify({
        shop_id: shopId || null,
        main_account_id: mainAccountId || null,
        access_token: `${String(json.access_token).slice(0, 16)}…`,
        refresh_token: `${String(json.refresh_token).slice(0, 16)}…`,
        expire_in: json.expire_in,
        shop_id_list: json.shop_id_list || [],
      }),
    );
  } else {
    console.error(
      "[Shopee OAuth] SHOPEE KHÔNG TRẢ đủ access_token/refresh_token",
      JSON.stringify({
        shop_id: shopId || null,
        main_account_id: mainAccountId || null,
        httpStatus: res.status,
        error: json.error || null,
        message: json.message || null,
        keys: Object.keys(json),
      }),
    );
  }
  return json;
}

// Refresh an expired access_token using the stored refresh_token.
async function refreshShopeeToken(shopId: string, refreshToken: string) {
  const apiPath = "/api/v2/auth/access_token/get";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp);
  const url = `${SHOPEE_HOST}${apiPath}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&sign=${sign}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken, shop_id: Number(shopId), partner_id: Number(SHOPEE_PARTNER_ID) }),
    });
    const json: any = await res.json();
    console.log(`[Shopee API] POST ${apiPath} (refresh) -> HTTP ${res.status}:`, JSON.stringify(json));

    const normalized = normalizeShopeeTokenResponse(json);
    if (normalized.access_token) {
      saveShopeeTokenForShop(shopId, {
        access_token: normalized.access_token,
        refresh_token: normalized.refresh_token,
        expire_in: normalized.expire_in,
        obtained_at: Math.floor(Date.now() / 1000),
      });
      return normalized;
    }
    console.error(
      `[Shopee API] Refresh token thất bại shop_id=${shopId}:`,
      normalized.error || json.error,
      normalized.message || json.message,
    );
    return normalized;
  } catch (error: any) {
    logOAuthSaveError(`refreshShopeeToken shop_id=${shopId}`, error);
    return { error: "refresh_failed", message: error?.message || String(error) };
  }
}

function isShopeeInvalidTokenError(error?: unknown, message?: unknown): boolean {
  const text = `${error || ""} ${message || ""}`.toLowerCase();
  return /invalid.*access_token|invalid_acceess_token|error_auth|invalid_token|token expired/.test(text);
}

/** Lấy access_token + shop_id thực tế dùng khi gọi Shopee API. */
async function getShopeeAccessTokenForApi(
  shopKey: string,
  opts?: { forceRefresh?: boolean },
): Promise<{ token: string; apiShopId: string; fileKey: string } | null> {
  const fileKey = normalizeShopIdKey(shopKey);
  if (!fileKey) return null;

  const tokens = loadShopeeTokens();
  const record = getShopeeTokenRecord(tokens, fileKey);
  if (!record?.refresh_token && !record?.access_token) return null;

  const apiShopId = resolveShopeeApiShopId(record, fileKey);

  if (opts?.forceRefresh && record.refresh_token) {
    console.log(`[Shopee API] Force refresh token shop_id=${apiShopId} (key=${fileKey})`);
    const refreshed = await refreshShopeeToken(apiShopId, record.refresh_token);
    if (refreshed.access_token) {
      if (fileKey !== apiShopId) {
        saveShopeeTokenForShop(fileKey, {
          access_token: refreshed.access_token,
          refresh_token: refreshed.refresh_token,
          expire_in: refreshed.expire_in,
          obtained_at: Math.floor(Date.now() / 1000),
        });
      }
      return { token: refreshed.access_token, apiShopId, fileKey };
    }
    return null;
  }

  const token = await getValidShopeeAccessToken(fileKey);
  if (!token) return null;
  return { token, apiShopId, fileKey };
}

/** Gọi Shopee get_shop_info để xác minh token thực sự dùng được cho shop_id. */
async function verifyShopeeShopToken(shopId: string, accessToken: string): Promise<{ ok: boolean; error?: string }> {
  const key = normalizeShopIdKey(shopId);
  if (!key || !accessToken) return { ok: false, error: "missing_shop_or_token" };
  try {
    const apiPath = "/api/v2/shop/get_shop_info";
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = shopeeSign(apiPath, timestamp, accessToken, key);
    const url = `${SHOPEE_HOST}${apiPath}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&access_token=${accessToken}&shop_id=${key}&sign=${sign}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    const json: any = await res.json();
    const err = String(json?.error || "").trim();
    if (err) return { ok: false, error: err };
    return { ok: true };
  } catch (error: any) {
    return { ok: false, error: error?.message || String(error) };
  }
}

function resolveShopeeApiShopId(record: any, configuredShopId: string): string {
  const configured = normalizeShopIdKey(configuredShopId);
  const recordKey = normalizeShopIdKey(record?.shop_id);
  if (recordKey === configured) return configured;
  const oauth = normalizeShopIdKey(record?.oauth_shop_id);
  if (oauth) return oauth;
  return recordKey || configured;
}

// Returns a valid (non-expired) access_token for the shop, refreshing it first if needed.
async function getValidShopeeAccessToken(shopId: string): Promise<string | null> {
  const tokens = loadShopeeTokens();
  const key = normalizeShopIdKey(shopId);
  const record = getShopeeTokenRecord(tokens, key);
  if (!record) {
    const available = listShopeeOAuthShopIds();
    console.warn(
      `[Shopee API] Chưa có access_token cho shop_id=${key}. Token đang có: [${available.join(", ") || "không có"}]`,
    );
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  const obtainedAt = Number(record.obtained_at) || 0;
  const expireIn = Number(record.expire_in) || 14400;
  const isExpired = obtainedAt > 0 && now - obtainedAt >= expireIn - 60;
  if (!isExpired) return record.access_token;

  console.log(`[Shopee API] access_token c\u1EE7a shop_id=${key} \u0111\xE3 h\u1EBFt h\u1EA1n, \u0111ang refresh...`);
  const apiShopId = resolveShopeeApiShopId(record, key);
  const refreshed = await refreshShopeeToken(apiShopId, record.refresh_token);
  if (refreshed.access_token) {
    if (key !== apiShopId) {
      saveShopeeTokenForShop(key, {
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token,
        expire_in: refreshed.expire_in,
        obtained_at: Math.floor(Date.now() / 1000),
      });
    }
    return refreshed.access_token;
  }
  console.error(
    `[Shopee API] Refresh token thất bại shop_id=${key} (api=${apiShopId}):`,
    refreshed.error || refreshed.message,
  );
  return null;
}

type ShopeeDiagCode =
  | "OK"
  | "MISSING_PARTNER_CONFIG"
  | "MISSING_OAUTH_TOKEN"
  | "INVALID_TOKEN"
  | "SHOPEE_API_ERROR"
  | "TIMEOUT"
  | "NETWORK_ERROR"
  | "UNKNOWN_ERROR";

async function runShopeeConnectivityDiagnostics(shopIdInput?: string) {
  const steps: Array<{ step: string; ok: boolean; code?: ShopeeDiagCode; detail?: string; data?: any }> = [];
  const maskedPartnerKey = SHOPEE_PARTNER_KEY ? `${SHOPEE_PARTNER_KEY.slice(0, 4)}…${SHOPEE_PARTNER_KEY.slice(-4)}` : "";

  steps.push({
    step: "env_partner_config",
    ok: isShopeeConfigValid(),
    code: isShopeeConfigValid() ? "OK" : "MISSING_PARTNER_CONFIG",
    detail: isShopeeConfigValid()
      ? "SHOPEE_PARTNER_ID / SHOPEE_PARTNER_KEY hợp lệ (trên backend cPanel .env hoặc SetEnv)."
      : `Thiếu hoặc sai Partner credentials. partner_id="${SHOPEE_PARTNER_ID || "(rỗng)"}", key=${SHOPEE_PARTNER_KEY ? "đã set" : "(rỗng)"}`,
    data: {
      shopee_env: SHOPEE_ENV,
      shopee_host: SHOPEE_HOST,
      partner_id: SHOPEE_PARTNER_ID || null,
      partner_key_preview: SHOPEE_PARTNER_KEY ? maskedPartnerKey : null,
      tls_min_version: SHOPEE_TLS_MIN_VERSION,
      tls_max_version: SHOPEE_TLS_MAX_VERSION,
      http_dispatcher_connections: 3,
      note: "Biến SHOPEE_* phải cấu hình trên cPanel backend — KHÔNG chỉ trên Vercel frontend.",
    },
  });

  steps.push({
    step: "tls_http_client",
    ok: true,
    code: "OK",
    detail: `Shopee HTTP client dùng undici Agent TLS ${SHOPEE_TLS_MIN_VERSION}–${SHOPEE_TLS_MAX_VERSION}, keepAlive, max 3 connections.`,
    data: {
      tls_min_version: SHOPEE_TLS_MIN_VERSION,
      tls_max_version: SHOPEE_TLS_MAX_VERSION,
      timeout_ms: SHOPEE_HTTP_TIMEOUT_MS,
      override_env: "SHOPEE_TLS_MIN_VERSION / SHOPEE_TLS_MAX_VERSION",
    },
  });

  if (!isShopeeConfigValid()) {
    return { ok: false, code: "MISSING_PARTNER_CONFIG" as ShopeeDiagCode, steps };
  }

  const tokens = loadShopeeTokens();
  const availableShopIds = Object.keys(tokens);
  steps.push({
    step: "oauth_token_store",
    ok: availableShopIds.length > 0,
    code: availableShopIds.length > 0 ? "OK" : "MISSING_OAUTH_TOKEN",
    detail:
      availableShopIds.length > 0
        ? `Có token OAuth cho shop: ${availableShopIds.join(", ")}`
        : "Chưa có shop nào trong data/shopee_tokens.json — cần OAuth lại qua /api/shopee/callback",
    data: { availableShopIds, tokensPath: SHOPEE_TOKENS_PATH },
  });

  const shopId = String(shopIdInput || availableShopIds[0] || "").trim();
  if (!shopId) {
    steps.push({
      step: "shop_id",
      ok: false,
      code: "MISSING_OAUTH_TOKEN",
      detail: "Không có shop_id để kiểm tra. Truyền ?shop_id= hoặc OAuth shop trước.",
    });
    return { ok: false, code: "MISSING_OAUTH_TOKEN" as ShopeeDiagCode, steps };
  }

  let accessToken: string | null = null;
  try {
    accessToken = await getValidShopeeAccessToken(shopId);
    steps.push({
      step: "access_token",
      ok: Boolean(accessToken),
      code: accessToken ? "OK" : "INVALID_TOKEN",
      detail: accessToken
        ? `Lấy được access_token cho shop_id=${shopId}`
        : `Không lấy được token hợp lệ cho shop_id=${shopId} (hết hạn / refresh fail)`,
      data: { shopId },
    });
  } catch (error: any) {
    steps.push({
      step: "access_token",
      ok: false,
      code: "INVALID_TOKEN",
      detail: error?.message || String(error),
    });
    return { ok: false, code: "INVALID_TOKEN" as ShopeeDiagCode, steps };
  }

  if (!accessToken) {
    return { ok: false, code: "INVALID_TOKEN" as ShopeeDiagCode, steps };
  }

  try {
    const apiPath = "/api/v2/shop/get_shop_info";
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);
    const url = `${SHOPEE_HOST}${apiPath}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&access_token=${accessToken}&shop_id=${shopId}&sign=${sign}`;
    const res = await fetchWithTimeout(url);
    const json: any = await res.json();

    const shopeeErr = String(json?.error || "").trim();
    const ok = res.ok && !shopeeErr;
    let code: ShopeeDiagCode = "OK";
    let detail = `HTTP ${res.status} — gọi ${SHOPEE_HOST} thành công`;

    if (!ok) {
      const errLower = shopeeErr.toLowerCase();
      if (/invalid.*token|error_auth|refresh/.test(errLower)) code = "INVALID_TOKEN";
      else if (/error_param|invalid.*partner|sign/.test(errLower)) code = "MISSING_PARTNER_CONFIG";
      else code = "SHOPEE_API_ERROR";
      detail = shopeeErr
        ? `Shopee trả lỗi: ${shopeeErr} — ${json?.message || ""}`.trim()
        : `HTTP ${res.status} từ Shopee API`;
    }

    steps.push({
      step: "shopee_api_ping",
      ok,
      code,
      detail,
      data: { httpStatus: res.status, shopeeResponse: json },
    });

    return { ok, code, steps, shopId };
  } catch (error: any) {
    const isTimeout = error?.name === "AbortError";
    const code: ShopeeDiagCode = isTimeout ? "TIMEOUT" : error?.cause?.code === "ENOTFOUND" ? "NETWORK_ERROR" : "UNKNOWN_ERROR";
    steps.push({
      step: "shopee_api_ping",
      ok: false,
      code,
      detail: isTimeout
        ? "Timeout 12s khi gọi partner.shopeemobile.com"
        : error?.message || String(error),
    });
    return { ok: false, code, steps, shopId };
  }
}

// v2.order.get_order_list — pulls order_sn updated within the last 30 days
// (Shopee giới hạn mỗi request tối đa 15 ngày → caller phải lặp 2 cửa sổ).
// Supports optional order_status filter and cursor pagination (Shopee returns
// at most page_size orders per call; more/next_cursor must be followed).
async function shopeeGetOrderList(
  shopId: string,
  accessToken: string,
  opts?: {
    orderStatus?: string;
    cursor?: string;
    timeRangeField?: "create_time" | "update_time";
    timeFrom?: number;
    timeTo?: number;
  }
) {
  const apiPath = "/api/v2/order/get_order_list";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);

  const timeTo = opts?.timeTo ?? timestamp;
  const timeFrom = opts?.timeFrom ?? timeTo - 30 * 24 * 60 * 60;

  const params = new URLSearchParams({
    partner_id: SHOPEE_PARTNER_ID,
    timestamp: String(timestamp),
    access_token: accessToken,
    shop_id: shopId,
    sign,
    // update_time: bắt được đơn đổi trạng thái (Đang giao / Hủy) dù đã tạo từ trước.
    time_range_field: opts?.timeRangeField || "update_time",
    time_from: String(timeFrom),
    time_to: String(timeTo),
    page_size: String(SHOPEE_ORDER_LIST_PAGE_SIZE),
    response_optional_fields: "order_status",
  });
  if (opts?.orderStatus) params.set("order_status", opts.orderStatus);
  if (opts?.cursor !== undefined && opts.cursor !== "") params.set("cursor", opts.cursor);

  const url = `${SHOPEE_HOST}${apiPath}?${params.toString()}`;
  try {
    const { json, httpStatus } = await shopeeFetchJsonWithRetry(url, `get_order_list shop_id=${shopId}`);
    console.log(
      `[Shopee API] GET ${apiPath} (shop_id=${shopId}, status=${opts?.orderStatus || "ALL"}, field=${opts?.timeRangeField || "update_time"}, from=${timeFrom}, to=${timeTo}, cursor=${opts?.cursor || ""}) -> HTTP ${httpStatus}:`,
      JSON.stringify(json).slice(0, 500),
    );

    if (json.error) {
      const errMsg = formatShopeeApiError(json, httpStatus);
      console.error(`[Shopee API] L\u1ED7i t\u1EEB Shopee khi l\u1EA5y danh s\xE1ch \u0111\u01A1n: ${errMsg}`);
      return { ...json, message: json.message || errMsg };
    }
    return json;
  } catch (err) {
    return shopeeApiErrorResult(err, `get_order_list fetch (shop_id=${shopId})`);
  }
}

function extractShopeeOrderListRows(result: any): any[] {
  const rows = result?.response?.order_list ?? result?.order_list;
  return Array.isArray(rows) ? rows : [];
}

// Shopee order_list pagination — response uses `more` + `next_cursor` (some SDKs
// alias has_more). Read both so we never stop after page 1 by mistake.
function parseShopeeOrderListPagination(result: any): { more: boolean; nextCursor: string } {
  const body = result?.response ?? result ?? {};
  const more =
    body.more === true ||
    body.more === 1 ||
    body.more === "true" ||
    body.has_more === true ||
    body.has_more === 1 ||
    body.has_more === "true" ||
    result?.more === true ||
    result?.more === 1;
  const nextCursor = String(
    body.next_cursor ?? body.cursor ?? result?.next_cursor ?? result?.cursor ?? "",
  ).trim();
  return { more, nextCursor };
}

const SHOPEE_ORDER_LIST_WINDOW_SEC = 15 * 24 * 60 * 60;
/** 2 cửa sổ × 15 ngày = quét đủ 30 ngày (giới hạn Shopee mỗi request ≤ 15 ngày). */
const SHOPEE_ORDER_LIST_MAX_WINDOWS = 2;
const SHOPEE_ORDER_LIST_PAGE_SIZE = 50;
const SHOPEE_ORDER_LIST_MAX_PAGES = 8;
const SHOPEE_SYNC_MAX_ORDER_SNS_PER_SHOP = 120;
/** Xử lý theo lô chính xác 25 đơn / lần gọi get_order_detail. */
const SHOPEE_SYNC_CHUNK_SIZE = 25;
/** Delay giữa các lô khi đồng bộ đơn hàng (ms). */
const ORDER_SYNC_SAVE_DELAY_MS = 500;
/** Nghỉ giữa các chunk đơn hàng (đồng bộ nền). */
const SHOPEE_SYNC_CHUNK_DELAY_MS = 500;
const SHOPEE_SYNC_BATCH_DELAY_MS = SHOPEE_SYNC_CHUNK_DELAY_MS;
const SHOPEE_ORDER_LIST_PAGE_DELAY_MS = 1000;
/** Delay tối thiểu giữa mỗi lần gọi API sản phẩm Shopee */
const SHOPEE_PRODUCT_API_DELAY_MS = 1000;
/** Hàng đợi sync stock/price → Shopee (tránh 429). */
const SHOPEE_SYNC_QUEUE_GAP_MS = 750;
const SHOPEE_SYNC_QUEUE_MAX_RETRY = 3;
/** Số item mỗi trang get_item_list — giữ nhỏ để tránh HTTP 413 / OOM cPanel. */
const SHOPEE_ITEM_LIST_PAGE_SIZE = 10;
/** Kích thước gói sản phẩm — xử lý xong 1 gói nghỉ batchPause */
const SHOPEE_PRODUCT_BATCH_SIZE = 10;
/** Nghỉ 2–3s giữa các gói sản phẩm */
const SHOPEE_PRODUCT_BATCH_PAUSE_MS = 2500;
/** get_item_base_info: batch cực nhỏ (≤10) — tránh spike RAM / cagefs_enter Unable to fork */
const SHOPEE_PRODUCT_BASE_INFO_BATCH = 10;
/** Micro-batch upsert Mapping — tối đa 10 item Shopee / lần ghi DB */
const CHANNEL_FETCH_MICRO_BATCH = 10;
/** Nhường event loop giữa mỗi item/batch — tránh CPU kill trên CloudLinux */
const CHANNEL_FETCH_YIELD_MS = 50;
/** Chunk ghi DB cho sync kho / cập nhật sản phẩm (≤50 item → lưu → nghỉ). */
const PRODUCT_SYNC_CHUNK_SIZE = 50;
/** Nghỉ giữa các chunk sync — tránh 503 / cagefs fork. */
const PRODUCT_SYNC_CHUNK_PAUSE_MS = 100;
/** Batch auto-link mỗi request — giữ nhỏ để tránh spike RAM/CPU trên host yếu. */
const AUTO_LINK_BATCH_LIMIT_DEFAULT = 50;
const AUTO_LINK_BATCH_LIMIT_MAX = 100;
/** Giới hạn số trang get_item_list mỗi phiên sync (không while(true)). */
const PRODUCT_SYNC_MAX_PAGES = 200;
const SHOPEE_API_MAX_RETRY = 3;
const SHOPEE_API_RETRY_BASE_MS = 1500;
/** Timeout mọi HTTP Shopee — tránh treo process vô hạn trên cPanel. */
const SHOPEE_HTTP_TIMEOUT_MS = 12_000;
/** TLS tối thiểu cho Shopee OpenAPI (cPanel Node ≥20) — tránh ECONNRESET do handshake cũ. */
const SHOPEE_TLS_MIN_VERSION = String(process.env.SHOPEE_TLS_MIN_VERSION || "TLSv1.2").trim();
const SHOPEE_TLS_MAX_VERSION = String(process.env.SHOPEE_TLS_MAX_VERSION || "TLSv1.3").trim();
/** Ước tính phí sàn khi chưa có escrow_amount từ get_escrow_detail. */
const SHOPEE_NET_FEE_RATE = 0.12;
const nodeRequire = createRequire(import.meta.url);
const { Agent: ShopeeUndiciAgent } = nodeRequire("undici") as {
  Agent: new (opts?: Record<string, unknown>) => unknown;
};
const shopeeHttpDispatcher = new ShopeeUndiciAgent({
  connect: {
    rejectUnauthorized: true,
    minVersion: SHOPEE_TLS_MIN_VERSION,
    maxVersion: SHOPEE_TLS_MAX_VERSION,
  },
  connections: 3,
  pipelining: 0,
  keepAliveTimeout: 30_000,
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = SHOPEE_HTTP_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      // @ts-expect-error Node fetch (undici) — dispatcher TLS cho Shopee API trên cPanel
      dispatcher: shopeeHttpDispatcher,
    });
  } catch (error: any) {
    if (error?.name === "AbortError") {
      throw new Error(`Shopee API timeout sau ${timeoutMs / 1000}s`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Nhường CPU cho OS (Event Loop Yielding) — bắt buộc trên cPanel/CloudLinux. */
async function yieldEventLoop(ms: number = CHANNEL_FETCH_YIELD_MS): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function shopeeExponentialBackoffMs(attempt: number, baseMs = SHOPEE_API_RETRY_BASE_MS): number {
  return Math.min(30_000, baseMs * Math.pow(2, attempt));
}

function isShopeeRetryableNetworkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|AbortError|fetch failed|network|socket/i.test(msg);
}

function isShopeeRetryableHttpStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

/** Xử lý danh sách tuần tự theo gói — delay giữa item và nghỉ giữa các gói. */
async function runInShopeeBatches<T>(
  items: T[],
  processor: (item: T, index: number) => Promise<void>,
  opts?: { batchSize?: number; itemDelayMs?: number; batchPauseMs?: number },
): Promise<void> {
  if (items.length === 0) return;
  const batchSize = opts?.batchSize ?? SHOPEE_PRODUCT_BATCH_SIZE;
  const itemDelayMs = opts?.itemDelayMs ?? SHOPEE_PRODUCT_API_DELAY_MS;
  const batchPauseMs = opts?.batchPauseMs ?? SHOPEE_PRODUCT_BATCH_PAUSE_MS;

  for (let batchStart = 0; batchStart < items.length; batchStart += batchSize) {
    const batch = items.slice(batchStart, batchStart + batchSize);
    const batchNo = Math.floor(batchStart / batchSize) + 1;
    const totalBatches = Math.ceil(items.length / batchSize);
    console.log(`[Shopee Throttle] Batch ${batchNo}/${totalBatches} (${batch.length} item)...`);

    for (let j = 0; j < batch.length; j++) {
      await processor(batch[j], batchStart + j);
      if (j < batch.length - 1) await sleep(itemDelayMs);
    }

    if (batchStart + batchSize < items.length) {
      console.log(`[Shopee Throttle] Nghỉ ${batchPauseMs}ms trước batch kế...`);
      await sleep(batchPauseMs);
    }
  }
}

function shopeeSyncDelay(ms: number = SHOPEE_SYNC_BATCH_DELAY_MS): Promise<void> {
  return sleep(ms);
}

function shopeeApiErrorResult(err: unknown, context: string): Record<string, any> {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[Shopee API] ${context}:`, message);
  return { error: "shopee_api_error", message: `${context}: ${message}` };
}

function formatShopeeApiError(json: any, httpStatus?: number): string {
  const parts = [json?.message, json?.error, json?.msg]
    .map((v) => String(v ?? "").trim())
    .filter((v) => v && !/^HTTP\s+\d+$/i.test(v));
  if (httpStatus === 429) {
    return parts[0] || "Shopee giới hạn tần suất (HTTP 429 Too Many Requests) — vui lòng thử lại sau 1–2 phút.";
  }
  if (parts.length > 0) return parts.join(" — ");
  if (httpStatus && httpStatus >= 400) return `Shopee API lỗi HTTP ${httpStatus}`;
  return "Lỗi Shopee API không xác định";
}

/** Trích lỗi từ fetch/axios — ưu tiên error.response.data từ Shopee. */
function extractHttpClientError(err: unknown): { message: string; details: string; shopeeDetail?: unknown } {
  const anyErr = err as { response?: { data?: { message?: string; error?: string } }; message?: string };
  const shopeeData = anyErr?.response?.data;
  const message =
    shopeeData?.message ||
    shopeeData?.error ||
    (err instanceof Error ? err.message : String(err)) ||
    "Lỗi máy chủ nội bộ";
  const details = shopeeData
    ? JSON.stringify(shopeeData)
    : err instanceof Error
      ? err.toString()
      : String(err);
  return { message, details, shopeeDetail: shopeeData };
}

/** Luôn trả JSON lỗi — không để response treo hoặc crash process. */
function sendApiErrorJson(res: any, err: unknown, status = 500) {
  if (res.headersSent) return;
  const { message, details, shopeeDetail } = extractHttpClientError(err);
  return res.status(status).json({
    success: false,
    error: message || "Internal Server Error",
    message,
    details,
    ...(shopeeDetail ? { shopee: shopeeDetail } : {}),
  });
}

function sendStrictApiErrorJson(res: any, err: unknown) {
  const message =
    err && typeof err === "object" && "message" in err && typeof err.message === "string"
      ? err.message
      : "Internal Server Error";
  return res.status(500).json({ success: false, error: message || "Internal Server Error" });
}

function isShopeeRateLimited(httpStatus: number, json?: any): boolean {
  if (httpStatus === 429) return true;
  const text = `${json?.error || ""} ${json?.message || ""}`.toLowerCase();
  return /rate.?limit|too many request|api_call_limit|exceed/.test(text);
}

function describeShopeeTokenFailure(shopKey: string): { error: string; message: string } {
  const tokens = loadShopeeTokens();
  const key = normalizeShopIdKey(shopKey);
  const record = getShopeeTokenRecord(tokens, key);
  if (!record) {
    return {
      error: "missing_oauth",
      message: `Shop ${key} chưa có token OAuth — vào Cài đặt → Liên kết Shopee để ủy quyền lại.`,
    };
  }
  if (!record.refresh_token) {
    return {
      error: "missing_refresh_token",
      message: `Shop ${key} thiếu refresh_token — OAuth lại shop trên Cài đặt.`,
    };
  }
  const now = Math.floor(Date.now() / 1000);
  const obtainedAt = Number(record.obtained_at) || 0;
  const expireIn = Number(record.expire_in) || 14400;
  const isExpired = obtainedAt > 0 && now - obtainedAt >= expireIn - 60;
  if (isExpired) {
    return {
      error: "refresh_token_expired",
      message: `Access token shop ${key} đã hết hạn và refresh thất bại — OAuth lại shop trên Cài đặt.`,
    };
  }
  return {
    error: "no_valid_access_token",
    message: `Không lấy được access_token hợp lệ cho shop ${key}.`,
  };
}

async function shopeeFetchJsonWithRetry(
  url: string,
  context: string,
  opts?: { maxAttempts?: number; baseDelayMs?: number }
): Promise<{ json: any; httpStatus: number }> {
  const maxAttempts = opts?.maxAttempts ?? SHOPEE_API_MAX_RETRY;
  const baseDelayMs = opts?.baseDelayMs ?? SHOPEE_API_RETRY_BASE_MS;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let res: Response;
    let rawText = "";
    try {
      res = await fetchWithTimeout(url);
      rawText = await res.text();
    } catch (err) {
      const waitMs = shopeeExponentialBackoffMs(attempt, baseDelayMs);
      if (attempt < maxAttempts - 1 && isShopeeRetryableNetworkError(err)) {
        console.warn(`[Shopee API] ${context} lỗi mạng, retry ${attempt + 2}/${maxAttempts} sau ${waitMs}ms...`);
        await sleep(waitMs);
        continue;
      }
      const netMsg = err instanceof Error ? err.message : String(err);
      throw new Error(`${context}: Không kết nối được Shopee API — ${netMsg}`);
    }

    let json: any;
    try {
      json = rawText ? JSON.parse(rawText) : {};
    } catch (parseErr) {
      const parseMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      return {
        httpStatus: res.status,
        json: {
          error: "json_parse_error",
          message: `${context}: phản hồi không phải JSON hợp lệ (HTTP ${res.status}): ${parseMsg}`,
        },
      };
    }

    if ((isShopeeRateLimited(res.status, json) || isShopeeRetryableHttpStatus(res.status)) && attempt < maxAttempts - 1) {
      const waitMs = shopeeExponentialBackoffMs(attempt, baseDelayMs);
      console.warn(
        `[Shopee API] ${context} HTTP ${res.status}, retry ${attempt + 2}/${maxAttempts} sau ${waitMs}ms...`,
      );
      await sleep(waitMs);
      continue;
    }

    return { json, httpStatus: res.status };
  }

  return {
    httpStatus: 429,
    json: {
      error: "rate_limit_exceeded",
      message: formatShopeeApiError({ error: "rate_limit_exceeded" }, 429),
    },
  };
}

async function shopeePostJsonWithRetry(
  url: string,
  body: Record<string, unknown>,
  context: string,
  opts?: { maxAttempts?: number; baseDelayMs?: number }
): Promise<{ json: any; httpStatus: number }> {
  const maxAttempts = opts?.maxAttempts ?? SHOPEE_API_MAX_RETRY;
  const baseDelayMs = opts?.baseDelayMs ?? SHOPEE_API_RETRY_BASE_MS;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let res: Response;
    let rawText = "";
    try {
      res = await fetchWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      rawText = await res.text();
    } catch (err) {
      const waitMs = shopeeExponentialBackoffMs(attempt, baseDelayMs);
      if (attempt < maxAttempts - 1 && isShopeeRetryableNetworkError(err)) {
        console.warn(`[Shopee API] ${context} lỗi mạng, retry ${attempt + 2}/${maxAttempts} sau ${waitMs}ms...`);
        await sleep(waitMs);
        continue;
      }
      const netMsg = err instanceof Error ? err.message : String(err);
      throw new Error(`${context}: Không kết nối được Shopee API — ${netMsg}`);
    }

    let json: any;
    try {
      json = rawText ? JSON.parse(rawText) : {};
    } catch (parseErr) {
      const parseMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      return {
        httpStatus: res.status,
        json: {
          error: "json_parse_error",
          message: `${context}: phản hồi không phải JSON hợp lệ (HTTP ${res.status}): ${parseMsg}`,
        },
      };
    }

    if ((isShopeeRateLimited(res.status, json) || isShopeeRetryableHttpStatus(res.status)) && attempt < maxAttempts - 1) {
      const waitMs = shopeeExponentialBackoffMs(attempt, baseDelayMs);
      console.warn(
        `[Shopee API] ${context} HTTP ${res.status}, retry ${attempt + 2}/${maxAttempts} sau ${waitMs}ms...`,
      );
      await sleep(waitMs);
      continue;
    }

    if (json?.error && !json.message) {
      json.message = formatShopeeApiError(json, res.status);
    }

    return { json, httpStatus: res.status };
  }

  return {
    httpStatus: 429,
    json: {
      error: "rate_limit_exceeded",
      message: formatShopeeApiError({ error: "rate_limit_exceeded" }, 429),
    },
  };
}

function buildShopeeUpdateStockEntry(
  stock: number,
  modelId?: string | number | null
): { model_id?: number; seller_stock: { stock: number }[] } {
  const entry: { model_id?: number; seller_stock: { stock: number }[] } = {
    seller_stock: [{ stock: Math.max(0, Math.round(Number(stock) || 0)) }],
  };
  const mid = Number(modelId);
  if (Number.isFinite(mid) && mid > 0) {
    entry.model_id = mid;
  }
  return entry;
}

// Paginate get_order_list for one Shopee order_status — lật trang + quét 2 cửa sổ 15 ngày (= 30 ngày).
async function shopeeFetchAllOrderSnsByStatus(shopId: string, accessToken: string, orderStatus: string): Promise<string[]> {
  const orderSnSet = new Set<string>();
  const now = Math.floor(Date.now() / 1000);

  for (let windowIdx = 0; windowIdx < SHOPEE_ORDER_LIST_MAX_WINDOWS; windowIdx++) {
    const timeTo = now - windowIdx * SHOPEE_ORDER_LIST_WINDOW_SEC;
    const timeFrom = timeTo - SHOPEE_ORDER_LIST_WINDOW_SEC;
    let cursor: string | undefined;
    let page = 0;
    let windowCount = 0;

    console.log(
      `[Shopee Sync] shop_id=${shopId} status=${orderStatus}: cửa sổ ${windowIdx + 1}/${SHOPEE_ORDER_LIST_MAX_WINDOWS} time_from=${timeFrom} time_to=${timeTo} (update_time, ~15 ngày)`,
    );

    while (page < SHOPEE_ORDER_LIST_MAX_PAGES) {
      page++;
      const listResult = await shopeeGetOrderList(shopId, accessToken, {
        orderStatus,
        cursor,
        timeRangeField: "update_time",
        timeFrom,
        timeTo,
      });
      if (listResult.error) {
        const errMsg = listResult.message || formatShopeeApiError(listResult);
        console.error(
          `[Shopee Sync] shop_id=${shopId} status=${orderStatus} window=${windowIdx + 1} page=${page} lỗi:`,
          listResult.error,
          errMsg,
        );
        throw Object.assign(new Error(errMsg), { error: listResult.error, message: errMsg });
      }

      const pageList = extractShopeeOrderListRows(listResult);
      for (const row of pageList) {
        if (row?.order_sn) orderSnSet.add(String(row.order_sn));
        if (orderSnSet.size >= SHOPEE_SYNC_MAX_ORDER_SNS_PER_SHOP) break;
      }
      windowCount += pageList.length;

      const { more, nextCursor } = parseShopeeOrderListPagination(listResult);
      console.log(
        `[Shopee Sync] shop_id=${shopId} status=${orderStatus} window=${windowIdx + 1} page=${page}: +${pageList.length} (cửa sổ ${windowCount}, tổng ${orderSnSet.size}), more=${more}`,
      );

      if (!more) break;
      if (!nextCursor) {
        console.warn(
          `[Shopee Sync] shop_id=${shopId} status=${orderStatus} window=${windowIdx + 1}: more=true nhưng thiếu next_cursor — dừng sau trang ${page}.`,
        );
        break;
      }
      if (orderSnSet.size >= SHOPEE_SYNC_MAX_ORDER_SNS_PER_SHOP) {
        console.warn(`[Shopee Sync] shop_id=${shopId} đạt giới hạn ${SHOPEE_SYNC_MAX_ORDER_SNS_PER_SHOP} đơn — dừng phân trang.`);
        break;
      }
      cursor = nextCursor;
      await shopeeSyncDelay(SHOPEE_ORDER_LIST_PAGE_DELAY_MS);
    }

    if (orderSnSet.size >= SHOPEE_SYNC_MAX_ORDER_SNS_PER_SHOP) break;
    if (windowIdx < SHOPEE_ORDER_LIST_MAX_WINDOWS - 1) {
      await shopeeSyncDelay(SHOPEE_ORDER_LIST_PAGE_DELAY_MS);
    }
  }

  return Array.from(orderSnSet);
}

// Paginate get_order_list without status filter — quét 30 ngày (2 × 15 ngày) theo update_time.
async function shopeeFetchAllOrderSns(shopId: string, accessToken: string): Promise<string[]> {
  const orderSnSet = new Set<string>();
  const now = Math.floor(Date.now() / 1000);

  for (let windowIdx = 0; windowIdx < SHOPEE_ORDER_LIST_MAX_WINDOWS; windowIdx++) {
    const timeTo = now - windowIdx * SHOPEE_ORDER_LIST_WINDOW_SEC;
    const timeFrom = timeTo - SHOPEE_ORDER_LIST_WINDOW_SEC;
    let cursor: string | undefined;
    let page = 0;
    let windowCount = 0;

    console.log(
      `[Orders Pull] shop_id=${shopId}: cửa sổ ${windowIdx + 1}/${SHOPEE_ORDER_LIST_MAX_WINDOWS} time_from=${timeFrom} time_to=${timeTo} (update_time, ~15 ngày)`,
    );

    while (page < SHOPEE_ORDER_LIST_MAX_PAGES) {
      page++;
      const listResult = await shopeeGetOrderList(shopId, accessToken, {
        cursor,
        timeRangeField: "update_time",
        timeFrom,
        timeTo,
      });
      if (listResult.error) {
        console.error(`[Shopee API] shop_id=${shopId} window=${windowIdx + 1} lỗi:`, listResult.message || listResult.error);
        break;
      }

      const pageList = extractShopeeOrderListRows(listResult);
      for (const row of pageList) {
        if (row?.order_sn) orderSnSet.add(String(row.order_sn));
        if (orderSnSet.size >= SHOPEE_SYNC_MAX_ORDER_SNS_PER_SHOP) break;
      }
      windowCount += pageList.length;

      const { more, nextCursor } = parseShopeeOrderListPagination(listResult);
      console.log(
        `[Shopee API] shop_id=${shopId} window=${windowIdx + 1} page=${page}: +${pageList.length} (cửa sổ ${windowCount}, tổng ${orderSnSet.size}), more=${more}`,
      );

      if (!more) break;
      if (!nextCursor) break;
      if (orderSnSet.size >= SHOPEE_SYNC_MAX_ORDER_SNS_PER_SHOP) break;
      cursor = nextCursor;
      await shopeeSyncDelay(SHOPEE_ORDER_LIST_PAGE_DELAY_MS);
    }

    if (orderSnSet.size >= SHOPEE_SYNC_MAX_ORDER_SNS_PER_SHOP) break;
    if (windowIdx < SHOPEE_ORDER_LIST_MAX_WINDOWS - 1) {
      await shopeeSyncDelay(SHOPEE_ORDER_LIST_PAGE_DELAY_MS);
    }
  }

  return Array.from(orderSnSet);
}

// v2.order.get_order_detail
async function shopeeGetOrderDetail(shopId: string, accessToken: string, orderSnList: string[]) {
  const apiPath = "/api/v2/order/get_order_detail";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);

  const params = new URLSearchParams({
    partner_id: SHOPEE_PARTNER_ID,
    timestamp: String(timestamp),
    access_token: accessToken,
    shop_id: shopId,
    sign,
    order_sn_list: orderSnList.join(","),
    // Note: `image_info` is nested inside item_list automatically — not a top-level field.
    // `order_status` / `create_time` are NOT valid values here (they're returned by default);
    // passing them causes Shopee to reject the whole request with response_optional_fields error.
    response_optional_fields:
      "buyer_user_id,item_list,total_amount,shipping_carrier,package_list,can_partial_cancel_order,buyer_preference_for_partial_cancellation,cancel_reason,cancel_by",
  });

  const url = `${SHOPEE_HOST}${apiPath}?${params.toString()}`;
  try {
    const { json, httpStatus } = await shopeeFetchJsonWithRetry(
      url,
      `get_order_detail shop_id=${shopId} (${orderSnList.length} orders)`
    );
    console.log(
      `[Shopee API] GET ${apiPath} (shop_id=${shopId}, ${orderSnList.length} orders) -> HTTP ${httpStatus}:`,
      JSON.stringify(json).slice(0, 500),
    );

    if (json.error) {
      const errMsg = formatShopeeApiError(json, httpStatus);
      console.error(`[Shopee API] L\u1ED7i t\u1EEB Shopee khi l\u1EA5y chi ti\u1EBFt \u0111\u01A1n: ${errMsg}`);
      return { ...json, message: json.message || errMsg };
    }
    return json;
  } catch (err) {
    return shopeeApiErrorResult(err, `get_order_detail fetch (shop_id=${shopId})`);
  }
}

// v2.payment.get_escrow_detail — đối soát escrow_amount + withholding_cit_tax (VN CB seller).
async function shopeeGetEscrowDetail(shopId: string, accessToken: string, orderSn: string) {
  const apiPath = "/api/v2/payment/get_escrow_detail";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);
  const params = new URLSearchParams({
    partner_id: SHOPEE_PARTNER_ID,
    timestamp: String(timestamp),
    access_token: accessToken,
    shop_id: shopId,
    sign,
    order_sn: String(orderSn),
  });
  const url = `${SHOPEE_HOST}${apiPath}?${params.toString()}`;
  try {
    const { json, httpStatus } = await shopeeFetchJsonWithRetry(
      url,
      `get_escrow_detail shop_id=${shopId} order_sn=${orderSn}`,
    );
    if (json.error) {
      return { ...json, message: json.message || formatShopeeApiError(json, httpStatus) };
    }
    return json;
  } catch (err) {
    return shopeeApiErrorResult(err, `get_escrow_detail fetch (shop_id=${shopId}, order_sn=${orderSn})`);
  }
}

type ShopSyncTimeRange = "all" | "24h";
type ShopeeUpdateWindow = { from: number; to: number } | undefined;

// v2.product.get_item_list — paginated list of item_ids currently listed on the shop.
async function shopeeGetItemList(
  shopId: string,
  accessToken: string,
  offset: number,
  updateWindow?: ShopeeUpdateWindow,
) {
  const apiPath = "/api/v2/product/get_item_list";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);

  const params = new URLSearchParams({
    partner_id: SHOPEE_PARTNER_ID,
    timestamp: String(timestamp),
    access_token: accessToken,
    shop_id: shopId,
    sign,
    offset: String(offset),
    page_size: String(SHOPEE_ITEM_LIST_PAGE_SIZE),
    item_status: "NORMAL",
  });
  if (updateWindow) {
    params.set("update_time_from", String(updateWindow.from));
    params.set("update_time_to", String(updateWindow.to));
  }

  const url = `${SHOPEE_HOST}${apiPath}?${params.toString()}`;
  const rangeLabel = updateWindow ? ` update=${updateWindow.from}-${updateWindow.to}` : "";
  const { json, httpStatus } = await shopeeFetchJsonWithRetry(
    url,
    `GET ${apiPath} offset=${offset}${rangeLabel}`,
  );
  console.log(
    `[Shopee API] GET ${apiPath} (offset=${offset}${rangeLabel}) -> HTTP ${httpStatus}:`,
    JSON.stringify(json),
  );
  if (json.error) {
    json.message = json.message || formatShopeeApiError(json, httpStatus);
    console.error(`[Shopee API] Lỗi get_item_list: ${json.error} — ${json.message}`);
  }
  return json;
}

// v2.product.get_item_base_info — name/SKU/price/stock/image for up to 50 items at a time.
async function shopeeGetItemBaseInfo(shopId: string, accessToken: string, itemIds: number[]) {
  const apiPath = "/api/v2/product/get_item_base_info";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);

  const params = new URLSearchParams({
    partner_id: SHOPEE_PARTNER_ID,
    timestamp: String(timestamp),
    access_token: accessToken,
    shop_id: shopId,
    sign,
    item_id_list: itemIds.join(","),
    need_tax_info: "false",
    need_complaint_policy: "false",
  });

  const url = `${SHOPEE_HOST}${apiPath}?${params.toString()}`;
  const { json, httpStatus } = await shopeeFetchJsonWithRetry(url, `GET ${apiPath} (${itemIds.length} items)`);
  // Không dump toàn bộ response vào log (dễ OOM / fork fail trên cPanel).
  const itemCount = asShopeeArray(json?.response?.item_list).length;
  console.log(
    `[Shopee API] GET ${apiPath} (${itemIds.length} ids) -> HTTP ${httpStatus}, items=${itemCount}, error=${json?.error || "none"}`
  );
  if (json.error) {
    json.message = json.message || formatShopeeApiError(json, httpStatus);
    console.error(`[Shopee API] Lỗi get_item_base_info: ${json.error} — ${json.message}`);
  }
  return json;
}

// v2.product.get_model_list — required for items that have variants (has_model=true);
// get_item_base_info's own price_info/stock_info_v2 do NOT reflect real numbers for those.
async function shopeeGetModelList(shopId: string, accessToken: string, itemId: number) {
  const apiPath = "/api/v2/product/get_model_list";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);

  const params = new URLSearchParams({
    partner_id: SHOPEE_PARTNER_ID,
    timestamp: String(timestamp),
    access_token: accessToken,
    shop_id: shopId,
    sign,
    item_id: String(itemId),
  });

  const url = `${SHOPEE_HOST}${apiPath}?${params.toString()}`;
  const { json, httpStatus } = await shopeeFetchJsonWithRetry(url, `GET ${apiPath} item_id=${itemId}`);
  console.log(`[Shopee API] GET ${apiPath} (item_id=${itemId}) -> HTTP ${httpStatus}:`, JSON.stringify(json));
  if (json.error) {
    json.message = json.message || formatShopeeApiError(json, httpStatus);
  }
  return json;
}

async function shopeeGetModelListWithRetry(shopId: string, accessToken: string, itemId: number, retries = 3) {
  let last: any = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(SHOPEE_PRODUCT_API_DELAY_MS * attempt);
    last = await shopeeGetModelList(shopId, accessToken, itemId);
    if (!last?.error) return last;
    if (isShopeeRateLimited(0, last)) await sleep(SHOPEE_PRODUCT_API_DELAY_MS * 2);
  }
  return last;
}

// v2.product.update_stock — đẩy tồn kho seller_stock lên sàn Shopee (theo item_id, có/không model_id).
async function shopeeUpdateStock(
  shopId: string,
  accessToken: string,
  itemId: number,
  stockList: { model_id?: number; seller_stock: { stock: number }[] }[]
) {
  const apiPath = "/api/v2/product/update_stock";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);
  const url = `${SHOPEE_HOST}${apiPath}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&access_token=${accessToken}&shop_id=${shopId}&sign=${sign}`;

  const body = { item_id: itemId, stock_list: stockList };
  console.log(`[Shopee API] POST ${apiPath} REQUEST item_id=${itemId}:`, JSON.stringify(body));
  const { json, httpStatus } = await shopeePostJsonWithRetry(url, body, `POST ${apiPath} item_id=${itemId}`);
  console.log(`[Shopee API] POST ${apiPath} RESPONSE item_id=${itemId} HTTP ${httpStatus}:`, JSON.stringify(json));
  return json;
}

/** Chuẩn hóa 1 dòng price_list — original_price/model_id phải là NUMBER (không string). */
function buildShopeeUpdatePriceEntry(
  sellingPrice: unknown,
  modelId?: string | number | null
): { model_id?: number; original_price: number } {
  // VN và hầu hết region (trừ SG/MY/BR/...): giá phải là số nguyên.
  const originalPrice = Math.max(0, Math.round(Number(sellingPrice) || 0));
  const entry: { model_id?: number; original_price: number } = {
    original_price: originalPrice,
  };
  const mid = Number(modelId);
  if (Number.isFinite(mid) && mid > 0) {
    entry.model_id = mid;
  }
  return entry;
}

async function shopeeUpdatePrice(
  shopId: string,
  accessToken: string,
  itemId: number,
  priceList: { model_id?: number; original_price: number }[]
) {
  const apiPath = "/api/v2/product/update_price";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);
  const url = `${SHOPEE_HOST}${apiPath}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&access_token=${accessToken}&shop_id=${shopId}&sign=${sign}`;

  const numericItemId = Number(itemId);
  const normalizedPriceList = (Array.isArray(priceList) ? priceList : []).map((row) => {
    const originalPrice = Math.max(0, Math.round(Number(row?.original_price) || 0));
    const entry: { model_id?: number; original_price: number } = {
      original_price: originalPrice,
    };
    const mid = Number(row?.model_id);
    if (Number.isFinite(mid) && mid > 0) entry.model_id = mid;
    return entry;
  });
  if (!Number.isFinite(numericItemId) || numericItemId <= 0) {
    return {
      error: "error_param",
      message: "item_id không hợp lệ khi gọi update_price",
      response: { failure_list: [], success_list: [] },
    };
  }
  if (normalizedPriceList.length === 0) {
    return {
      error: "error_param",
      message: "price_list rỗng khi gọi update_price",
      response: { failure_list: [], success_list: [] },
    };
  }

  const body = { item_id: numericItemId, price_list: normalizedPriceList };
  console.log(`[Shopee API] POST ${apiPath} REQUEST item_id=${numericItemId}:`, JSON.stringify(body));
  const { json, httpStatus } = await shopeePostJsonWithRetry(url, body, `POST ${apiPath} item_id=${numericItemId}`, {
    maxAttempts: SHOPEE_SYNC_QUEUE_MAX_RETRY,
  });
  console.log(
    `[Shopee API] POST ${apiPath} RESPONSE item_id=${numericItemId} HTTP ${httpStatus}:`,
    JSON.stringify(json)
  );
  // HTTP 200 vẫn có thể chứa error/message/failure_list trong JSON body.
  if (json && typeof json === "object") {
    const businessError = String(json.error || "").trim();
    if (businessError && !String(json.message || "").trim()) {
      json.message = formatShopeeApiError(json, httpStatus >= 400 ? httpStatus : undefined);
    }
  }
  return json;
}

type ChannelSyncLine = {
  productId: string;
  sku: string;
  channel: string;
  action: string;
  success: boolean;
  message: string;
};

function parseShopeeApiResult(
  result: any,
  product: any,
  action: string
): ChannelSyncLine {
  const businessError = String(result?.error ?? "").trim();
  const businessMessage = String(result?.message ?? result?.msg ?? "").trim();
  const failures: any[] = Array.isArray(result?.response?.failure_list)
    ? result.response.failure_list
    : [];
  const successes: any[] = Array.isArray(result?.response?.success_list)
    ? result.response.success_list
    : [];

  // Bắt buộc đọc error/message trong JSON dù HTTP status = 200.
  if (businessError) {
    const detail =
      businessMessage && !/^HTTP\s+\d+$/i.test(businessMessage)
        ? `${businessError} — ${businessMessage}`
        : businessError;
    return {
      productId: product.id,
      sku: product.sku,
      channel: "shopee",
      action,
      success: false,
      message: detail,
    };
  }
  if (failures.length > 0) {
    const f = failures[0];
    return {
      productId: product.id,
      sku: product.sku,
      channel: "shopee",
      action,
      success: false,
      message: String(f.failed_reason || f.error || f.message || JSON.stringify(f)),
    };
  }
  // update_price/update_stock: nếu không có success_list và cũng không có failure_list rõ ràng
  // nhưng message báo lỗi → vẫn fail.
  if (businessMessage && /fail|error|invalid|reject/i.test(businessMessage)) {
    return {
      productId: product.id,
      sku: product.sku,
      channel: "shopee",
      action,
      success: false,
      message: businessMessage,
    };
  }
  if (action === "update_price" && successes.length === 0 && failures.length === 0) {
    return {
      productId: product.id,
      sku: product.sku,
      channel: "shopee",
      action,
      success: false,
      message:
        businessMessage ||
        "Shopee không xác nhận cập nhật giá (success_list rỗng).",
    };
  }
  return {
    productId: product.id,
    sku: product.sku,
    channel: "shopee",
    action,
    success: true,
    message: `Cập nhật ${action} Shopee thành công`,
  };
}

async function syncProductToShopee(
  product: any,
  shopId: string,
  accessToken: string
): Promise<ChannelSyncLine[]> {
  const itemId = getShopeeItemIdForStockPush(product);
  const modelId = resolveShopeeModelIdForStockPush(product);
  if (itemId == null) {
    const base = {
      productId: product.id,
      sku: product.sku,
      channel: "shopee",
      success: false,
      message: "Thiếu shopeeItemId — SKU chưa liên kết Shopee",
    };
    return [
      { ...base, action: "update_stock" },
      { ...base, action: "update_price" },
    ];
  }
  if (productRequiresShopeeModelId(product, 1) && modelId == null) {
    const msg = "Phân loại (variant) thiếu model_id — bắt buộc truyền item_id + model_id khi update_stock";
    await appendShopeeSyncErrorToDb({
      itemId,
      modelId: undefined,
      sku: product.sku,
      shopId,
      action: "update_stock",
      error: msg,
      productId: product.id,
    });
    const base = {
      productId: product.id,
      sku: product.sku,
      channel: "shopee" as const,
      success: false,
      message: msg,
    };
    return [
      { ...base, action: "update_stock" },
      { ...base, action: "update_price" },
    ];
  }

  const preCheck = await verifyShopeeItemExists(shopId, accessToken, itemId);
  if (!preCheck.exists) {
    await markShopeeItemsInvalidInDb([itemId], preCheck.detail || "product.error_item_not_found");
    const msg = `Shopee item không tồn tại (${preCheck.detail || "product.error_item_not_found"}) — đã đánh dấu invalid`;
    await appendShopeeSyncErrorToDb({
      itemId,
      modelId: modelId ?? product.shopeeModelId,
      sku: product.sku,
      shopId,
      action: "update_stock",
      error: msg,
      productId: product.id,
    });
    const base = {
      productId: product.id,
      sku: product.sku,
      channel: "shopee" as const,
      success: false,
      message: msg,
    };
    return [
      { ...base, action: "update_stock" },
      { ...base, action: "update_price" },
    ];
  }

  const stockEntry = buildShopeeUpdateStockEntry(product.stock, modelId);
  const priceEntry = buildShopeeUpdatePriceEntry(product.sellingPrice, modelId);

  let stockResult: any;
  try {
    stockResult = await shopeeUpdateStock(shopId, accessToken, itemId, [stockEntry]);
  } catch (err: unknown) {
    const netMsg = extractShopeeStockPushErrorMessage(err, err instanceof Error ? err.message : String(err));
    await appendShopeeSyncErrorToDb({
      itemId,
      modelId: modelId ?? product.shopeeModelId,
      sku: product.sku,
      shopId,
      action: "update_stock",
      error: netMsg,
      productId: product.id,
    });
    const base = {
      productId: product.id,
      sku: product.sku,
      channel: "shopee" as const,
      success: false,
      message: `update_stock: ${netMsg} — đã bỏ qua`,
    };
    return [
      { ...base, action: "update_stock" },
      { ...base, action: "update_price" },
    ];
  }

  if (isShopeeItemNotFoundError(stockResult)) {
    const detail = `${stockResult?.error || "product.error_item_not_found"}${stockResult?.message ? ` — ${stockResult.message}` : ""}`;
    await markShopeeItemsInvalidInDb([itemId], detail);
    await appendShopeeSyncErrorToDb({
      itemId,
      modelId: product.shopeeModelId,
      sku: product.sku,
      shopId,
      action: "update_stock",
      error: detail,
      productId: product.id,
    });
    const msg = `update_stock: ${detail} — đã đánh dấu invalid, bỏ qua`;
    const base = { productId: product.id, sku: product.sku, channel: "shopee" as const, success: false, message: msg };
    return [
      { ...base, action: "update_stock" },
      { ...base, action: "update_price" },
    ];
  }
  await sleep(SHOPEE_PRODUCT_API_DELAY_MS);
  const priceResult = await shopeeUpdatePrice(shopId, accessToken, itemId, [priceEntry]);
  if (isShopeeItemNotFoundError(priceResult)) {
    await markShopeeItemsInvalidInDb([itemId], priceResult?.error || "product.error_item_not_found");
  }

  return [
    parseShopeeApiResult(stockResult, product, "update_stock"),
    parseShopeeApiResult(priceResult, product, "update_price"),
  ];
}

async function syncProductToWoo(product: any, shop: any): Promise<ChannelSyncLine[]> {
  const base = {
    productId: product.id,
    sku: product.sku,
    channel: "woocommerce",
    action: "update_product",
  };

  if (!shop?.wooUrl || !shop?.apiKey) {
    return [{ ...base, success: false, message: "Chưa cấu hình WooCommerce (URL/API Key)" }];
  }
  if (!product.wooId) {
    return [{ ...base, success: false, message: "Thiếu wooId — SKU chưa liên kết WooCommerce" }];
  }

  const baseUrl = String(shop.wooUrl).replace(/\/$/, "");
  const url = `${baseUrl}/wp-json/wc/v3/products/${product.wooId}`;
  const auth = Buffer.from(`${shop.apiKey}:${shop.apiSecret || ""}`).toString("base64");

  try {
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        regular_price: String(Math.round(Number(product.sellingPrice) || 0)),
        stock_quantity: Math.max(0, Math.round(Number(product.stock) || 0)),
        manage_stock: true,
      }),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const errMsg = json?.message || json?.code || `HTTP ${res.status}`;
      return [{ ...base, success: false, message: `WooCommerce từ chối: ${errMsg}` }];
    }
    return [{ ...base, success: true, message: `Cập nhật giá & tồn kho WooCommerce thành công (ID: ${product.wooId})` }];
  } catch (e: any) {
    return [{ ...base, success: false, message: `Lỗi kết nối WooCommerce: ${e?.message || "network error"}` }];
  }
}

async function syncProductToTikTok(product: any): Promise<ChannelSyncLine[]> {
  const base = {
    productId: product.id,
    sku: product.sku,
    channel: "tiktok",
    action: "update_product",
  };
  if (!product.tiktokId) {
    return [{ ...base, success: false, message: "Thiếu tiktokId — SKU chưa liên kết TikTok Shop" }];
  }
  return [{ ...base, success: false, message: "API TikTok Shop chưa được tích hợp trên server" }];
}

async function resolveShopeeShopForItemId(
  itemId: number,
  preferredShopId?: string
): Promise<{ shopId: string; accessToken: string } | null> {
  const tokens = loadShopeeTokens();
  const shopIds = Object.keys(tokens);
  if (!shopIds.length) return null;

  const preferred = String(preferredShopId || "").trim();
  const tryOrder = preferred && tokens[preferred]
    ? [preferred, ...shopIds.filter((id) => id !== preferred)]
    : shopIds;

  for (const sid of tryOrder) {
    const accessToken = await getValidShopeeAccessToken(sid);
    if (!accessToken) continue;
    const result = await shopeeGetItemBaseInfo(sid, accessToken, [itemId]);
    const found = Array.isArray(result?.response?.item_list) && result.response.item_list.length > 0;
    if (!result?.error && found) {
      return { shopId: sid, accessToken };
    }
  }
  return null;
}

function isStaleShopeeItemErrorText(text: string): boolean {
  const t = String(text || "").toLowerCase();
  return (
    t.includes("item_not_found") ||
    t.includes("error_item_not_found") ||
    t.includes("item_id is not found") ||
    t.includes("item is not found") ||
    t.includes("is not found")
  );
}

function isShopeeItemNotFoundError(result: any): boolean {
  const parts = [
    result?.error,
    result?.message,
    result?.response?.error,
    ...(Array.isArray(result?.response?.failure_list) ? result.response.failure_list : []).map(
      (f: any) => f?.failed_reason || f?.error
    ),
  ];
  return parts.some((p) => isStaleShopeeItemErrorText(String(p || "")));
}

async function verifyShopeeItemExists(
  shopId: string,
  accessToken: string,
  itemId: number
): Promise<{ exists: boolean; detail?: string }> {
  const result = await shopeeGetItemBaseInfo(shopId, accessToken, [itemId]);
  if (result?.error || isShopeeItemNotFoundError(result)) {
    const detail = `${result?.error || "product.error_item_not_found"}${result?.message ? ` — ${result.message}` : ""}`.trim();
    return { exists: false, detail };
  }
  const found = Array.isArray(result?.response?.item_list) && result.response.item_list.length > 0;
  if (!found) return { exists: false, detail: "product.error_item_not_found" };
  return { exists: true };
}

async function refreshShopeeLiveItemIdSet(shopId: string, accessToken: string): Promise<Set<number>> {
  const ids = await fetchAllShopeeItemIds(shopId, accessToken);
  console.log(`[Shopee Push Stock] Refresh get_item_list: ${ids.length} item_id đang liệt kê trên shop`);
  return new Set(ids);
}

async function markShopeeItemsInvalidInDb(itemIds: number[], reason: string): string[] {
  const idSet = new Set(itemIds.map(Number).filter((n) => Number.isFinite(n) && n > 0));
  if (idSet.size === 0) return [];

  const products = await loadProducts();
  const affectedSkus: string[] = [];

  const nextProducts = products.map((p: any) => {
    const itemId = getShopeeItemIdForStockPush(p);
    if (itemId == null || !idSet.has(itemId)) return p;

    const children = getProductChildrenList(p);
    for (const c of children.length ? children : [p]) {
      const sku = String(c.sku || "").trim();
      if (sku) affectedSkus.push(sku);
    }
    console.warn(`[Shopee Stock] item_id=${itemId}: ${reason} — đánh dấu invalid, bỏ qua đẩy tồn`);
    const channels = Array.isArray(p.channels) ? p.channels.filter((c: string) => c !== "shopee") : p.channels;
    return {
      ...p,
      shopeeItemId: undefined,
      shopeeModelId: undefined,
      shopeeId: undefined,
      shopeeLinkStatus: "invalid",
      children: children.map((c: any) => ({
        ...c,
        shopeeItemId: undefined,
        shopeeModelId: undefined,
        shopeeId: undefined,
        shopeeLinkStatus: "invalid",
        channels: Array.isArray(c.channels) ? c.channels.filter((ch: string) => ch !== "shopee") : c.channels,
      })),
      channels,
      lastSynced: new Date().toISOString(),
    };
  });

  if (affectedSkus.length > 0) await saveProducts(nextProducts);

  try {
    const listings = await readChannelListingsDb();
    let listingChanged = false;
    const nextListings = listings.map((row: any) => {
      const cid = Number(row.channelId);
      if (row.platform !== "shopee" || !Number.isFinite(cid) || !idSet.has(cid)) return row;
      listingChanged = true;
      return {
        ...sanitizeChannelListingRow(row),
        status: "invalid",
        linkedProductId: undefined,
        updatedAt: new Date().toISOString(),
      };
    });
    if (listingChanged) await writeChannelListingsDb(nextListings);
  } catch (err) {
    console.error("[Shopee Stock] Không cập nhật channel_listings:", err);
  }

  return [...new Set(affectedSkus)];
}

/** Parse channelId dạng itemId hoặc itemId:modelId (+ hint từ listing). */
function parseShopeeChannelLinkIds(
  channelId?: string | number | null,
  modelIdHint?: string | number | null,
  itemIdHint?: string | number | null
): { itemId: number | null; modelId: number | null } {
  const pickPositive = (v: unknown): number | null => {
    const n = Number(String(v ?? "").match(/(\d+)/)?.[1] ?? v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const cid = String(channelId ?? "").trim();
  if (cid.includes(":")) {
    const [left, right] = cid.split(":");
    return {
      itemId: pickPositive(left) || pickPositive(itemIdHint),
      modelId: pickPositive(right) || pickPositive(modelIdHint),
    };
  }

  const itemFromCid = pickPositive(cid.match(/(\d{6,})/)?.[1] ?? cid);
  return {
    itemId: itemFromCid || pickPositive(itemIdHint),
    modelId: pickPositive(modelIdHint),
  };
}

function resolveShopeeModelIdForStockPush(product: any): number | null {
  for (const c of [product?.shopeeModelId, product?.modelId, product?.model_id]) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const fromChannel = parseShopeeChannelLinkIds(product?.shopeeId ?? product?.shopeeItemId);
  if (fromChannel.modelId) return fromChannel.modelId;
  const fromId = String(product?.id || "").match(/-model-(\d+)/);
  if (fromId) {
    const n = Number(fromId[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function getShopeeItemIdForStockPush(product: any): number | null {
  const parsed = parseShopeeChannelLinkIds(
    product?.shopeeItemId ?? product?.shopeeId,
    product?.shopeeModelId,
    product?.itemId
  );
  if (parsed.itemId) return parsed.itemId;
  const fromId = String(product?.id || "").match(/shopee-item-(\d+)/);
  if (fromId) {
    const n = Number(fromId[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/** Variant buộc phải có model_id khi gọi update_stock. */
function productRequiresShopeeModelId(product: any, siblingCountForItem: number): boolean {
  if (siblingCountForItem > 1) return true;
  if (resolveShopeeModelIdForStockPush(product) != null) return true;
  if (String(product?.id || "").includes("-model-")) return true;
  if (String(product?.shopeeId || product?.shopeeItemId || "").includes(":")) return true;
  return false;
}

/** Gán item_id + model_id chuẩn lên sản phẩm kho gốc khi liên kết Shopee. */
function applyShopeeLinkFieldsToProduct(
  product: any,
  channelId: string,
  opts?: { modelId?: string | number | null; itemId?: string | number | null }
): any {
  const parsed = parseShopeeChannelLinkIds(channelId, opts?.modelId ?? product?.shopeeModelId, opts?.itemId);
  const channels: string[] = Array.isArray(product?.channels) ? [...product.channels] : [];
  if (!channels.includes("shopee")) channels.push("shopee");
  const next = { ...product, channels };
  if (parsed.itemId) {
    next.shopeeItemId = String(parsed.itemId);
    next.shopeeId =
      parsed.modelId != null ? `${parsed.itemId}:${parsed.modelId}` : String(channelId || parsed.itemId);
  } else if (channelId) {
    next.shopeeId = String(channelId);
    next.shopeeItemId = String(channelId);
  }
  if (parsed.modelId) next.shopeeModelId = String(parsed.modelId);
  return next;
}

function extractSkusFromShopeeRows(rows: any[]): string[] {
  return rows.map((r) => String(r.sku || "").trim()).filter(Boolean);
}

/** Trích thông báo lỗi Shopee chi tiết từ response / exception. */
function extractShopeeStockPushErrorMessage(resultOrErr: unknown, fallback = "Lỗi Shopee update_stock"): string {
  if (resultOrErr == null) return fallback;
  if (typeof resultOrErr === "string") return resultOrErr || fallback;
  const anyVal = resultOrErr as any;
  if (anyVal instanceof Error) {
    const fromResp = anyVal as Error & { response?: { data?: any } };
    const data = fromResp.response?.data;
    if (data) return formatShopeeApiError(data) || fromResp.message || fallback;
    return fromResp.message || fallback;
  }
  const failures: any[] =
    anyVal?.response?.failure_list ||
    anyVal?.response?.stock_list?.filter?.((s: any) => s.failed_reason) ||
    [];
  if (Array.isArray(failures) && failures.length > 0) {
    const reasons = failures
      .map((f: any) => String(f.failed_reason || f.error || f.message || "").trim())
      .filter(Boolean);
    if (reasons.length) return reasons.join("; ");
  }
  return formatShopeeApiError(anyVal) || fallback;
}

async function pushStockUpdatesToShopee(
  updatedProducts: any[],
  requestedShopId?: string
): Promise<{ ok: boolean; errors: string[]; warnings: string[]; pushed: number; staleSkus: string[] }> {
  const shopeeRows = flattenProductsForStockSync(updatedProducts).filter(
    (p) => getShopeeItemIdForStockPush(p) != null
  );
  if (shopeeRows.length === 0) {
    return { ok: true, errors: [], warnings: [], pushed: 0, staleSkus: [] };
  }

  const preferredShopId = resolveShopeeTokenShopId(requestedShopId);
  if (!preferredShopId && !Object.keys(loadShopeeTokens()).length) {
    return { ok: false, errors: ["Chưa có shop Shopee được ủy quyền."], warnings: [], pushed: 0, staleSkus: [] };
  }

  const accessToken = preferredShopId ? await getValidShopeeAccessToken(preferredShopId) : null;
  const errors: string[] = [];
  const warnings: string[] = [];
  const staleSkus: string[] = [];
  let liveItemIds: Set<number> | null = null;
  if (preferredShopId && accessToken) {
    try {
      liveItemIds = await refreshShopeeLiveItemIdSet(preferredShopId, accessToken);
    } catch (err: any) {
      warnings.push(`Không refresh được danh sách item Shopee: ${err?.message || err}. Sẽ kiểm tra từng item.`);
    }
  }

  const byItem = new Map<number, any[]>();
  for (const p of shopeeRows) {
    const itemId = getShopeeItemIdForStockPush(p)!;
    if (!byItem.has(itemId)) byItem.set(itemId, []);
    byItem.get(itemId)!.push(p);
  }

  const invalidItemIds = new Set<number>();
  let pushed = 0;

  const markStaleItem = (itemId: number, rows: any[], detail: string) => {
    const skus = extractSkusFromShopeeRows(rows);
    warnings.push(`item_id=${itemId} (SKU: ${skus.join(", ")}): ${detail}`);
    staleSkus.push(...skus);
    invalidItemIds.add(itemId);
  };

  const itemEntries = [...byItem.entries()];
  let processedInBatch = 0;

  for (const [itemId, rows] of itemEntries) {
    let resolved =
      preferredShopId && accessToken ? { shopId: preferredShopId, accessToken } : null;
    if (!resolved) {
      resolved = await resolveShopeeShopForItemId(itemId, preferredShopId || undefined);
    }
    if (!resolved) {
      markStaleItem(
        itemId,
        rows,
        "Không tìm thấy trên Shopee — đã bỏ qua đẩy tồn. Hãy đồng bộ lại sản phẩm hoặc cập nhật liên kết."
      );
      continue;
    }

    if (liveItemIds && !liveItemIds.has(itemId)) {
      const verified = await verifyShopeeItemExists(resolved.shopId, resolved.accessToken, itemId);
      if (!verified.exists) {
        markStaleItem(
          itemId,
          rows,
          `Không còn trong danh sách Shopee (${verified.detail || "product.error_item_not_found"}) — đã bỏ qua đẩy tồn.`
        );
        continue;
      }
    }

    const preCheck = await verifyShopeeItemExists(resolved.shopId, resolved.accessToken, itemId);
    if (!preCheck.exists) {
      markStaleItem(
        itemId,
        rows,
        `get_item_base_info thất bại (${preCheck.detail || "product.error_item_not_found"}) — đã bỏ qua đẩy tồn.`
      );
      for (const p of rows) {
        await appendShopeeSyncErrorToDb({
          itemId,
          modelId: p.shopeeModelId,
          sku: p.sku,
          shopId: resolved.shopId,
          action: "update_stock",
          error: preCheck.detail || "product.error_item_not_found",
          productId: p.id,
        });
      }
      continue;
    }

    await sleep(SHOPEE_PRODUCT_API_DELAY_MS);

    const stockList: ReturnType<typeof buildShopeeUpdateStockEntry>[] = [];
    for (const p of rows) {
      const modelId = resolveShopeeModelIdForStockPush(p);
      // Tồn lấy từ Kho sản phẩm chính (Master Inventory) — field stock trên hàng đã flatten.
      const masterStock = Math.max(0, Math.round(Number(p.stock) || 0));
      if (productRequiresShopeeModelId(p, rows.length) && modelId == null) {
        const line = `SKU ${p.sku || p.id}: phân loại (variant) thiếu model_id — bắt buộc truyền item_id + model_id khi update_stock.`;
        errors.push(line);
        await appendShopeeSyncErrorToDb({
          itemId,
          modelId: undefined,
          sku: p.sku,
          shopId: resolved.shopId,
          action: "update_stock",
          error: line,
          productId: p.id,
        });
        continue;
      }
      stockList.push(buildShopeeUpdateStockEntry(masterStock, modelId));
    }

    if (stockList.length === 0) {
      processedInBatch++;
      await sleep(SHOPEE_PRODUCT_API_DELAY_MS);
      continue;
    }

    let result: any;
    try {
      result = await shopeeUpdateStock(resolved.shopId, resolved.accessToken, itemId, stockList);
    } catch (err: unknown) {
      const netMsg = extractShopeeStockPushErrorMessage(err, err instanceof Error ? err.message : String(err));
      const skus = extractSkusFromShopeeRows(rows).join(", ");
      errors.push(`item_id=${itemId} (SKU: ${skus}): update_stock lỗi — ${netMsg}`);
      for (const p of rows) {
        await appendShopeeSyncErrorToDb({
          itemId,
          modelId: resolveShopeeModelIdForStockPush(p) ?? p.shopeeModelId,
          sku: p.sku,
          shopId: resolved.shopId,
          action: "update_stock",
          error: netMsg,
          productId: p.id,
        });
      }
      processedInBatch++;
      await sleep(SHOPEE_PRODUCT_API_DELAY_MS);
      if (processedInBatch % SHOPEE_PRODUCT_BATCH_SIZE === 0 && processedInBatch < itemEntries.length) {
        console.log(`[Shopee Push Stock] Nghỉ ${SHOPEE_PRODUCT_BATCH_PAUSE_MS}ms sau ${processedInBatch}/${itemEntries.length} item...`);
        await sleep(SHOPEE_PRODUCT_BATCH_PAUSE_MS);
      }
      continue;
    }

    const failures: any[] =
      result?.response?.failure_list ||
      result?.response?.stock_list?.filter?.((s: any) => s.failed_reason) ||
      [];

    if (result?.error || isShopeeItemNotFoundError(result)) {
      const skus = extractSkusFromShopeeRows(rows).join(", ");
      const detail = extractShopeeStockPushErrorMessage(result);
      if (isShopeeItemNotFoundError(result) || result?.error === "product.error_item_not_found") {
        markStaleItem(itemId, rows, `update_stock: ${detail} — sản phẩm đã mất trên Shopee, đã bỏ qua.`);
      } else {
        errors.push(`item_id=${itemId} (SKU: ${skus}): ${detail}`);
      }
      for (const p of rows) {
        await appendShopeeSyncErrorToDb({
          itemId,
          modelId: resolveShopeeModelIdForStockPush(p) ?? p.shopeeModelId,
          sku: p.sku,
          shopId: resolved.shopId,
          action: "update_stock",
          error: detail,
          productId: p.id,
        });
      }
    }

    if (Array.isArray(failures) && failures.length > 0) {
      for (const f of failures) {
        const reason = String(f.failed_reason || f.error || "");
        if (!reason) continue;
        const line = `item_id=${itemId} model_id=${f.model_id ?? "?"}: ${reason}`;
        if (isStaleShopeeItemErrorText(reason)) {
          markStaleItem(itemId, rows, line);
        } else {
          errors.push(line);
        }
        await appendShopeeSyncErrorToDb({
          itemId,
          modelId: f.model_id,
          shopId: resolved.shopId,
          action: "update_stock",
          error: reason,
        });
      }
    }

    if (!result?.error && !isShopeeItemNotFoundError(result) && (!failures.length || failures.every((f: any) => !f.failed_reason && !f.error))) {
      pushed += rows.length;
    }

    processedInBatch++;
    await sleep(SHOPEE_PRODUCT_API_DELAY_MS);
    if (processedInBatch % SHOPEE_PRODUCT_BATCH_SIZE === 0 && processedInBatch < itemEntries.length) {
      console.log(`[Shopee Push Stock] Nghỉ ${SHOPEE_PRODUCT_BATCH_PAUSE_MS}ms sau ${processedInBatch}/${itemEntries.length} item...`);
      await sleep(SHOPEE_PRODUCT_BATCH_PAUSE_MS);
    }
  }

  if (invalidItemIds.size > 0) {
    const dbSkus = await markShopeeItemsInvalidInDb(
      [...invalidItemIds],
      "Sản phẩm không tồn tại trên Shopee (product.error_item_not_found)"
    );
    for (const sku of dbSkus) {
      if (!staleSkus.includes(sku)) staleSkus.push(sku);
    }
  }

  return { ok: errors.length === 0, errors, warnings, pushed, staleSkus: [...new Set(staleSkus)] };
}

// ---------------------------------------------------------------------------
// Shopee Sync Queue — rate-limit (750ms) + retry (tối đa 3) cho stock/price
// ---------------------------------------------------------------------------

type ShopeeSyncQueueJob = {
  key: string;
  productId: string;
  syncStock: boolean;
  syncPrice: boolean;
  attempts: number;
  enqueuedAt: string;
};

const shopeeSyncQueue: ShopeeSyncQueueJob[] = [];
const shopeeSyncQueueKeys = new Set<string>();
let shopeeSyncQueueRunning = false;
/** Chỉ 1 job nặng (sync đơn / ship-order) chạy cùng lúc — tránh NPROC 100% trên cPanel. */
let cpanelHeavyJobActive: string | null = null;

function tryAcquireHeavyJob(name: string): boolean {
  if (cpanelHeavyJobActive) {
    console.warn(`[Heavy Job] Từ chối "${name}" — "${cpanelHeavyJobActive}" đang chạy`);
    return false;
  }
  cpanelHeavyJobActive = name;
  return true;
}

function releaseHeavyJob(name: string): void {
  if (cpanelHeavyJobActive === name) cpanelHeavyJobActive = null;
}

function detectStockPriceChanges(
  before: any,
  after: any
): { stock: boolean; price: boolean } {
  const stockBefore = Math.max(0, Math.round(Number(before?.stock) || 0));
  const stockAfter = Math.max(0, Math.round(Number(after?.stock) || 0));
  const priceBefore = Math.max(0, Math.round(Number(before?.sellingPrice) || 0));
  const priceAfter = Math.max(0, Math.round(Number(after?.sellingPrice) || 0));
  return {
    stock: stockBefore !== stockAfter,
    price: priceBefore !== priceAfter,
  };
}

function findProductRowById(products: any[], productId: string): any | null {
  const id = String(productId || "").trim();
  if (!id) return null;
  for (const p of Array.isArray(products) ? products : []) {
    if (String(p?.id || "").trim() === id) return p;
    for (const child of getProductChildrenList(p)) {
      if (String(child?.id || "").trim() === id) return child;
    }
  }
  return null;
}

/**
 * Gắn Shopee item/model từ DB Mapping (channel_listings) nếu sản phẩm kho đã liên kết.
 * Không đụng logic Mapping UI — chỉ đọc.
 */
async function resolveProductWithShopeeMapping(product: any): any | null {
  if (!product || typeof product !== "object") return null;

  if (getShopeeItemIdForStockPush(product) != null) {
    return product;
  }

  let listings: any[] = [];
  try {
    listings = await readChannelListingsDb();
  } catch (err) {
    console.error("[Shopee Sync Queue] Không đọc được channel_listings:", err);
    return null;
  }

  const productId = String(product.id || "").trim();
  if (!productId) return null;

  const match = listings.find((row) => {
    if (!row || typeof row !== "object") return false;
    const platform = String(row.platform || "shopee").trim().toLowerCase();
    if (platform && platform !== "shopee") return false;
    const linkedId =
      row.linkedProductId != null && String(row.linkedProductId).trim() !== ""
        ? String(row.linkedProductId).trim()
        : row.linkedProduct?.id != null
          ? String(row.linkedProduct.id).trim()
          : "";
    if (!linkedId || linkedId !== productId) return false;
    const status = String(row.status || "").trim().toLowerCase();
    return status === "success" || linkedId !== "";
  });

  if (!match) return null;

  const channelId = String(match.channelId || match.itemId || "").trim();
  if (!channelId && match.itemId == null) return null;

  const enriched = applyShopeeLinkFieldsToProduct(product, channelId || String(match.itemId), {
    modelId: match.modelId ?? match.shopeeModelId,
    itemId: match.itemId,
  });

  if (getShopeeItemIdForStockPush(enriched) == null) return null;
  return enriched;
}

async function executeShopeeStockPriceSyncJob(
  product: any,
  opts: { syncStock: boolean; syncPrice: boolean }
): Promise<{ ok: boolean; message: string }> {
  const mapped = await resolveProductWithShopeeMapping(product);
  if (!mapped) {
    return { ok: false, message: "Chưa liên kết Mapping Shopee — bỏ qua sync." };
  }

  const shopId = resolveShopeeTokenShopId();
  if (!shopId) {
    return { ok: false, message: "Chưa có shop Shopee được ủy quyền." };
  }
  const accessToken = await getValidShopeeAccessToken(shopId);
  if (!accessToken) {
    return { ok: false, message: `Chưa có access_token hợp lệ cho shop_id=${shopId}.` };
  }

  const itemId = getShopeeItemIdForStockPush(mapped);
  const modelId = resolveShopeeModelIdForStockPush(mapped);
  if (itemId == null) {
    return { ok: false, message: "Thiếu Shopee item_id sau khi resolve Mapping." };
  }

  const lines: string[] = [];

  if (opts.syncStock) {
    const stockEntry = buildShopeeUpdateStockEntry(mapped.stock, modelId);
    try {
      const stockResult = await shopeeUpdateStock(shopId, accessToken, itemId, [stockEntry]);
      const parsed = parseShopeeApiResult(stockResult, mapped, "update_stock");
      lines.push(parsed.message);
      if (!parsed.success) {
        await appendShopeeSyncErrorToDb({
          itemId,
          modelId: modelId ?? mapped.shopeeModelId,
          sku: mapped.sku,
          shopId,
          action: "update_stock",
          error: parsed.message,
          productId: mapped.id,
        });
        return { ok: false, message: parsed.message };
      }
    } catch (err: unknown) {
      const msg = extractShopeeStockPushErrorMessage(err, err instanceof Error ? err.message : String(err));
      await appendShopeeSyncErrorToDb({
        itemId,
        modelId: modelId ?? mapped.shopeeModelId,
        sku: mapped.sku,
        shopId,
        action: "update_stock",
        error: msg,
        productId: mapped.id,
      });
      return { ok: false, message: msg };
    }
  }

  if (opts.syncPrice) {
    await sleep(SHOPEE_SYNC_QUEUE_GAP_MS);
    const priceEntry = buildShopeeUpdatePriceEntry(mapped.sellingPrice, modelId);
    try {
      const priceResult = await shopeeUpdatePrice(shopId, accessToken, itemId, [priceEntry]);
      const parsed = parseShopeeApiResult(priceResult, mapped, "update_price");
      lines.push(parsed.message);
      if (!parsed.success) {
        await appendShopeeSyncErrorToDb({
          itemId,
          modelId: modelId ?? mapped.shopeeModelId,
          sku: mapped.sku,
          shopId,
          action: "update_price",
          error: parsed.message,
          productId: mapped.id,
        });
        return { ok: false, message: parsed.message };
      }
    } catch (err: unknown) {
      const msg = extractShopeeStockPushErrorMessage(
        err,
        err instanceof Error ? err.message : String(err)
      );
      await appendShopeeSyncErrorToDb({
        itemId,
        modelId: modelId ?? mapped.shopeeModelId,
        sku: mapped.sku,
        shopId,
        action: "update_price",
        error: msg,
        productId: mapped.id,
      });
      return { ok: false, message: msg };
    }
  }

  return { ok: true, message: lines.join(" | ") || "Sync Shopee OK" };
}

/** Đẩy stock/price lên Shopee ngay (không qua queue) — dùng cho PATCH sản phẩm / nút sync nhanh. */
async function pushProductStockPriceToShopeeImmediate(
  product: any,
  opts: { syncStock: boolean; syncPrice: boolean }
): Promise<{ ok: boolean; skipped?: boolean; message: string }> {
  if (!opts.syncStock && !opts.syncPrice) {
    return { ok: true, skipped: true, message: "Không có thay đổi tồn/giá cần đồng bộ Shopee." };
  }
  const mapped = await resolveProductWithShopeeMapping(product);
  if (!mapped) {
    return {
      ok: true,
      skipped: true,
      message: "Chưa liên kết Mapping Shopee — chỉ lưu kho nội bộ.",
    };
  }
  return executeShopeeStockPriceSyncJob(mapped, {
    syncStock: opts.syncStock,
    syncPrice: opts.syncPrice,
  });
}

async function processShopeeSyncQueue(): Promise<void> {
  if (shopeeSyncQueueRunning) return;
  shopeeSyncQueueRunning = true;

  try {
    while (shopeeSyncQueue.length > 0) {
      const job = shopeeSyncQueue.shift()!;
      shopeeSyncQueueKeys.delete(job.key);

      try {
        const row = await loadProductById(job.productId);
        if (!row) {
          console.warn(`[Shopee Sync Queue] Bỏ qua — không thấy productId=${job.productId}`);
          await sleep(SHOPEE_SYNC_QUEUE_GAP_MS);
          continue;
        }

        const mapped = await resolveProductWithShopeeMapping(row);
        if (!mapped) {
          console.log(
            `[Shopee Sync Queue] Skip SKU=${row.sku || job.productId} — chưa Mapping Shopee`
          );
          await sleep(SHOPEE_SYNC_QUEUE_GAP_MS);
          continue;
        }

        const result = await executeShopeeStockPriceSyncJob(mapped, {
          syncStock: job.syncStock,
          syncPrice: job.syncPrice,
        });

        if (result.ok) {
          console.log(
            `[Shopee Sync Queue] OK productId=${job.productId} sku=${mapped.sku} stock=${job.syncStock} price=${job.syncPrice} — ${result.message}`
          );
        } else {
          job.attempts += 1;
          console.error(
            `[Shopee Sync Queue] FAIL attempt ${job.attempts}/${SHOPEE_SYNC_QUEUE_MAX_RETRY} productId=${job.productId} sku=${mapped.sku}: ${result.message}`
          );
          if (job.attempts < SHOPEE_SYNC_QUEUE_MAX_RETRY) {
            const retryKey = `${job.productId}|stock=${job.syncStock}|price=${job.syncPrice}`;
            job.key = retryKey;
            if (!shopeeSyncQueueKeys.has(retryKey)) {
              shopeeSyncQueueKeys.add(retryKey);
              shopeeSyncQueue.push(job);
            }
          } else {
            console.error(
              `[Shopee Sync Queue] DROPPED sau ${SHOPEE_SYNC_QUEUE_MAX_RETRY} lần — productId=${job.productId} sku=${mapped.sku}: ${result.message}`
            );
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[Shopee Sync Queue] Exception job=${job.productId}:`, err);
        job.attempts += 1;
        if (job.attempts < SHOPEE_SYNC_QUEUE_MAX_RETRY) {
          if (!shopeeSyncQueueKeys.has(job.key)) {
            shopeeSyncQueueKeys.add(job.key);
            shopeeSyncQueue.push(job);
          }
        } else {
          console.error(`[Shopee Sync Queue] DROPPED exception — ${job.productId}: ${msg}`);
        }
      }

      await sleep(SHOPEE_SYNC_QUEUE_GAP_MS);
    }
  } finally {
    shopeeSyncQueueRunning = false;
    if (shopeeSyncQueue.length > 0) {
      setTimeout(() => {
        void processShopeeSyncQueue();
      }, SHOPEE_SYNC_QUEUE_GAP_MS);
    }
  }
}

/** Đưa sync stock/price vào hàng đợi (chỉ khi đã Mapping + có thay đổi thật). */
async function enqueueShopeeStockPriceSync(
  products: any[],
  opts: { syncStock?: boolean; syncPrice?: boolean }
): Promise<number> {
  const syncStock = opts.syncStock === true;
  const syncPrice = opts.syncPrice === true;
  if (!syncStock && !syncPrice) return 0;

  let enqueued = 0;
  for (const raw of Array.isArray(products) ? products : []) {
    if (!raw || typeof raw !== "object") continue;
    const productId = String(raw.id || "").trim();
    if (!productId) continue;

    const mapped = await resolveProductWithShopeeMapping(raw);
    if (!mapped) continue;

    const key = `${productId}|stock=${syncStock}|price=${syncPrice}`;
    if (shopeeSyncQueueKeys.has(key)) {
      // Merge: nếu job cũ đang chờ, giữ nguyên (đã cùng flags)
      continue;
    }

    shopeeSyncQueueKeys.add(key);
    shopeeSyncQueue.push({
      key,
      productId,
      syncStock,
      syncPrice,
      attempts: 0,
      enqueuedAt: new Date().toISOString(),
    });
    enqueued += 1;
  }

  if (enqueued > 0) {
    console.log(
      `[Shopee Sync Queue] Enqueued ${enqueued} job(s) — queue size=${shopeeSyncQueue.length} (gap=${SHOPEE_SYNC_QUEUE_GAP_MS}ms)`
    );
    void processShopeeSyncQueue();
  }
  return enqueued;
}

/** Sau khi lưu kho: so sánh trước/sau, enqueue sync nếu Mapping Shopee. */
async function enqueueShopeeSyncAfterProductChange(
  beforeRows: any[],
  afterRows: any[]
): number {
  let stockChanged = false;
  let priceChanged = false;
  const changedProducts: any[] = [];

  for (const after of afterRows) {
    if (!after?.id) continue;
    const before = beforeRows.find((b) => String(b?.id) === String(after.id));
    const changes = detectStockPriceChanges(before || {}, after);
    if (!changes.stock && !changes.price) continue;
    if (changes.stock) stockChanged = true;
    if (changes.price) priceChanged = true;
    changedProducts.push(after);
  }

  if (changedProducts.length === 0) return 0;
  return await enqueueShopeeStockPriceSync(changedProducts, {
    syncStock: stockChanged,
    syncPrice: priceChanged,
  });
}

function getItemAvatarUrl(item: any): string | undefined {
  const list = item?.image?.image_url_list;
  return Array.isArray(list) && list.length > 0 ? String(list[0]) : undefined;
}

function resolveShopeeTokenShopId(requested?: string): string | null {
  const tokens = loadShopeeTokens();
  const keys = Object.keys(tokens);
  if (!keys.length) return null;
  const req = String(requested || "").trim();
  if (req && tokens[req]) return req;
  if (req) {
    const digits = req.match(/(\d{5,})/)?.[1];
    if (digits && tokens[digits]) return digits;
  }
  return keys[0];
}

/** Ép mọi giá trị Shopee về mảng an toàn — tránh crash `.map` khi API trả object/null. */
function asShopeeArray<T = any>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function parseModelListFromResponse(modelResult: any): { tierVariations: any[]; models: any[] } {
  const resp = modelResult?.response || {};
  const modelsRaw = resp?.model_list ?? resp?.model ?? [];
  const tiersRaw =
    resp?.tier_variation ?? resp?.standardise_tier_variation ?? resp?.tier_variations ?? [];
  return {
    tierVariations: asShopeeArray(tiersRaw),
    models: asShopeeArray(modelsRaw).filter((m) => m != null),
  };
}

function extractInlineModelsFromItem(item: any): { tierVariations: any[]; models: any[] } {
  const tierVariations = asShopeeArray(
    item?.tier_variation ?? item?.standardise_tier_variation ?? item?.tier_variations ?? []
  );
  let models: any[] = [];
  if (asShopeeArray(item?.model_list).length > 0) {
    models = asShopeeArray(item?.model_list);
  } else if (asShopeeArray(item?.model).length > 0) {
    models = asShopeeArray(item?.model);
  } else if (asShopeeArray(item?.models).length > 0) {
    models = asShopeeArray(item?.models);
  }
  return { tierVariations, models: models.filter((m) => m != null) };
}

function itemHasShopeeVariants(item: any): boolean {
  if (item?.has_model === true || item?.has_model === 1) return true;
  const { models } = extractInlineModelsFromItem(item);
  return models.length > 0;
}

function getModelDisplayName(model: any, tierVariations: any[]): string {
  if (model?.model_name) return String(model.model_name).trim();
  const tierIndex: number[] = Array.isArray(model?.tier_index) ? model.tier_index : [];
  const parts: string[] = [];
  const tiers = asShopeeArray(tierVariations);
  for (let tierPos = 0; tierPos < tierIndex.length; tierPos++) {
    const optIdx = tierIndex[tierPos];
    const tier = tiers?.[tierPos];
    let opt = tier?.option_list?.[optIdx]?.option;
    if (!opt && tier?.variation_option_list?.[optIdx]?.variation_option_name) {
      opt = tier?.variation_option_list?.[optIdx]?.variation_option_name;
    }
    if (!opt && Array.isArray(tier?.options)) opt = tier?.options?.[optIdx];
    if (opt) parts.push(String(opt).trim());
  }
  if (parts.length > 0) return parts.join(" / ");
  const sku = String(model?.model_sku || "").trim();
  if (sku) return sku;
  return model?.model_id != null ? `Phân loại #${model.model_id}` : "Phân loại";
}

function parseModelStock(model: any): number {
  const s2 = model?.stock_info_v2;
  if (s2?.seller_stock?.[0]?.stock != null) return Math.max(0, Number(s2.seller_stock[0].stock) || 0);
  if (s2?.summary_info?.total_available_stock != null) return Math.max(0, Number(s2.summary_info.total_available_stock) || 0);
  if (model?.stock != null) return Math.max(0, Number(model.stock) || 0);
  if (model?.normal_stock != null) return Math.max(0, Number(model.normal_stock) || 0);
  return Math.max(0, Number(model?.stock_info?.[0]?.current_stock) || 0);
}

function parseModelPrice(model: any): number {
  const pi = model?.price_info;
  if (Array.isArray(pi) && pi.length > 0) {
    return Math.max(0, Number(pi[0].current_price ?? pi[0].original_price) || 0);
  }
  if (pi && typeof pi === "object") {
    return Math.max(0, Number(pi.current_price ?? pi.original_price) || 0);
  }
  return Math.max(0, Number(model?.price) || 0);
}

function buildSingleWarehouseRow(item: any): any {
  const itemId = item?.item_id;
  const avatarUrl = getItemAvatarUrl(item);
  const sku = String(item?.item_sku || "").trim() || String(itemId);
  const stock = Number(item?.stock_info_v2?.summary_info?.total_available_stock) || 0;
  const priceInfo = asShopeeArray(item?.price_info);
  const price = Number(priceInfo[0]?.current_price ?? priceInfo[0]?.original_price) || 0;

  return {
    id: `shopee-item-${itemId}`,
    title: item?.item_name || `Sản phẩm Shopee ${itemId}`,
    sku,
    barcode: sku,
    category: item?.category_id ? String(item.category_id) : "Chưa phân loại",
    stock,
    importPrice: 0,
    sellingPrice: price,
    channels: ["shopee"],
    imageUrl: avatarUrl,
    avatarUrl,
    description: item?.description || "",
    status: item?.item_status !== "NORMAL" ? "draft" : (stock > 0 ? "active" : "out_of_stock"),
    shopeeId: String(itemId),
    shopeeItemId: String(itemId),
    children: [],
    lastSynced: new Date().toISOString(),
  };
}

/** Parent Product + children — mỗi model là 1 child (giữ model_id để đồng bộ tồn). */
function buildParentWarehouseRow(item: any, children: any[]): any {
  const itemId = item?.item_id;
  const avatarUrl = getItemAvatarUrl(item);
  const sku = String(item?.item_sku || "").trim() || String(itemId);
  const safeChildren = asShopeeArray(children).filter((c) => c != null);
  const totalStock = safeChildren.reduce((sum, c) => sum + (Number(c?.stock) || 0), 0);
  const prices = safeChildren.map((c) => Number(c?.sellingPrice) || 0).filter((n) => n > 0);
  const price = prices.length ? Math.min(...prices) : 0;
  const baseName = item?.item_name || `Sản phẩm Shopee ${itemId}`;

  return {
    id: `shopee-item-${itemId}`,
    title: baseName,
    sku,
    barcode: sku,
    category: item?.category_id ? String(item.category_id) : "Chưa phân loại",
    stock: totalStock,
    importPrice: 0,
    sellingPrice: price,
    channels: ["shopee"],
    imageUrl: avatarUrl,
    avatarUrl,
    description: item?.description || "",
    status: item?.item_status !== "NORMAL" ? "draft" : (totalStock > 0 ? "active" : "out_of_stock"),
    shopeeId: String(itemId),
    shopeeItemId: String(itemId),
    children: safeChildren,
    lastSynced: new Date().toISOString(),
  };
}

/** Flatten Parent→Child thành dòng SKU phẳng (dùng cho update_stock theo model_id). */
function flattenProductsForStockSync(products: any[]): any[] {
  const out: any[] = [];
  for (const p of products || []) {
    const children = getProductChildrenList(p);
    if (children.length > 0) {
      for (const child of children) {
        out.push({
          ...child,
          shopeeItemId: child.shopeeItemId || p.shopeeItemId,
          channels: child.channels?.length ? child.channels : p.channels,
        });
      }
      continue;
    }
    out.push(p);
  }
  return out;
}

function getModelImageUrl(item: any, model: any, tierVariations: any[]): string {
  const tierIndex: number[] = Array.isArray(model?.tier_index) ? model.tier_index : [];
  for (let tierPos = 0; tierPos < tierIndex.length; tierPos++) {
    const optIdx = tierIndex[tierPos];
    const tier = tierVariations?.[tierPos];
    const opt = tier?.option_list?.[optIdx] || tier?.variation_option_list?.[optIdx];
    const url = opt?.image?.image_url || opt?.image_url;
    if (url) return url;
  }
  return getItemAvatarUrl(item);
}

function buildVariantWarehouseRow(item: any, model: any, tierVariations: any[], modelIndex: number): any {
  const safeModel = model && typeof model === "object" ? model : {};
  const itemId = item?.item_id;
  const modelId = safeModel.model_id != null ? safeModel.model_id : `idx${modelIndex}`;
  const tiers = asShopeeArray(tierVariations);
  const modelName = getModelDisplayName(safeModel, tiers);
  const baseName = item?.item_name || `Sản phẩm Shopee ${itemId}`;
  const avatarUrl = getModelImageUrl(item, safeModel, tiers);
  const parentSku = String(item?.item_sku || "").trim() || undefined;
  const sku = String(safeModel.model_sku || "").trim() || `${itemId}-M${modelId}`;
  const stock = parseModelStock(safeModel);
  const price = parseModelPrice(safeModel);
  const tierIndex = asShopeeArray<number>(safeModel.tier_index);

  return {
    id: `shopee-item-${itemId}-model-${modelId}`,
    title: `${baseName} - ${modelName}`,
    sku,
    barcode: sku,
    modelName,
    parentSku,
    category: item?.category_id ? String(item.category_id) : "Chưa phân loại",
    stock,
    importPrice: 0,
    sellingPrice: price,
    channels: ["shopee"],
    imageUrl: avatarUrl,
    avatarUrl,
    description: item?.description || "",
    status: item?.item_status !== "NORMAL" ? "draft" : (stock > 0 ? "active" : "out_of_stock"),
    shopeeId: `${itemId}:${modelId}`,
    shopeeItemId: String(itemId),
    shopeeModelId: String(modelId),
    tierLabels: tierIndex
      .map((optIdx: number, tierPos: number) => tiers?.[tierPos]?.option_list?.[optIdx]?.option)
      .filter(Boolean),
    lastSynced: new Date().toISOString(),
  };
}

async function syncShopeeItemToWarehouseRows(
  shopId: string,
  accessToken: string,
  item: any,
  opts?: { strict?: boolean }
): Promise<{ rows: any[]; modelCount: number; error?: string }> {
  try {
    if (!item || item.item_id == null) {
      return { rows: [], modelCount: 0, error: "invalid_item" };
    }

    const itemId = item.item_id;
    let { tierVariations, models } = extractInlineModelsFromItem(item);
    const hasVariants = itemHasShopeeVariants(item);

    const toParentRows = (modelList: any[]) => {
      const safeModels = asShopeeArray(modelList).filter((m) => m != null);
      const children = safeModels.map((model, idx) =>
        buildVariantWarehouseRow(item, model, tierVariations, idx)
      );
      return {
        rows: [buildParentWarehouseRow(item, children)],
        modelCount: children.length,
      };
    };

    if (models.length > 0) {
      const result = toParentRows(models);
      console.log(`[Shopee Sync] item_id=${itemId} -> Parent + ${result.modelCount} children (model_list inline)`);
      return result;
    }

    if (!hasVariants) {
      return { rows: [buildSingleWarehouseRow(item)], modelCount: 0 };
    }

    const modelResult = await shopeeGetModelListWithRetry(shopId, accessToken, Number(itemId), 3);
    if (modelResult?.error || isShopeeItemNotFoundError(modelResult)) {
      const err = `${modelResult?.error || "product.error_item_not_found"}${modelResult?.message ? `: ${modelResult.message}` : ""}`;
      console.error(`[Shopee Sync] get_model_list item_id=${itemId}: ${err}`);
      await appendShopeeSyncErrorToDb({
        itemId,
        shopId,
        action: "pullProducts",
        error: err,
      });
      if (opts?.strict || isShopeeItemNotFoundError(modelResult)) {
        return { rows: [], modelCount: 0, error: isShopeeItemNotFoundError(modelResult) ? "item_not_found" : err };
      }
      // Fallback an toàn: lưu 1 dòng parent thay vì crash
      return { rows: [buildSingleWarehouseRow(item)], modelCount: 0, error: err };
    }

    const parsed = parseModelListFromResponse(modelResult);
    tierVariations = parsed.tierVariations;
    models = parsed.models;

    if (models.length > 0) {
      const result = toParentRows(models);
      console.log(`[Shopee Sync] item_id=${itemId} -> Parent + ${result.modelCount} children (get_model_list)`);
      return result;
    }

    console.warn(`[Shopee Sync] item_id=${itemId} has_model=true nhưng model_list rỗng — lưu 1 dòng parent`);
    return { rows: [buildSingleWarehouseRow(item)], modelCount: 0 };
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[Shopee Sync] syncShopeeItemToWarehouseRows item_id=${item?.item_id}: ${reason}`);
    try {
      await appendShopeeSyncErrorToDb({
        itemId: item?.item_id,
        shopId,
        action: "pullProducts",
        error: reason,
      });
    } catch {
      /* ignore */
    }
    // Không ném ra ngoài — trả lỗi có kiểm soát
    if (item?.item_id != null) {
      try {
        return { rows: [buildSingleWarehouseRow(item)], modelCount: 0, error: reason };
      } catch {
        return { rows: [], modelCount: 0, error: reason };
      }
    }
    return { rows: [], modelCount: 0, error: reason };
  }
}

async function fetchShopeeItemListPage(
  shopId: string,
  accessToken: string,
  offset: number,
  updateWindow?: ShopeeUpdateWindow,
): Promise<{ itemIds: number[]; hasMore: boolean; nextOffset: number; pageIndex: number }> {
  const listResult = await shopeeGetItemList(shopId, accessToken, offset, updateWindow);
  if (listResult?.error) {
    throw new Error(formatShopeeApiError(listResult) || `${listResult.error}: ${listResult.message || ""}`);
  }
  const items = asShopeeArray(listResult?.response?.item);
  const itemIds = items
    .map((it: any) => Number(it?.item_id))
    .filter((n: number) => Number.isFinite(n) && n > 0);
  const hasMore = !!listResult?.response?.has_next_page && items.length > 0;
  const nextOffset = listResult?.response?.next_offset ?? offset + items.length;
  const pageIndex = Math.floor(offset / SHOPEE_ITEM_LIST_PAGE_SIZE);
  return { itemIds, hasMore, nextOffset, pageIndex };
}

async function processShopeeItemsToListingRows(
  shopId: string,
  accessToken: string,
  items: any[]
): Promise<{
  rows: any[];
  skippedItems: { itemId: string; reason: string }[];
  variantItemCount: number;
}> {
  const products: any[] = [];
  const skippedItems: { itemId: string; reason: string }[] = [];
  let variantItemCount = 0;
  const safeItems = asShopeeArray(items).filter((it) => it != null && it.item_id != null);

  // Strict sequential for...of — CẤM Promise.all / map(async).
  for (const item of safeItems) {
    try {
      const r = await syncShopeeItemToWarehouseRows(shopId, accessToken, item);
      if (r.error && (!r.rows || r.rows.length === 0)) {
        skippedItems.push({ itemId: String(item?.item_id), reason: r.error });
      } else {
        if (r.modelCount > 0) variantItemCount++;
        products.push(...asShopeeArray(r.rows));
      }
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[Shopee Sync] pullProducts item_id=${item?.item_id}: ${reason}`);
      try {
        await appendShopeeSyncErrorToDb({
          itemId: item?.item_id,
          shopId,
          action: "pullProducts",
          error: reason,
        });
      } catch {
        /* ignore */
      }
      skippedItems.push({ itemId: String(item?.item_id ?? "?"), reason });
    }
    await yieldEventLoop(CHANNEL_FETCH_YIELD_MS);
  }

  return {
    rows: dedupeShopeeParentVariantRows(products),
    skippedItems,
    variantItemCount,
  };
}

/** Khóa UPSERT mapping: shopee::itemId[::modelId] — tránh duplicate key khi pull lại. */
function channelListingUpsertKey(itemId: string, modelId?: string | null): string {
  const mid = String(modelId || "").trim();
  return mid ? `shopee::${itemId}::${mid}` : `shopee::${itemId}`;
}

/** Bóc item_id + model_id từ row Shopee / listing (optional chaining an toàn). */
function resolveUpsertItemModelFromRow(item: any): { itemId: string; modelId: string; channelId: string } | null {
  if (!item || typeof item !== "object") return null;

  const parsed = parseShopeeChannelLinkIds(
    item?.shopeeId ?? item?.channelId,
    item?.shopeeModelId ?? item?.modelId,
    item?.shopeeItemId ?? item?.itemId
  );

  const itemId =
    (parsed.itemId != null ? String(parsed.itemId) : "") ||
    String(item?.shopeeItemId ?? item?.itemId ?? "").trim() ||
    String(item?.shopeeId ?? "").split(":")[0]?.trim() ||
    "";
  if (!itemId) return null;

  const modelId =
    (parsed.modelId != null ? String(parsed.modelId) : "") ||
    String(item?.shopeeModelId ?? item?.modelId ?? "").trim() ||
    (String(item?.shopeeId || "").includes(":")
      ? String(item.shopeeId).split(":")[1]?.trim() || ""
      : "") ||
    "";

  const channelId = modelId ? `${itemId}:${modelId}` : itemId;
  return { itemId, modelId, channelId };
}

/**
 * UPSERT incremental channel_listings theo khóa item_id + model_id.
 * Có rồi → cập nhật; chưa có → thêm. Không dùng insert/create thuần (tránh duplicate crash).
 * Caller phải await và yield giữa các lần gọi (xem upsertChannelListingsBatchSequential).
 */
async function upsertChannelListingsBatch(
  batchRows: any[],
  shopId: string,
  shopName: string
): Promise<number> {
  try {
    if (!Array.isArray(batchRows) || batchRows.length === 0) return 0;

    ensureDataDirs();

    const existing = await readChannelListingsDb();
    const byKey = new Map<string, any>();
    for (const listing of existing) {
      if (!listing || typeof listing !== "object") continue;
      const ids = resolveUpsertItemModelFromRow(listing);
      if (!ids) continue;
      byKey.set(channelListingUpsertKey(ids.itemId, ids.modelId), listing);
    }

    let flatRows: any[] = [];
    try {
      flatRows = flattenProductsForStockSync(batchRows);
    } catch (flatErr: unknown) {
      console.error("DB Save Error:", flatErr);
      flatRows = batchRows.filter((r) => r != null);
    }

    let saved = 0;
    let inserted = 0;
    let updated = 0;

    for (const item of flatRows) {
      try {
        const ids = resolveUpsertItemModelFromRow(item);
        if (!ids) continue;

        const key = channelListingUpsertKey(ids.itemId, ids.modelId);
        const prev = byKey.get(key);
        const keepExistingLink =
          prev?.status === "success" &&
          !!prev?.linkedProductId &&
          !isSyntheticShopeePullProduct({ id: prev.linkedProductId });

        if (prev) updated++;
        else inserted++;

        byKey.set(
          key,
          sanitizeChannelListingRow({
            id: prev?.id || `cl-shopee-${ids.channelId}`,
            title: String(item?.title || ""),
            sku: String(item?.sku || ""),
            imageUrl: item?.avatarUrl || item?.imageUrl || undefined,
            channelId: ids.channelId,
            platform: "shopee",
            shopName: String(shopName || ""),
            shopId: shopId != null ? String(shopId) : undefined,
            modelId: ids.modelId || prev?.modelId,
            itemId: ids.itemId,
            status: keepExistingLink ? "success" : prev?.status === "failed" ? "failed" : "unlinked",
            linkedProductId: keepExistingLink ? prev.linkedProductId : undefined,
          })
        );
        saved++;
      } catch (rowErr: unknown) {
        console.error("DB Save Error: (skip row)", rowErr);
      }
    }

    await writeChannelListingsDbAsync(Array.from(byKey.values()));
    console.log(
      `Đã lưu DB thành công — channel_listings UPSERT insert=${inserted}, update=${updated}, touched=${saved}, totalKeys=${byKey.size}`
    );
    return saved;
  } catch (err: unknown) {
    console.error("DB Save Error:", err);
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/** UPSERT tuần tự + yield CPU sau mỗi lần ghi (tránh cagefs_enter Unable to fork). */
async function upsertChannelListingsBatchSequential(
  batchRows: any[],
  shopId: string,
  shopName: string
): Promise<number> {
  const saved = await upsertChannelListingsBatch(batchRows, shopId, shopName);
  await yieldEventLoop(CHANNEL_FETCH_YIELD_MS);
  return saved;
}

/**
 * Pull 1 trang Shopee → xử lý STRICT SEQUENCE: micro-batch ≤10 id,
 * mỗi item sync + upsert DB xong 100% rồi mới sang item tiếp (có yield 50ms).
 * CẤM Promise.all / map(async).
 */
async function pullShopeeChannelListingsPage(
  shopId: string,
  accessToken: string,
  shopName: string,
  offset: number,
  updateWindow?: ShopeeUpdateWindow,
): Promise<{
  currentOffset: number;
  nextOffset: number;
  hasMore: boolean;
  pageIndex: number;
  rowsSaved: number;
  pageStats: {
    itemsInPage: number;
    rowsInPage: number;
    variantItemCount: number;
    skippedCount: number;
  };
  skippedItems: { itemId: string; reason: string }[];
}> {
  try {
    const page = await fetchShopeeItemListPage(shopId, accessToken, offset, updateWindow);
    if (page.itemIds.length === 0) {
      return {
        currentOffset: offset,
        nextOffset: page.nextOffset,
        hasMore: false,
        pageIndex: page.pageIndex,
        rowsSaved: 0,
        pageStats: { itemsInPage: 0, rowsInPage: 0, variantItemCount: 0, skippedCount: 0 },
        skippedItems: [],
      };
    }

    let rowsSaved = 0;
    let rowsInPage = 0;
    let variantItemCount = 0;
    const skippedItems: { itemId: string; reason: string }[] = [];
    const allIds = asShopeeArray(page.itemIds).filter((n) => Number.isFinite(Number(n)) && Number(n) > 0);

    // Micro-batch ≤10 id — tuần tự tuyệt đối, không gom cả trang vào RAM.
    for (let batchStart = 0; batchStart < allIds.length; batchStart += CHANNEL_FETCH_MICRO_BATCH) {
      const idBatch = allIds.slice(batchStart, batchStart + CHANNEL_FETCH_MICRO_BATCH);
      const baseItems = await fetchShopeeBaseItemsByIds(shopId, accessToken, idBatch);
      await yieldEventLoop(CHANNEL_FETCH_YIELD_MS);

      for (const item of asShopeeArray(baseItems)) {
        if (!item || item.item_id == null) continue;
        try {
          const r = await syncShopeeItemToWarehouseRows(shopId, accessToken, item);
          if (r.error && (!r.rows || r.rows.length === 0)) {
            skippedItems.push({ itemId: String(item.item_id), reason: r.error });
          } else {
            if (r.modelCount > 0) variantItemCount++;
            const rows = asShopeeArray(r.rows);
            rowsInPage += rows.length;
            // Await upsert dứt điểm TỪNG sản phẩm trước khi sang item tiếp theo.
            rowsSaved += await upsertChannelListingsBatchSequential(rows, shopId, shopName);
          }
        } catch (itemErr: unknown) {
          const reason = itemErr instanceof Error ? itemErr.message : String(itemErr);
          console.error(`[Shopee Channel Fetch] item_id=${item?.item_id}: ${reason}`);
          skippedItems.push({ itemId: String(item?.item_id ?? "?"), reason });
          try {
            await appendShopeeSyncErrorToDb({
              itemId: item?.item_id,
              shopId,
              action: "channelFetch",
              error: reason,
            });
          } catch {
            /* ignore */
          }
        }
        await yieldEventLoop(CHANNEL_FETCH_YIELD_MS);
      }

      await yieldEventLoop(CHANNEL_FETCH_YIELD_MS);
    }

    console.log(
      `[Shopee Channel Fetch] Trang offset=${offset}: ${allIds.length} item -> ${rowsInPage} dong, da luu ${rowsSaved} vao DB (sequential)`,
    );

    return {
      currentOffset: offset,
      nextOffset: page.nextOffset,
      hasMore: page.hasMore,
      pageIndex: page.pageIndex,
      rowsSaved,
      pageStats: {
        itemsInPage: allIds.length,
        rowsInPage,
        variantItemCount,
        skippedCount: skippedItems.length,
      },
      skippedItems,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Shopee Channel Fetch] Page offset=${offset} failed:`, message);
    throw err instanceof Error ? err : new Error(message);
  }
}

/**
 * UPSERT Kho gốc theo khóa shopeeItemId (item_id) / id.
 * Có rồi → cập nhật; chưa có → thêm mới. Map đúng title/sku/price/stock từ Shopee.
 */
async function mergeWarehouseProductsBatch(batchRows: any[]): number {
  try {
    if (!Array.isArray(batchRows) || batchRows.length === 0) return 0;

    ensureDataDirs();
    const existing = await loadProducts();
    const byId = new Map<string, any>();
    const byShopeeItemId = new Map<string, string>();

    for (const p of existing) {
      if (!p || typeof p !== "object" || p.id == null) continue;
      const id = String(p.id);
      byId.set(id, p);
      const itemId = String(p.shopeeItemId || "").trim();
      if (itemId) byShopeeItemId.set(itemId, id);
    }

    let upserted = 0;
    for (const row of batchRows) {
      try {
        if (!row || typeof row !== "object") continue;

        const itemId = String(row.shopeeItemId || row.item_id || "").trim();
        const existingId = itemId ? byShopeeItemId.get(itemId) : undefined;
        const id =
          existingId ||
          String(row.id || (itemId ? `shopee-item-${itemId}` : `prod-${Date.now()}-${upserted}`));

        const prev = byId.get(id);
        const mapped = {
          ...row,
          id,
          title: String(row.title || row.item_name || prev?.title || `Shopee ${itemId || id}`),
          sku: String(row.sku || row.item_sku || prev?.sku || itemId || id),
          stock: Math.max(0, Number(row.stock ?? prev?.stock) || 0),
          sellingPrice: Math.max(0, Number(row.sellingPrice ?? row.price ?? prev?.sellingPrice) || 0),
          importPrice: Math.max(0, Number(row.importPrice ?? prev?.importPrice) || 0),
          shopeeItemId: itemId || prev?.shopeeItemId,
          shopeeId: row.shopeeId != null ? String(row.shopeeId) : prev?.shopeeId || itemId,
          channels: Array.isArray(row.channels) && row.channels.length
            ? row.channels
            : prev?.channels || ["shopee"],
          children: Array.isArray(row.children) ? row.children : prev?.children || [],
          lastSynced: new Date().toISOString(),
        };

        const merged = mergeShopeeRowPreservingLocal(prev, mapped);
        byId.set(id, merged);
        if (itemId) byShopeeItemId.set(itemId, id);
        upserted++;
      } catch (rowErr: unknown) {
        console.error("Lỗi khi lưu DB chunk: (skip row)", rowErr);
      }
    }

    console.log("Dữ liệu sau khi map (trước khi lưu):", upserted);
    await saveProducts([...byId.values()]);
    return upserted;
  } catch (error: unknown) {
    console.error("Lỗi khi lưu DB chunk:", error);
    throw error instanceof Error ? error : new Error(String(error));
  }
}

/**
 * Đồng bộ kho Shopee — chunked/paginated:
 * Tải ≤50 item → Lưu DB → nghỉ 100ms → lặp (không vét cạn 1 lần, không Promise.all).
 */
async function pullShopeeWarehouseAllPages(
  shopId: string,
  accessToken: string
): Promise<{
  stats: {
    itemCount: number;
    rowCount: number;
    variantItemCount: number;
    skippedCount: number;
    pageCount: number;
  };
  skippedItems: { itemId: string; reason: string }[];
}> {
  const startedAt = Date.now();
  try {
    const existing = await loadProducts();
    const kept = existing.filter(
      (p: any) => !p.shopeeItemId && !(Array.isArray(p.channels) && p.channels.includes("shopee"))
    );
    await saveProducts(kept);
    console.log(
      `[Shopee Warehouse Sync] Khởi tạo: giữ ${kept.length} SP không-Shopee, xóa tạm SP Shopee cũ trước khi pull`
    );
  } catch (error: unknown) {
    console.error("Lỗi khi lưu DB chunk:", error);
    throw error instanceof Error ? error : new Error(String(error));
  }

  let offset = 0;
  let hasMore = true;
  let pageGuard = 0;
  let itemCount = 0;
  let rowCount = 0;
  let variantItemCount = 0;
  const skippedItems: { itemId: string; reason: string }[] = [];
  let pendingRows: any[] = [];
  let pendingItemCount = 0;

  const flushPending = async () => {
    if (pendingRows.length === 0) return 0;
    try {
      console.log("Dữ liệu sau khi map (trước khi lưu):", pendingRows.length);
      const n = await mergeWarehouseProductsBatch(pendingRows);
      pendingRows = [];
      pendingItemCount = 0;
      return n;
    } catch (error: unknown) {
      console.error("Lỗi khi lưu DB chunk:", error);
      throw error;
    }
  };

  while (hasMore && pageGuard < PRODUCT_SYNC_MAX_PAGES) {
    pageGuard++;
    console.log(`Đang cập nhật trang ${pageGuard}... (warehouse sync / khởi tạo offset=${offset})`);

    try {
      const page = await fetchShopeeItemListPage(shopId, accessToken, offset);
      console.log("Dữ liệu thô từ Shopee (số lượng):", page.itemIds.length);
      if (page.itemIds.length === 0) {
        console.log(`Đang cập nhật trang ${pageGuard}... trống — hasMore=${page.hasMore}`);
        if (!page.hasMore) break;
        offset = page.nextOffset;
        await sleep(PRODUCT_SYNC_CHUNK_PAUSE_MS);
        continue;
      }

      // Micro-batch id ≤ CHANNEL_FETCH_MICRO_BATCH — tuần tự, không gom cả trang khổng lồ.
      const allIds = asShopeeArray(page.itemIds).filter((n) => Number.isFinite(Number(n)) && Number(n) > 0);
      for (let batchStart = 0; batchStart < allIds.length; batchStart += CHANNEL_FETCH_MICRO_BATCH) {
        const idBatch = allIds.slice(batchStart, batchStart + CHANNEL_FETCH_MICRO_BATCH);
        const baseItems = await fetchShopeeBaseItemsByIds(shopId, accessToken, idBatch);
        console.log("Dữ liệu thô từ Shopee (số lượng):", asShopeeArray(baseItems).length);
        await yieldEventLoop(CHANNEL_FETCH_YIELD_MS);

        for (const item of asShopeeArray(baseItems)) {
          if (!item || item.item_id == null) continue;
          try {
            const r = await syncShopeeItemToWarehouseRows(shopId, accessToken, item);
            if (r.error && (!r.rows || r.rows.length === 0)) {
              skippedItems.push({ itemId: String(item.item_id), reason: r.error });
            } else {
              if (r.modelCount > 0) variantItemCount++;
              const rows = asShopeeArray(r.rows);
              console.log("Dữ liệu sau khi map (trước khi lưu):", rows.length);
              pendingRows.push(...rows);
              pendingItemCount += 1;
              itemCount += 1;
              rowCount += rows.length;

              // Đủ ~50 sản phẩm → ghi DB → nghỉ 100ms.
              if (pendingItemCount >= PRODUCT_SYNC_CHUNK_SIZE) {
                try {
                  flushPending();
                } catch (chunkErr: unknown) {
                  console.error("Lỗi khi lưu DB chunk:", chunkErr);
                  skippedItems.push({
                    itemId: `chunk_page_${pageGuard}`,
                    reason: chunkErr instanceof Error ? chunkErr.message : String(chunkErr),
                  });
                  pendingRows = [];
                  pendingItemCount = 0;
                }
                console.log(
                  `Đang cập nhật trang ${pageGuard}... đã lưu chunk ${PRODUCT_SYNC_CHUNK_SIZE} item (tổng item=${itemCount})`
                );
                await sleep(PRODUCT_SYNC_CHUNK_PAUSE_MS);
              }
            }
          } catch (itemErr: unknown) {
            const reason = itemErr instanceof Error ? itemErr.message : String(itemErr);
            skippedItems.push({ itemId: String(item?.item_id ?? "?"), reason });
            console.error(`[Shopee Warehouse Sync] item_id=${item?.item_id}: ${reason}`);
          }
          await yieldEventLoop(CHANNEL_FETCH_YIELD_MS);
        }
      }

      try {
        flushPending();
      } catch (chunkErr: unknown) {
        console.error("Lỗi khi lưu DB chunk:", chunkErr);
        skippedItems.push({
          itemId: `flush_page_${pageGuard}`,
          reason: chunkErr instanceof Error ? chunkErr.message : String(chunkErr),
        });
        pendingRows = [];
        pendingItemCount = 0;
      }
      console.log(
        `Đang cập nhật trang ${pageGuard}... xong — itemsInPage=${allIds.length}, totalItems=${itemCount}, totalRows=${rowCount}`
      );

      hasMore = page.hasMore;
      offset = page.nextOffset;
      if (hasMore) await sleep(PRODUCT_SYNC_CHUNK_PAUSE_MS);
    } catch (pageErr: unknown) {
      const reason = pageErr instanceof Error ? pageErr.message : String(pageErr);
      skippedItems.push({ itemId: `page_${pageGuard}`, reason });
      console.error(`[Shopee Warehouse Sync] Dừng tại trang ${pageGuard}: ${reason}`);
      try {
        flushPending();
      } catch (chunkErr: unknown) {
        console.error("Lỗi khi lưu DB chunk:", chunkErr);
      }
      break;
    }
  }

  try {
    flushPending();
  } catch (chunkErr: unknown) {
    console.error("Lỗi khi lưu DB chunk:", chunkErr);
  }

  const verified = (await loadProducts()).filter(
    (p: any) => p.shopeeItemId || (Array.isArray(p.channels) && p.channels.includes("shopee"))
  ).length;
  console.log(
    `[Shopee Warehouse Sync] HOAN TAT ${itemCount} item -> ${rowCount} dong (${variantItemCount} co phan loai), verifiedInDb=${verified}, ${Date.now() - startedAt}ms, pages=${pageGuard}`,
  );

  return {
    stats: {
      itemCount,
      rowCount,
      variantItemCount,
      skippedCount: skippedItems.length,
      pageCount: pageGuard,
    },
    skippedItems,
  };
}

async function clearExistingShopeeWarehouseProducts(): Promise<void> {
  try {
    const existing = await loadProducts();
    const kept = existing.filter(
      (p: any) => !p.shopeeItemId && !(Array.isArray(p.channels) && p.channels.includes("shopee"))
    );
    await saveProducts(kept);
    console.log(
      `[Shopee Warehouse Sync] Reset: giữ ${kept.length} SP không-Shopee, xóa tạm SP Shopee cũ trước khi pull`
    );
  } catch (error: unknown) {
    console.error("[Shopee Warehouse Sync] Reset failed:", error);
    throw error instanceof Error ? error : new Error(String(error));
  }
}

async function syncShopeeWarehouseSinglePage(
  shopId: string,
  accessToken: string,
  offset: number,
): Promise<{
  currentOffset: number;
  nextOffset: number;
  hasMore: boolean;
  pageIndex: number;
  pageStats: {
    itemsInPage: number;
    rowsInPage: number;
    variantItemCount: number;
    skippedCount: number;
    savedCount: number;
  };
  skippedItems: { itemId: string; reason: string }[];
  productCount: number;
}> {
  const page = await fetchShopeeItemListPage(shopId, accessToken, offset);
  if (page.itemIds.length === 0) {
    const productCount = (await loadProducts()).filter(
      (p: any) => p.shopeeItemId || (Array.isArray(p.channels) && p.channels.includes("shopee"))
    ).length;
    return {
      currentOffset: offset,
      nextOffset: page.nextOffset,
      hasMore: false,
      pageIndex: page.pageIndex,
      pageStats: {
        itemsInPage: 0,
        rowsInPage: 0,
        variantItemCount: 0,
        skippedCount: 0,
        savedCount: 0,
      },
      skippedItems: [],
      productCount,
    };
  }

  const allIds = asShopeeArray(page.itemIds).filter((n) => Number.isFinite(Number(n)) && Number(n) > 0);
  const pageRows: any[] = [];
  let variantItemCount = 0;
  const skippedItems: { itemId: string; reason: string }[] = [];

  for (let batchStart = 0; batchStart < allIds.length; batchStart += CHANNEL_FETCH_MICRO_BATCH) {
    const idBatch = allIds.slice(batchStart, batchStart + CHANNEL_FETCH_MICRO_BATCH);
    const baseItems = await fetchShopeeBaseItemsByIds(shopId, accessToken, idBatch);
    await yieldEventLoop(CHANNEL_FETCH_YIELD_MS);

    for (const item of asShopeeArray(baseItems)) {
      if (!item || item.item_id == null) continue;
      try {
        const r = await syncShopeeItemToWarehouseRows(shopId, accessToken, item);
        if (r.error && (!r.rows || r.rows.length === 0)) {
          skippedItems.push({ itemId: String(item.item_id), reason: r.error });
        } else {
          if (r.modelCount > 0) variantItemCount++;
          pageRows.push(...asShopeeArray(r.rows));
        }
      } catch (itemErr: unknown) {
        const reason = itemErr instanceof Error ? itemErr.message : String(itemErr);
        console.error(`[Shopee Warehouse Sync] page offset=${offset} item_id=${item?.item_id}: ${reason}`);
        skippedItems.push({ itemId: String(item?.item_id ?? "?"), reason });
      }
      await yieldEventLoop(CHANNEL_FETCH_YIELD_MS);
    }
  }

  const dedupedRows = dedupeShopeeParentVariantRows(pageRows);
  const savedCount = dedupedRows.length > 0 ? await mergeWarehouseProductsBatch(dedupedRows) : 0;
  const productCount = (await loadProducts()).filter(
    (p: any) => p.shopeeItemId || (Array.isArray(p.channels) && p.channels.includes("shopee"))
  ).length;

  console.log(
    `[Shopee Warehouse Sync] Page ${page.pageIndex + 1} offset=${offset}: items=${allIds.length}, rows=${dedupedRows.length}, saved=${savedCount}, totalShopee=${productCount}`
  );

  return {
    currentOffset: offset,
    nextOffset: page.nextOffset,
    hasMore: page.hasMore,
    pageIndex: page.pageIndex,
    pageStats: {
      itemsInPage: allIds.length,
      rowsInPage: dedupedRows.length,
      variantItemCount,
      skippedCount: skippedItems.length,
      savedCount,
    },
    skippedItems,
    productCount,
  };
}

async function fetchAllShopeeItemIds(shopId: string, accessToken: string): Promise<number[]> {
  const allItemIds: number[] = [];
  let offset = 0;
  let hasNext = true;
  let pageGuard = 0;
  while (hasNext && pageGuard < 100) {
    const listResult = await shopeeGetItemList(shopId, accessToken, offset);
    if (listResult.error) {
      throw new Error(formatShopeeApiError(listResult) || `${listResult.error}: ${listResult.message || ""}`);
    }
    const items = listResult.response?.item || [];
    allItemIds.push(...items.map((it: any) => it.item_id));
    hasNext = !!listResult.response?.has_next_page && items.length > 0;
    offset = listResult.response?.next_offset ?? offset + items.length;
    pageGuard++;
    if (hasNext) await sleep(SHOPEE_PRODUCT_API_DELAY_MS);
  }
  return allItemIds;
}

async function fetchShopeeBaseItemsByIds(shopId: string, accessToken: string, itemIds: number[]): Promise<any[]> {
  const allItems: any[] = [];
  const ids = asShopeeArray(itemIds).filter((n) => Number.isFinite(Number(n)) && Number(n) > 0);
  const batches: number[][] = [];
  for (let i = 0; i < ids.length; i += SHOPEE_PRODUCT_BASE_INFO_BATCH) {
    batches.push(ids.slice(i, i + SHOPEE_PRODUCT_BASE_INFO_BATCH));
  }

  // for...of tuần tự — await bắt được lỗi từng batch
  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    try {
      const baseInfoResult = await shopeeGetItemBaseInfo(shopId, accessToken, batch);
      if (baseInfoResult?.error) {
        const errMsg =
          formatShopeeApiError(baseInfoResult) ||
          `${baseInfoResult.error}: ${baseInfoResult.message || ""}`;
        console.error(`[Shopee Sync] get_item_base_info batch ${batchIdx}: ${errMsg}`);
      } else {
        allItems.push(...asShopeeArray(baseInfoResult?.response?.item_list).filter((it) => it != null));
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Shopee Sync] get_item_base_info batch ${batchIdx} exception: ${msg}`);
    }
    if (batchIdx < batches.length - 1) {
      await sleep(SHOPEE_PRODUCT_API_DELAY_MS);
    }
  }

  return allItems;
}

async function fetchShopeeListingRowsFromApi(shopId: string, accessToken: string) {
  const result = await pullShopeeWarehouseAllPages(shopId, accessToken);
  return {
    rows: (await loadProducts()).filter((p: any) => p.shopeeItemId || p.channels?.includes("shopee")),
    stats: result.stats,
    skippedItems: result.skippedItems,
  };
}

async function runFullShopeeWarehouseSync(shopId: string, accessToken: string) {
  try {
    const { stats, skippedItems } = await pullShopeeWarehouseAllPages(shopId, accessToken);
    const allProducts = await loadProducts();
    const productCount = allProducts.filter((p: any) => p.shopeeItemId || p.channels?.includes("shopee")).length;
    const variantSkuCount = allProducts.reduce(
      (n: number, p: any) => n + getProductChildrenList(p).length,
      0
    );
    return { shopId, stats: { ...stats, variantSkuCount }, skippedItems, productCount };
  } catch (err) {
    const { message, details } = extractHttpClientError(err);
    console.error("[Shopee Product Sync] runFullShopeeWarehouseSync failed:", message, details);
    throw new Error(message);
  }
}

async function syncStockFromShopee(shopId: string, accessToken: string) {
  const products = await loadProducts();
  const localShopee = products.filter((p) => p.shopeeItemId);
  const itemIds = [
    ...new Set(
      localShopee
        .map((p) => Number(p.shopeeItemId))
        .filter((n) => Number.isFinite(n) && n > 0)
    ),
  ];

  if (itemIds.length === 0) {
    return { updated: 0, compared: 0, products };
  }

  const stockBySku = new Map<string, number>();
  const allItems = await fetchShopeeBaseItemsByIds(shopId, accessToken, itemIds);

  await runInShopeeBatches(allItems, async (item) => {
    const r = await syncShopeeItemToWarehouseRows(shopId, accessToken, item);
    for (const row of flattenProductsForStockSync(r.rows)) {
      const sku = String(row.sku || "").trim();
      if (sku) stockBySku.set(sku, Math.max(0, Number(row.stock) || 0));
    }
  });

  let updated = 0;
  let compared = 0;
  const next = products.map((p) => {
    const children = getProductChildrenList(p);
    if (children.length > 0) {
      let childChanged = false;
      const nextChildren = children.map((c: any) => {
        const sku = String(c.sku || "").trim();
        if (!sku || !stockBySku.has(sku)) return c;
        compared++;
        const newStock = stockBySku.get(sku)!;
        if (Number(c.stock) === newStock) return c;
        updated++;
        childChanged = true;
        return { ...c, stock: newStock, lastSynced: new Date().toISOString() };
      });
      if (!childChanged) return p;
      const totalStock = nextChildren.reduce((s: number, c: any) => s + (Number(c.stock) || 0), 0);
      return { ...p, children: nextChildren, stock: totalStock, lastSynced: new Date().toISOString() };
    }

    const sku = String(p.sku || "").trim();
    if (!sku || !p.shopeeItemId || !stockBySku.has(sku)) return p;
    compared++;
    const newStock = stockBySku.get(sku)!;
    if (Number(p.stock) === newStock) return p;
    updated++;
    return mergeProductPatch(p, { stock: newStock });
  });

  await saveProducts(next);
  console.log(`[Sync Stock] Shopee shop_id=${shopId}: ${compared} SKU so sánh, ${updated} SKU cập nhật`);
  return { updated, compared, products: next };
}

async function fetchShopeeItemVariants(
  shopId: string,
  accessToken: string,
  itemId: number
): Promise<{ item: any; variantProducts: any[]; error?: string; modelCount: number }> {
  const baseInfoResult = await shopeeGetItemBaseInfo(shopId, accessToken, [itemId]);
  if (baseInfoResult.error) {
    return { item: null, variantProducts: [], modelCount: 0, error: `${baseInfoResult.error}: ${baseInfoResult.message}` };
  }
  const item = baseInfoResult.response?.item_list?.[0];
  if (!item) {
    return { item: null, variantProducts: [], modelCount: 0, error: "item_not_found" };
  }

  const { rows, modelCount, error } = await syncShopeeItemToWarehouseRows(shopId, accessToken, item, { strict: true });
  if (error && rows.length === 0) {
    return { item, variantProducts: [], modelCount: 0, error };
  }
  return { item, variantProducts: rows, modelCount, error };
}

function mergeShopeeRowPreservingLocal(existing: any, incoming: any): any {
  if (!existing) return incoming;
  return {
    ...existing,
    ...incoming,
    importPrice: existing.importPrice ?? incoming.importPrice,
    wholesalePrice: existing.wholesalePrice ?? incoming.wholesalePrice,
    weight: existing.weight ?? incoming.weight,
    unit: existing.unit ?? incoming.unit,
    description: existing.description || incoming.description,
  };
}

function replaceProductsForShopeeItem(products: any[], itemId: string, variantProducts: any[]): any[] {
  const key = String(itemId);
  const byId = new Map<string, any>();
  for (const p of products) {
    byId.set(p.id, p);
    for (const c of getProductChildrenList(p)) byId.set(c.id, c);
  }
  const without = products.filter((p: any) => {
    const pItemId = p.shopeeItemId || String(p.id || "").match(/^shopee-item-(\d+)/)?.[1];
    return String(pItemId) !== key;
  });

  const mergedParents = variantProducts.map((row) => {
    const prev = byId.get(row.id);
    const incomingChildren = getProductChildrenList(row);
    if (incomingChildren.length > 0) {
      const mergedChildren = incomingChildren.map((child: any) =>
        mergeShopeeRowPreservingLocal(byId.get(child.id), child)
      );
      return mergeShopeeRowPreservingLocal(prev, { ...row, children: mergedChildren });
    }
    return mergeShopeeRowPreservingLocal(prev, row);
  });
  return [...mergedParents, ...without];
}

function dedupeShopeeParentVariantRows(products: any[]): any[] {
  // Parent-Child: mỗi item_id chỉ giữ 1 Parent (có children). Loại flat child cũ nếu còn sót.
  const byItem = new Map<string, any>();
  const others: any[] = [];

  for (const p of asShopeeArray(products)) {
    if (!p || typeof p !== "object") continue;
    const itemId = p?.shopeeItemId || String(p?.id || "").match(/^shopee-item-(\d+)/)?.[1];
    if (!itemId) {
      others.push(p);
      continue;
    }
    const key = String(itemId);
    const isParent = getProductChildrenList(p).length > 0 || /^shopee-item-\d+$/.test(String(p?.id || ""));
    const isFlatChild = !!p?.shopeeModelId || String(p?.id || "").includes("-model-");

    if (isFlatChild && !isParent) continue;

    const prev = byItem.get(key);
    if (!prev) {
      byItem.set(key, p);
      continue;
    }
    const prevHasChildren = getProductChildrenList(prev).length > 0;
    const nextHasChildren = getProductChildrenList(p).length > 0;
    if (nextHasChildren && !prevHasChildren) byItem.set(key, p);
    else if (isParent && !/^shopee-item-\d+$/.test(String(prev?.id || ""))) byItem.set(key, p);
  }

  return [...byItem.values(), ...others];
}

// v2.logistics.get_shipping_parameter — tells us whether this order ships via
// "pickup" (Shopee courier picks up from seller's address), "dropoff" (seller
// drops the parcel at a branch) or "non_integrated" (3rd-party carrier, manual
// tracking number), plus the concrete address/time-slot/branch options.
const SHOPEE_LOGISTICS_TIMEOUT_MS = 20_000;
const SHIP_ORDER_OPERATION_TIMEOUT_MS = 45_000;

async function withOperationTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout sau ${ms / 1000} giây.`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchShopeeLogisticsJson(
  url: string,
  init: RequestInit,
  context: string,
): Promise<{ response: Response; json: any }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SHOPEE_LOGISTICS_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const raw = await response.text();
    let json: any;
    try {
      json = raw ? JSON.parse(raw) : {};
    } catch {
      throw new Error(
        `Shopee ${context} trả về dữ liệu không phải JSON (HTTP ${response.status}): ${raw.slice(0, 300)}`,
      );
    }
    return { response, json };
  } catch (error: any) {
    if (error?.name === "AbortError") {
      throw new Error(`Shopee ${context} timeout sau ${SHOPEE_LOGISTICS_TIMEOUT_MS / 1000} giây.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function shopeeGetShippingParameter(shopId: string, accessToken: string, orderSn: string, packageNumber?: string) {
  const apiPath = "/api/v2/logistics/get_shipping_parameter";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);

  const params = new URLSearchParams({
    partner_id: SHOPEE_PARTNER_ID,
    timestamp: String(timestamp),
    access_token: accessToken,
    shop_id: shopId,
    sign,
    order_sn: orderSn,
  });
  if (packageNumber) params.set("package_number", packageNumber);

  const url = `${SHOPEE_HOST}${apiPath}?${params.toString()}`;
  const { response, json } = await fetchShopeeLogisticsJson(url, {}, "get_shipping_parameter");
  console.log(`[Shopee API] GET ${apiPath} (order_sn=${orderSn}) -> HTTP ${response.status}:`, JSON.stringify(json));
  return json;
}

// v2.logistics.get_address_list — danh sách địa chỉ kho/lấy hàng mới nhất của shop.
async function shopeeGetAddressList(shopId: string, accessToken: string) {
  const apiPath = "/api/v2/logistics/get_address_list";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);
  const params = new URLSearchParams({
    partner_id: SHOPEE_PARTNER_ID,
    timestamp: String(timestamp),
    access_token: accessToken,
    shop_id: shopId,
    sign,
  });
  const url = `${SHOPEE_HOST}${apiPath}?${params.toString()}`;
  const { response, json } = await fetchShopeeLogisticsJson(url, {}, "get_address_list");
  console.log(`[Shopee API] GET ${apiPath} (shop_id=${shopId}) -> HTTP ${response.status}:`, JSON.stringify(json));
  return json;
}

function isShopeePickupAddressActive(addr: any): boolean {
  if (!addr || addr.address_id === undefined || addr.address_id === null) return false;
  const status = String(addr.address_status || addr.status || "").toLowerCase();
  if (status && /disabled|invalid|deleted|inactive/.test(status)) return false;
  const flags = Array.isArray(addr.address_flag) ? addr.address_flag.map(String) : [];
  if (flags.length > 0 && !flags.some((f) => /pickup|default|warehouse|return/.test(f.toLowerCase()))) {
    return false;
  }
  return true;
}

/** Chọn address_id + pickup_time_id hợp lệ — ưu tiên địa chỉ kho mới từ get_address_list. */
function resolvePickupShipmentFromParams(
  paramPickup: any,
  shopAddressList: any[],
): { address_id: number | string; pickup_time_id: string | number } | null {
  const paramAddresses = Array.isArray(paramPickup?.address_list) ? paramPickup.address_list : [];
  const activeShopIds = new Set(
    shopAddressList.filter(isShopeePickupAddressActive).map((a) => a.address_id),
  );

  const tryAddress = (addr: any): { address_id: number | string; pickup_time_id: string | number } | null => {
    if (addr?.address_id === undefined || addr?.address_id === null) return null;
    if (activeShopIds.size > 0 && !activeShopIds.has(addr.address_id)) return null;
    const slots = Array.isArray(addr.time_slot_list) ? addr.time_slot_list : [];
    const slot = slots.find(
      (s: any) => s?.pickup_time_id !== undefined && s?.pickup_time_id !== null && s?.pickup_time_id !== "",
    ) || slots[0];
    if (!slot || slot.pickup_time_id === undefined || slot.pickup_time_id === null) {
      // Shopee cho phép pickup_time_id rỗng với một số kênh — vẫn gửi address_id.
      return { address_id: addr.address_id, pickup_time_id: slot?.pickup_time_id ?? "" };
    }
    return { address_id: addr.address_id, pickup_time_id: slot.pickup_time_id };
  };

  // 1) Ưu tiên địa chỉ pickup mặc định từ get_address_list, khớp với get_shipping_parameter.
  for (const shopAddr of shopAddressList) {
    if (!isShopeePickupAddressActive(shopAddr)) continue;
    const paramAddr = paramAddresses.find((p) => p.address_id === shopAddr.address_id);
    if (paramAddr) {
      const picked = tryAddress(paramAddr);
      if (picked) return picked;
    }
  }

  // 2) Thử lần lượt mọi address trong get_shipping_parameter (không chỉ [0]).
  for (const paramAddr of paramAddresses) {
    const picked = tryAddress(paramAddr);
    if (picked) return picked;
  }

  // 3) Fallback: address_id từ get_address_list + slot rỗng (Shopee tự xếp lịch).
  const fallbackShop = shopAddressList.find(isShopeePickupAddressActive);
  if (fallbackShop) {
    return { address_id: fallbackShop.address_id, pickup_time_id: "" };
  }

  return null;
}

// v2.logistics.ship_order — arranges the actual shipment (pickup/dropoff/non_integrated)
// so the order moves to "Chờ lấy hàng" (LOGISTICS_REQUEST_CREATED) on Shopee.
//
// IMPORTANT: `package_number` is INTENTIONALLY never accepted/sent by this
// function. Shopee hard-rejects ship_order with "Please don't request with
// package_number for this unsplit order" for the vast majority of normal
// (unsplit) orders, and there is no reliable local heuristic to prove an
// order is genuinely split. Per explicit product decision, this project only
// ships normal/unsplit orders — package_number must NEVER appear in this body.
async function shopeeShipOrder(shopId: string, accessToken: string, orderSn: string, shipmentBody: Record<string, any>) {
  const apiPath = "/api/v2/logistics/ship_order";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);
  const url = `${SHOPEE_HOST}${apiPath}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&access_token=${accessToken}&shop_id=${shopId}&sign=${sign}`;

  const body: Record<string, any> = { order_sn: orderSn, ...shipmentBody };
  delete body.package_number; // absolute guard — never send this key, no matter what shipmentBody contains

  const { response, json } = await fetchShopeeLogisticsJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, "ship_order");
  console.log(`[Shopee API] POST ${apiPath} (order_sn=${orderSn}) body=${JSON.stringify(body)} -> HTTP ${response.status}:`, JSON.stringify(json));
  return json;
}

type ShipMethod = "pickup" | "dropoff";

// Full "ship this order" flow for a REAL Shopee shop: call get_shipping_parameter
// to discover the concrete address/time-slot (pickup) or branch (dropoff) options,
// honor the method the seller explicitly picked in the "Xác nhận đơn hàng" modal,
// then call ship_order. Fails clearly if Shopee doesn't support the chosen method
// for this specific order's logistics channel (info_needed doesn't list it).
async function shipShopeeOrderReal(order: any, method: ShipMethod): Promise<{ success: boolean; error?: string; message?: string; mode?: string; shopId?: string }> {
  try {
  const shopCheck = validateOrderShopForShipment(order);
  if (!shopCheck.ok) {
    return { success: false, error: shopCheck.error, message: shopCheck.message };
  }
  const shopId = shopCheck.shopId;
  if (!shopId) {
    return { success: false, error: "missing_shop_id", message: "Đơn hàng thiếu shop_id, không xác định được shop Shopee để gọi API." };
  }

  const accessToken = await getValidShopeeAccessToken(shopId);
  if (!accessToken) {
    return { success: false, error: "no_valid_access_token", message: `Chưa có access_token hợp lệ cho shop_id=${shopId}. Cần ủy quyền lại qua /api/shopee/callback.` };
  }

  // Deliberately called WITHOUT package_number — see shopeeShipOrder's comment.
  const paramResult = await shopeeGetShippingParameter(shopId, accessToken, order.orderSn);
  console.log(`D\u1EEE LI\u1EC6U SHOPEE TR\u1EA2 V\u1EC0 (get_shipping_parameter) - \u0111\u01A1n ${order.orderSn}:`, JSON.stringify(paramResult));
  if (paramResult.error) {
    console.error(`[Shopee L\u1ED6I] get_shipping_parameter th\u1EA5t b\u1EA1i cho \u0111\u01A1n ${order.orderSn} -> error="${paramResult.error}" message="${paramResult.message}"`);
    return { success: false, error: paramResult.error, message: paramResult.message };
  }

  const infoNeeded = paramResult.response?.info_needed || {};
  let shipmentBody: Record<string, any> = {};

  if (method === "dropoff") {
    if (!Object.prototype.hasOwnProperty.call(infoNeeded, "dropoff")) {
      console.error(`[Shopee L\u1ED6I] \u0110\u01A1n ${order.orderSn} kh\xF4ng h\u1ED7 tr\u1EE3 dropoff. info_needed=${JSON.stringify(infoNeeded)}`);
      return { success: false, error: "dropoff_not_supported", message: "Đơn vị vận chuyển của đơn này KHÔNG hỗ trợ hình thức \"Tự mang hàng ra bưu cục\". Vui lòng chọn \"Lấy hàng\" (pickup) thay thế." };
    }
    const dropoffRequirements = Array.isArray(infoNeeded.dropoff) ? infoNeeded.dropoff : [];
    const branch = paramResult.response?.dropoff?.branch_list?.find(
      (item: any) => item?.branch_id !== undefined && item?.branch_id !== null,
    );
    if (dropoffRequirements.includes("branch_id") && !branch) {
      console.error(`[Shopee LỖI] Đơn ${order.orderSn} bắt buộc branch_id nhưng Shopee không trả về branch hợp lệ. dropoff=${JSON.stringify(paramResult.response?.dropoff)}`);
      return { success: false, error: "no_dropoff_branch_available", message: "Shopee yêu cầu branch_id nhưng không trả về bưu cục dropoff khả dụng cho đơn này." };
    }
    shipmentBody = { dropoff: branch ? { branch_id: branch.branch_id } : {} };
  } else {
    if (!Object.prototype.hasOwnProperty.call(infoNeeded, "pickup")) {
      console.error(`[Shopee L\u1ED6I] \u0110\u01A1n ${order.orderSn} kh\xF4ng h\u1ED7 tr\u1EE3 pickup. info_needed=${JSON.stringify(infoNeeded)}`);
      return { success: false, error: "pickup_not_supported", message: "Đơn vị vận chuyển của đơn này KHÔNG hỗ trợ hình thức \"Lấy hàng\". Vui lòng chọn \"Tự mang hàng ra bưu cục\" (dropoff) thay thế." };
    }
    // Lấy danh sách địa chỉ kho mới nhất + khớp với get_shipping_parameter (tránh address_id cũ).
    const addressListResult = await shopeeGetAddressList(shopId, accessToken);
    const shopAddressList =
      addressListResult.response?.address_list ||
      addressListResult.address_list ||
      [];
    if (addressListResult.error) {
      console.warn(
        `[Shopee Ship] get_address_list cảnh báo đơn ${order.orderSn}: ${addressListResult.error} — fallback get_shipping_parameter`,
      );
    }

    const pickupChoice = resolvePickupShipmentFromParams(paramResult.response?.pickup, shopAddressList);
    if (!pickupChoice) {
      console.error(
        `[Shopee LỖI] Đơn ${order.orderSn} không có address/time_slot pickup khả dụng. pickup=${JSON.stringify(paramResult.response?.pickup)} shopAddresses=${JSON.stringify(shopAddressList)}`,
      );
      return {
        success: false,
        error: "no_pickup_slot_available",
        message: "Shopee không trả về địa chỉ kho/lịch hẹn lấy hàng (pickup) khả dụng. Vui lòng cập nhật địa chỉ lấy hàng trên Shopee Seller Centre rồi thử lại.",
      };
    }
    shipmentBody = {
      pickup: {
        address_id: pickupChoice.address_id,
        pickup_time_id: pickupChoice.pickup_time_id,
      },
    };
    console.log(
      `[Shopee Ship] Đơn ${order.orderSn} pickup address_id=${pickupChoice.address_id} pickup_time_id=${pickupChoice.pickup_time_id}`,
    );
  }

  const shipResult = await shopeeShipOrder(shopId, accessToken, order.orderSn, shipmentBody);
  console.log(`D\u1EEE LI\u1EC6U SHOPEE TR\u1EA2 V\u1EC0 (ship_order) - \u0111\u01A1n ${order.orderSn}:`, JSON.stringify(shipResult));
  if (shipResult.error) {
    console.error(`[Shopee L\u1ED6I] ship_order th\u1EA5t b\u1EA1i cho \u0111\u01A1n ${order.orderSn} -> error="${shipResult.error}" message="${shipResult.message}" request_id="${shipResult.request_id || ""}"`);
    return { success: false, error: shipResult.error, message: shipResult.message, mode: method, shopId };
  }
  return { success: true, mode: method, shopId };
  } catch (error: any) {
    console.error(`[Shopee LỖI] shipShopeeOrderReal exception đơn ${order?.orderSn}:`, error?.stack || error);
    return {
      success: false,
      error: "internal_server_error",
      message: "Lỗi nội bộ server: " + (error?.message || String(error)),
    };
  }
}

// TikTok Shop / off-platform (manual) orders: no real Partner API is wired up
// in this project yet (only Shopee has a Live App configured in .env), so we
// apply the same pickup/dropoff decision locally and generate a tracking
// number consistent with the seller's choice, instead of silently no-oping.
function arrangeShipmentLocal(order: any, method: ShipMethod): { success: boolean; mode: string; trackingNumber: string } {
  const prefix = order.channel === "tiktok" ? "TTS" : "DIRECT";
  const trackingNumber = order.trackingNumber || `${prefix}-${method === "dropoff" ? "DROPOFF" : "PICKUP"}-${Math.floor(10000000 + Math.random() * 90000000)}`;
  return { success: true, mode: method, trackingNumber };
}

// Single entry point used by both the single-order and bulk ship routes.
async function arrangeShipment(order: any, method: ShipMethod): Promise<{ success: boolean; error?: string; message?: string; mode?: string; trackingNumber?: string; shopId?: string }> {
  if (order.channel === "shopee") {
    return shipShopeeOrderReal(order, method);
  }
  return arrangeShipmentLocal(order, method);
}

// Seller uses a regular A4/A5 office printer (thermal-label printing is OFF in
// Shopee Seller Centre) — NORMAL_AIR_WAYBILL renders the standard-size PDF
// label instead of the thermal-printer-sized THERMAL_AIR_WAYBILL. Single
// source of truth so create/poll/download always agree on the same type.
const SHOPEE_SHIPPING_DOCUMENT_TYPE = "NORMAL_AIR_WAYBILL";

// v2.logistics.get_tracking_number — for INTEGRATED channels, ship_order does
// not return the tracking_number synchronously (the 3PL assigns it a few
// seconds/minutes later). create_shipping_document REQUIRES a real
// tracking_number for these channels — omitting it is exactly what causes
// Shopee's "logistics.tracking_number_invalid" even for a perfectly valid,
// already-shipped order. This fetches the authoritative tracking_number.
async function shopeeGetTrackingNumber(shopId: string, accessToken: string, orderSn: string, packageNumber?: string) {
  const apiPath = "/api/v2/logistics/get_tracking_number";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);
  const params = new URLSearchParams({
    partner_id: SHOPEE_PARTNER_ID,
    timestamp: String(timestamp),
    access_token: accessToken,
    shop_id: shopId,
    sign,
    order_sn: orderSn,
    response_optional_fields: "first_mile_tracking_number,last_mile_tracking_number",
  });
  if (packageNumber) params.set("package_number", packageNumber);

  const url = `${SHOPEE_HOST}${apiPath}?${params.toString()}`;
  const res = await fetchWithTimeout(url);
  const json: any = await res.json();
  console.log(`[Shopee API] GET ${apiPath} (order_sn=${orderSn}) -> HTTP ${res.status}:`, JSON.stringify(json));
  return json;
}

// v2.logistics.create_shipping_document — kicks off async AWB/label generation for up to 50 orders.
async function shopeeCreateShippingDocument(shopId: string, accessToken: string, orderList: { order_sn: string; package_number?: string; tracking_number?: string }[]) {
  const apiPath = "/api/v2/logistics/create_shipping_document";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);
  const url = `${SHOPEE_HOST}${apiPath}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&access_token=${accessToken}&shop_id=${shopId}&sign=${sign}`;

  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ order_list: orderList, shipping_document_type: SHOPEE_SHIPPING_DOCUMENT_TYPE }),
  });
  const json: any = await res.json();
  console.log(`[Shopee API] POST ${apiPath} (${orderList.length} orders) -> HTTP ${res.status}:`, JSON.stringify(json));
  return json;
}

// v2.logistics.get_shipping_document_result — poll until status is READY/FAILED.
async function shopeeGetShippingDocumentResult(shopId: string, accessToken: string, orderList: { order_sn: string; package_number?: string }[]) {
  const apiPath = "/api/v2/logistics/get_shipping_document_result";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);
  const url = `${SHOPEE_HOST}${apiPath}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&access_token=${accessToken}&shop_id=${shopId}&sign=${sign}`;

  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ order_list: orderList, shipping_document_type: SHOPEE_SHIPPING_DOCUMENT_TYPE }),
  });
  const json: any = await res.json();
  console.log(`[Shopee API] POST ${apiPath} -> HTTP ${res.status}:`, JSON.stringify(json));
  return json;
}

// v2.logistics.download_shipping_document — response body IS the raw file
// (PDF for most channels, sometimes ZIP/HTML). Returns the raw bytes + content-type,
// or throws/returns an error object if Shopee answered with a JSON error instead.
async function shopeeDownloadShippingDocument(shopId: string, accessToken: string, orderList: { order_sn: string; package_number?: string }[]) {
  const apiPath = "/api/v2/logistics/download_shipping_document";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);
  const url = `${SHOPEE_HOST}${apiPath}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&access_token=${accessToken}&shop_id=${shopId}&sign=${sign}`;

  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ order_list: orderList, shipping_document_type: SHOPEE_SHIPPING_DOCUMENT_TYPE }),
  }, 30_000);

  const contentType = res.headers.get("content-type") || "";
  console.log(`[Shopee API] POST ${apiPath} (${orderList.length} orders) -> HTTP ${res.status}, content-type=${contentType}`);

  if (contentType.includes("application/json")) {
    const json: any = await res.json();
    console.log(`[Shopee API] ${apiPath} tr\u1EA3 v\u1EC1 l\u1ED7i JSON (kh\xF4ng c\xF3 file):`, JSON.stringify(json));
    return { error: json.error || "download_failed", message: json.message || "Shopee kh\xF4ng tr\u1EA3 v\u1EC1 file v\u1EAD n \u0111\u01A1n." };
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, contentType: contentType || "application/pdf" };
}

// Normalize one line item from Shopee order item_list (includes variation/model fields).
function extractShopeeOrderModelName(it: any): string | undefined {
  const directCandidates = [
    it.model_name,
    it.variation_name,
    it.model_display_name,
    it.item_model_name,
    it.sku_model_name,
  ];
  for (const c of directCandidates) {
    const s = String(c || "").trim();
    if (s) return s;
  }

  const tierParts: string[] = [];
  const tierSources = [
    it.model_tier_variation,
    it.tier_variation,
    it.standardise_tier_variation,
  ];
  for (const src of tierSources) {
    if (!Array.isArray(src)) continue;
    for (const tier of src) {
      if (typeof tier === "string" && tier.trim()) tierParts.push(tier.trim());
      else if (tier?.option) tierParts.push(String(tier.option).trim());
      else if (tier?.variation_option_name) tierParts.push(String(tier.variation_option_name).trim());
    }
  }
  if (tierParts.length > 0) return tierParts.join(" / ");

  if (Array.isArray(it.variation_list)) {
    const parts = it.variation_list
      .map((v: any) => String(v?.variation_name || v?.option || v?.name || "").trim())
      .filter(Boolean);
    if (parts.length > 0) return parts.join(" / ");
  }

  return undefined;
}

function extractShopeeOrderModelId(it: any): string {
  const candidates = [it.model_id, it.variation_id, it.modelId, it.variationId];
  for (const raw of candidates) {
    if (raw != null && raw !== "" && Number(raw) !== 0) {
      return String(raw);
    }
  }
  return "0";
}

function extractShopeeOrderModelSku(it: any): string | undefined {
  const candidates = [
    it.model_sku,
    it.variation_sku,
    it.item_sku,
    it.sku,
    it.modelSku,
    it.variationSku,
  ];
  for (const raw of candidates) {
    const s = String(raw || "").trim();
    if (s) return s;
  }
  return undefined;
}

const SHOPEE_ORDER_STATUS_MAP: Record<string, string> = {
  UNPAID: "pending_confirm",
  READY_TO_SHIP: "unprocessed",
  PROCESSED: "processed",
  RETRY_SHIP: "unprocessed",
  SHIPPED: "shipping",
  TO_CONFIRM_RECEIVE: "shipping",
  IN_CANCEL: "cancelled",
  CANCELLED: "cancelled",
  TO_RETURN: "return_pending",
  COMPLETED: "completed",
};

function extractShopeeWithholdingCitTax(source: any): number {
  const income = source?.order_income || source?.orderIncome || source;
  const raw = income?.withholding_cit_tax ?? source?.withholding_cit_tax ?? source?.withholdingCitTax;
  return Math.max(0, Number(raw) || 0);
}

function extractShopeeEscrowAmount(source: any): number | undefined {
  const income = source?.order_income || source?.orderIncome || source;
  const raw = income?.escrow_amount ?? source?.escrow_amount ?? source?.escrowAmount;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function computeShopeeOrderRevenue(
  totalAmount: number,
  withholdingCitTax = 0,
  escrowAmount?: number,
): number {
  if (escrowAmount != null && Number.isFinite(escrowAmount) && escrowAmount > 0) {
    return Math.max(0, Math.round(escrowAmount));
  }
  const gross = Math.max(0, Number(totalAmount) || 0);
  const cit = Math.max(0, Number(withholdingCitTax) || 0);
  return Math.max(0, Math.round(gross * (1 - SHOPEE_NET_FEE_RATE) - cit));
}

function applyShopeeOrderFinanceFields(
  order: any,
  opts: { totalAmount?: number; withholdingCitTax?: number; escrowAmount?: number },
): void {
  const totalAmount = Number(opts.totalAmount ?? order.totalAmount ?? 0);
  const withholdingCitTax = Math.max(0, Number(opts.withholdingCitTax ?? order.withholdingCitTax ?? 0));
  const escrowAmount = opts.escrowAmount ?? order.escrowAmount;
  order.totalAmount = totalAmount;
  order.withholdingCitTax = withholdingCitTax;
  order.withholding_cit_tax = withholdingCitTax;
  if (escrowAmount != null && Number.isFinite(Number(escrowAmount))) {
    order.escrowAmount = Number(escrowAmount);
  }
  order.revenue = computeShopeeOrderRevenue(totalAmount, withholdingCitTax, order.escrowAmount);
}

function shopeeItemCancelledQty(it: any): number {
  return Math.max(0, Number(it?.cancelled_qty ?? it?.cancelledQty) || 0);
}

function shopeeItemCancelRequestedQty(it: any): number {
  return Math.max(0, Number(it?.cancel_requested_qty ?? it?.cancelRequestedQty) || 0);
}

function shopeeItemPurchasedQty(it: any): number {
  return Math.max(0, Number(it?.model_quantity_purchased ?? it?.model_quantity ?? it?.quantity ?? 0));
}

function detectShopeePartialCancellation(rawOrder: any, activeItems: any[]): boolean {
  const rawStatus = String(rawOrder?.order_status || rawOrder?.status || "").toUpperCase();
  if (rawStatus === "CANCELLED") return false;
  const itemList = Array.isArray(rawOrder?.item_list) ? rawOrder.item_list : [];
  const cancelledUnits = itemList.reduce((sum: number, it: any) => sum + shopeeItemCancelledQty(it), 0);
  const purchasedUnits = itemList.reduce((sum: number, it: any) => sum + shopeeItemPurchasedQty(it), 0);
  if (cancelledUnits <= 0) return false;
  if (purchasedUnits > 0 && cancelledUnits >= purchasedUnits) return false;
  return activeItems.length > 0;
}

function applyShopeePartialCancelMeta(order: any, rawOrder: any, activeItems: any[]): void {
  const partialCancel = detectShopeePartialCancellation(rawOrder, activeItems);
  order.partialCancel = partialCancel;
  order.canPartialCancel = Boolean(rawOrder?.can_partial_cancel_order ?? order.canPartialCancel);
  if (partialCancel) {
    const recalcFromItems = activeItems.reduce(
      (sum: number, it: any) => sum + Math.max(0, Number(it.price) || 0) * Math.max(0, Number(it.quantity) || 0),
      0,
    );
    const shopeeTotal = Number(rawOrder?.total_amount ?? order.totalAmount ?? 0);
    if (shopeeTotal > 0) {
      order.totalAmount = shopeeTotal;
    } else if (recalcFromItems > 0) {
      order.totalAmount = Math.round(recalcFromItems);
    }
  }
}

async function enrichShopeeOrdersEscrowFinance(
  shopId: string,
  accessToken: string,
  orders: any[],
): Promise<void> {
  const targets = orders.filter((o) => o?.orderSn && o.status !== "cancelled");
  for (let i = 0; i < targets.length; i++) {
    const order = targets[i];
    try {
      const escrow = await shopeeGetEscrowDetail(shopId, accessToken, order.orderSn);
      if (escrow?.error) continue;
      const payload = escrow?.response ?? escrow;
      const withholdingCitTax = extractShopeeWithholdingCitTax(payload);
      const escrowAmount = extractShopeeEscrowAmount(payload);
      applyShopeeOrderFinanceFields(order, {
        totalAmount: order.totalAmount,
        withholdingCitTax,
        escrowAmount,
      });
    } catch (err) {
      console.warn(`[Shopee Finance] escrow ${order.orderSn} failed:`, err);
    }
    if (i < targets.length - 1) await sleep(300);
  }
}

function findLinkedProductIdForShopeeLine(
  listings: any[],
  shopId: string | undefined,
  productId: string,
  modelId?: string,
): string | undefined {
  const pid = String(productId || "").trim();
  if (!pid) return undefined;
  const mid = String(modelId || "0").trim() || "0";
  const hit = listings.find((row) => {
    if (String(row?.itemId || "") !== pid) return false;
    const rowMid = String(row?.modelId || "0").trim() || "0";
    if (rowMid !== mid && rowMid !== "0" && mid !== "0") return false;
    if (shopId && row?.shopId && String(row.shopId) !== String(shopId)) return false;
    return Boolean(row?.linkedProductId);
  });
  return hit?.linkedProductId ? String(hit.linkedProductId) : undefined;
}

async function restoreLocalStockForPartialCancel(
  shopId: string | undefined,
  existing: any | undefined,
  incoming: any,
): Promise<void> {
  if (!incoming?.partialCancel) return;
  const prevItems = Array.isArray(existing?.items) ? existing.items : [];
  const nextItems = Array.isArray(incoming?.items) ? incoming.items : [];
  if (nextItems.length === 0 && prevItems.length === 0) return;

  let listings: any[] = [];
  try {
    listings = await readChannelListingsDb();
  } catch {
    return;
  }

  let products: any[] = [];
  try {
    products = await loadProductsFromStore();
  } catch {
    return;
  }

  let changed = false;
  const restoreByProduct = new Map<string, number>();

  const resolveRestoreQty = (productId: string, modelId: string | undefined, nextCancelled: number): number => {
    const prev = prevItems.find(
      (p: any) => String(p.productId) === productId && String(p.modelId || "0") === String(modelId || "0"),
    );
    const prevCancelled = Math.max(0, Number(prev?.cancelledQty) || 0);
    return Math.max(0, nextCancelled - prevCancelled);
  };

  for (const item of nextItems) {
    const productId = String(item?.productId || "");
    const modelId = item?.modelId ? String(item.modelId) : undefined;
    const restoreQty = resolveRestoreQty(productId, modelId, Math.max(0, Number(item?.cancelledQty) || 0));
    if (restoreQty <= 0) continue;
    const linkedId =
      findLinkedProductIdForShopeeLine(listings, shopId, productId, modelId) ||
      findLinkedProductIdForShopeeLine(listings, shopId, productId, undefined);
    if (!linkedId) continue;
    restoreByProduct.set(linkedId, (restoreByProduct.get(linkedId) || 0) + restoreQty);
  }

  for (const prev of prevItems) {
    const stillActive = nextItems.some(
      (n: any) =>
        String(n.productId) === String(prev.productId) &&
        String(n.modelId || "0") === String(prev.modelId || "0"),
    );
    if (stillActive) continue;
    const prevActiveQty = Math.max(
      0,
      Number(prev.originalQuantity ?? prev.quantity) - Math.max(0, Number(prev.cancelledQty) || 0),
    );
    if (prevActiveQty <= 0) continue;
    const linkedId = findLinkedProductIdForShopeeLine(
      listings,
      shopId,
      String(prev.productId),
      prev.modelId ? String(prev.modelId) : undefined,
    );
    if (!linkedId) continue;
    restoreByProduct.set(linkedId, (restoreByProduct.get(linkedId) || 0) + prevActiveQty);
  }

  for (const [linkedId, restoreQty] of restoreByProduct) {
    const idx = products.findIndex((p) => String(p?.id) === linkedId);
    if (idx < 0) continue;
    products[idx] = applyBulkProductUpdate(products[idx], { stock: { mode: "increase", value: restoreQty } });
    changed = true;
    console.log(
      `[Shopee Partial Cancel] Hoàn ${restoreQty} tồn kho cho ${linkedId} (order ${incoming.orderSn}).`,
    );
  }

  if (changed) {
    try {
      await saveProductsToStoreAsync(products);
    } catch (err) {
      console.warn("[Shopee Partial Cancel] Lưu tồn kho thất bại:", err);
    }
  }
}

function mapShopeeOrderLineItem(it: any) {
  if (!it || typeof it !== "object") return null;
  try {
    const itemId = String(it?.item_id || "");
    const modelId = extractShopeeOrderModelId(it);
    const modelSku = extractShopeeOrderModelSku(it);
    const modelName = extractShopeeOrderModelName(it);
    const itemName = String(it?.item_name || "S\u1EA3n ph\u1EA9m Shopee").trim();
    const productTitle = modelName ? `${itemName} - ${modelName}` : itemName;
    const productImage =
      it?.image_info?.image_url ||
      it?.image_url ||
      it?.variation_image_url ||
      undefined;
    const purchasedQty = Math.max(1, shopeeItemPurchasedQty(it) || 1);
    const cancelledQty = shopeeItemCancelledQty(it);
    const cancelRequestedQty = shopeeItemCancelRequestedQty(it);
    const activeQty = Math.max(0, purchasedQty - cancelledQty);
    if (activeQty <= 0 && cancelledQty > 0) return null;

    return {
      productId: itemId,
      productTitle,
      productImage,
      quantity: activeQty > 0 ? activeQty : purchasedQty,
      originalQuantity: purchasedQty,
      cancelledQty,
      cancelRequestedQty,
      price: Number(it?.model_discounted_price || it?.model_original_price || it?.item_price || 0),
      modelId: modelId === "0" ? undefined : modelId,
      modelSku,
      modelName,
    };
  } catch (err) {
    console.warn("[Shopee Sync] mapShopeeOrderLineItem failed:", err);
    return null;
  }
}

// --- Shopee tracking: carrier (SPXVN...) vs internal sorting (0FG...) ---
function isShopeeInternalTrackingCode(code: unknown): boolean {
  return /^0FG/i.test(String(code || "").trim());
}

function isCarrierTrackingCode(code: unknown): boolean {
  const k = String(code || "").trim().toUpperCase();
  if (!k || isShopeeInternalTrackingCode(k)) return false;
  return /^(SPX(VN)?|GHN|GHTK|JNT|JT|NINJA|VTP|VNPOST|LEX|NJV|GRB|MY|SG|TH|ID|PH)/.test(k);
}

function applyShopeeTrackingCode(order: any, rawCode: unknown) {
  const code = String(rawCode || "").trim();
  if (!code) return;
  if (isCarrierTrackingCode(code)) {
    order.trackingNumber = code;
    return;
  }
  if (isShopeeInternalTrackingCode(code)) {
    order.internalTrackingCode = code;
    return;
  }
  if (isCarrierTrackingCode(code)) {
    order.trackingNumber = code;
  }
}

function repairMisassignedTracking(order: any): any {
  if (!order || typeof order !== "object") return order;
  if (order.trackingNumber && isShopeeInternalTrackingCode(order.trackingNumber)) {
    if (!order.internalTrackingCode) order.internalTrackingCode = order.trackingNumber;
    order.trackingNumber = undefined;
  }
  return order;
}

function mergeShopeeTrackingFields(merged: any, existing: any, incoming: any) {
  repairMisassignedTracking(merged);
  const pickCarrier = (...candidates: unknown[]) => {
    for (const c of candidates) {
      const s = String(c || "").trim();
      if (s && isCarrierTrackingCode(s)) return s;
    }
    return undefined;
  };
  const pickInternal = (...candidates: unknown[]) => {
    for (const c of candidates) {
      const s = String(c || "").trim();
      if (s && isShopeeInternalTrackingCode(s)) return s;
    }
    return undefined;
  };

  merged.trackingNumber = pickCarrier(
    incoming.trackingNumber,
    existing.trackingNumber,
    incoming.lastMileTrackingNumber,
    existing.lastMileTrackingNumber,
  );
  merged.internalTrackingCode = pickInternal(
    incoming.internalTrackingCode,
    existing.internalTrackingCode,
    incoming.trackingNumber,
    existing.trackingNumber,
    incoming.firstMileTrackingNumber,
    existing.firstMileTrackingNumber,
  );
}

function applyShopeeGetTrackingResponse(order: any, trackResult: any): void {
  const resp = trackResult?.response;
  if (!resp) return;
  if (resp.tracking_number) applyShopeeTrackingCode(order, resp.tracking_number);
  if (resp.last_mile_tracking_number) applyShopeeTrackingCode(order, resp.last_mile_tracking_number);
  if (resp.first_mile_tracking_number) {
    if (isShopeeInternalTrackingCode(resp.first_mile_tracking_number)) {
      order.internalTrackingCode = resp.first_mile_tracking_number;
    } else {
      applyShopeeTrackingCode(order, resp.first_mile_tracking_number);
    }
  }
  repairMisassignedTracking(order);
}

function trackingForShopeeShippingDoc(order: any): string | undefined {
  return order.trackingNumber || order.internalTrackingCode || undefined;
}

function needsShopeeTrackingEnrichment(order: any): boolean {
  if (order.channel !== "shopee") return false;
  const status = String(order.status || "");
  if (!["processed", "shipping", "completed", "return_pending"].includes(status)) return false;
  if (order.trackingNumber && isCarrierTrackingCode(order.trackingNumber)) return false;
  return true;
}

async function enrichShopeeOrderTrackingFromApi(shopId: string, accessToken: string, order: any): Promise<any> {
  repairMisassignedTracking(order);
  if (!needsShopeeTrackingEnrichment(order)) return order;
  try {
    const result = await shopeeGetTrackingNumber(shopId, accessToken, order.orderSn, order.packageNumber);
    applyShopeeGetTrackingResponse(order, result);
  } catch (err) {
    console.warn(`[Shopee Tracking] enrich ${order.orderSn} failed:`, err);
  }
  return order;
}

// Normalize one item from get_order_detail's `order_list` into this project's Order shape.
function normalizeShopeeOrderDetail(shopId: string, shopName: string, item: any): any | null {
  if (!item || !item.order_sn) {
    console.warn("[Shopee Sync] Bỏ qua order detail thiếu order_sn:", item);
    return null;
  }
  try {
    const rawStatus = String(item?.order_status || "READY_TO_SHIP").toUpperCase();
    const pkg = Array.isArray(item?.package_list) ? item.package_list[0] : undefined;
    const itemList = Array.isArray(item?.item_list) ? item.item_list : [];
    const mappedItems = itemList.map((it: any) => mapShopeeOrderLineItem(it)).filter(Boolean);
    const order: any = {
      id: `shopee-${item.order_sn}`,
      orderSn: String(item.order_sn),
      channel: "shopee",
      shopId: String(shopId),
      shopName: resolveConnectedShopDisplayName(shopId, shopName) || `Shop ${shopId}`,
      totalAmount: Number(item?.total_amount || 0),
      withholdingCitTax: 0,
      withholding_cit_tax: 0,
      revenue: 0,
      status: SHOPEE_ORDER_STATUS_MAP[rawStatus] || "unprocessed",
      date: item?.create_time ? new Date(Number(item.create_time) * 1000).toISOString() : new Date().toISOString(),
      packageNumber: pkg?.package_number || undefined,
      isPrepared: rawStatus === "PROCESSED" || rawStatus === "SHIPPED" || rawStatus === "TO_CONFIRM_RECEIVE",
      isPrinted: false,
      items: mappedItems,
    };
    applyShopeePartialCancelMeta(order, item, mappedItems);
    applyShopeeOrderFinanceFields(order, {
      totalAmount: order.totalAmount,
      withholdingCitTax: extractShopeeWithholdingCitTax(item),
    });
    if (pkg?.tracking_number) applyShopeeTrackingCode(order, pkg.tracking_number);
    repairMisassignedTracking(order);
    return order;
  } catch (err) {
    console.error(`[Shopee Sync] normalizeShopeeOrderDetail lỗi order_sn=${item?.order_sn}:`, err);
    return null;
  }
}

// Upsert one Shopee order from get_order_detail — trust Shopee status for tab
// placement while preserving local print flags and non-empty item snapshots.
function orderItemsHaveVariationData(items: any[] | undefined): boolean {
  return Array.isArray(items) && items.some((i) => i?.modelId || i?.modelName || i?.modelSku);
}

function mergeShopeeOrderOnSync(existing: any | undefined, incoming: any): any {
  if (!existing) return incoming;

  const merged = { ...existing, ...incoming, id: existing.id };
  // Luôn ghi đè trạng thái từ Shopee (shipping / cancelled / ...) — không giữ status local cũ.
  merged.status = incoming.status;
  merged.isPrepared =
    incoming.status === "processed" ||
    incoming.status === "shipping" ||
    incoming.status === "completed" ||
    incoming.status === "return_pending";
  if (incoming.status === "cancelled") {
    merged.isPrepared = false;
  }
  merged.isPrinted = Boolean(existing.isPrinted);

  const incomingItems = Array.isArray(incoming.items) ? incoming.items : [];
  const existingItems = Array.isArray(existing.items) ? existing.items : [];
  if (incomingItems.length > 0) {
    if (
      orderItemsHaveVariationData(incomingItems) ||
      !existingItems.length ||
      !orderItemsHaveVariationData(existingItems)
    ) {
      merged.items = incomingItems;
    } else {
      merged.items = existingItems;
    }
  } else if (existingItems.length) {
    merged.items = existingItems;
  }
  if (!incoming.packageNumber && existing.packageNumber) {
    merged.packageNumber = existing.packageNumber;
  }
  if (!incoming.shopId && existing.shopId) {
    merged.shopId = existing.shopId;
  }
  merged.shopName =
    resolveConnectedShopDisplayName(merged.shopId, incoming.shopName) ||
    resolveConnectedShopDisplayName(existing.shopId, existing.shopName) ||
    merged.shopName;
  mergeShopeeTrackingFields(merged, existing, incoming);
  if (incoming.withholdingCitTax != null || incoming.withholding_cit_tax != null) {
    applyShopeeOrderFinanceFields(merged, {
      totalAmount: merged.totalAmount,
      withholdingCitTax: extractShopeeWithholdingCitTax(incoming),
      escrowAmount: incoming.escrowAmount,
    });
  } else if (existing.withholdingCitTax != null || existing.withholding_cit_tax != null) {
    applyShopeeOrderFinanceFields(merged, {
      totalAmount: merged.totalAmount,
      withholdingCitTax: extractShopeeWithholdingCitTax(existing),
      escrowAmount: existing.escrowAmount,
    });
  } else {
    applyShopeeOrderFinanceFields(merged, { totalAmount: merged.totalAmount });
  }
  if (incoming.partialCancel != null) merged.partialCancel = incoming.partialCancel;
  if (incoming.canPartialCancel != null) merged.canPartialCancel = incoming.canPartialCancel;
  delete merged.customerName;
  delete merged.customerPhone;
  delete merged.customerAddress;
  return merged;
}

// TO_CONFIRM_RECEIVE is returned inside SHIPPED pages — not a valid order_status filter.
// CANCELLED/IN_CANCEL bắt buộc để tab "Đơn hủy" không bị lệch số liệu.
const SHOPEE_SYNC_STATUSES = ["READY_TO_SHIP", "PROCESSED", "RETRY_SHIP", "SHIPPED", "CANCELLED", "IN_CANCEL"] as const;

const SHOPEE_SYNC_UI_STATUSES = new Set(["pending_confirm", "unprocessed", "processed", "shipping", "cancelled"]);

function upsertShopeeOrdersIntoStore(
  orders: any[],
  normalizedList: any[],
): { added: number; updated: number } {
  let added = 0;
  let updated = 0;
  for (const normalized of normalizedList) {
    const existingIndex = orders.findIndex((o: any) => o.orderSn === normalized.orderSn);
    if (existingIndex >= 0) {
      orders[existingIndex] = mergeShopeeOrderOnSync(orders[existingIndex], normalized);
      updated++;
    } else {
      orders.unshift(normalized);
      added++;
    }
  }
  return { added, updated };
}

/** Lấy chi tiết + chuẩn hóa THEO LÔ — 1 lần get_order_detail tối đa 25 order_sn. */
async function fetchNormalizeShopeeOrderChunk(
  apiShopId: string,
  accessToken: string,
  fileKey: string,
  orderSns: string[],
  opts?: { enrichTracking?: boolean },
): Promise<{ normalized: any[]; errors: any[] }> {
  const normalized: any[] = [];
  const errors: any[] = [];
  const enrichTracking = opts?.enrichTracking !== false;
  const snList = orderSns.map((sn) => String(sn || "").trim()).filter(Boolean);
  if (snList.length === 0) return { normalized, errors };

  try {
    console.log(
      `[Shopee Sync] get_order_detail lô ${snList.length} đơn (shop=${fileKey}): ${snList.slice(0, 3).join(", ")}${snList.length > 3 ? "..." : ""}`,
    );
    const detailResult = await shopeeGetOrderDetail(apiShopId, accessToken, snList);
    if (detailResult.error) {
      const message = detailResult.message || formatShopeeApiError(detailResult);
      for (const orderSn of snList) {
        errors.push({
          shopId: fileKey,
          error: detailResult.error,
          message,
          orderSn,
        });
      }
      return { normalized, errors };
    }

    const detailList = detailResult?.response?.order_list ?? detailResult?.order_list ?? [];
    if (!Array.isArray(detailList) || detailList.length === 0) {
      console.warn(`[Shopee Sync] get_order_detail trả về rỗng cho lô ${snList.length} đơn — shop ${fileKey}`);
      return { normalized, errors };
    }

    for (const detail of detailList) {
      try {
        let norm = normalizeShopeeOrderDetail(fileKey, detail?.shop_name, detail);
        if (!norm) continue;
        if (enrichTracking && needsShopeeTrackingEnrichment(norm)) {
          norm = await enrichShopeeOrderTrackingFromApi(apiShopId, accessToken, norm);
        }
        normalized.push(norm);
      } catch (detailErr: any) {
        console.error(`[Shopee Sync] Lỗi xử lý đơn ${detail?.order_sn}:`, detailErr?.message || detailErr);
        errors.push({
          shopId: fileKey,
          error: "normalize_failed",
          message: detailErr?.message || String(detailErr),
          orderSn: detail?.order_sn,
        });
      }
    }

    if (normalized.length > 0) {
      await enrichShopeeOrdersEscrowFinance(apiShopId, accessToken, normalized);
    }
  } catch (err: any) {
    const message = err?.message || String(err);
    for (const orderSn of snList) {
      errors.push({
        shopId: fileKey,
        error: "order_detail_failed",
        message,
        orderSn,
      });
    }
  }

  return { normalized, errors };
}

/** Upsert lô đơn vào store JSON + Mongo bulkWrite (1 lần / lô). */
async function persistShopeeOrderChunk(
  orders: any[],
  batchNormalized: any[],
): Promise<{ added: number; updated: number }> {
  for (const normalized of batchNormalized) {
    const existing = orders.find((o: any) => o.orderSn === normalized.orderSn);
    if (normalized.partialCancel) {
      await restoreLocalStockForPartialCancel(
        normalized.shopId || existing?.shopId,
        existing,
        normalized,
      );
    }
  }
  const upsert = upsertShopeeOrdersIntoStore(orders, batchNormalized);
  saveOrders(orders);
  if (isMongoReady() && batchNormalized.length > 0) {
    try {
      await bulkUpsertOrdersToStore(batchNormalized);
    } catch (mongoErr: any) {
      console.error("[Orders Sync] Mongo bulkWrite thất bại:", mongoErr?.message || mongoErr);
    }
  }
  return upsert;
}

// Pull orders from every connected Shopee shop — tuần tự + chunk delay, save orders.json sau mỗi chunk.
async function syncShopeeOrdersFromApi(
  statuses: string[] = [...SHOPEE_SYNC_STATUSES],
  opts?: { onProgress?: (completed: number, total: number, message?: string) => void },
) {
  const onProgress = opts?.onProgress;
  const tokens = loadShopeeTokens();
  const shopIds = Object.keys(tokens);
  let orders = loadOrders();
  let syncedCount = 0;
  let addedCount = 0;
  let updatedCount = 0;
  const errors: any[] = [];
  const statusCounts: Record<string, number> = {};

  const dedupeErrors = (list: any[]) => {
    const seen = new Set<string>();
    return list.filter((e) => {
      const k = `${e.shopId}:${e.error}:${e.message || ""}:${e.status || ""}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };

  for (const shopKey of shopIds) {
    let auth = await getShopeeAccessTokenForApi(shopKey);
    if (!auth) {
      const tokenFail = describeShopeeTokenFailure(shopKey);
      errors.push({
        shopId: shopKey,
        error: tokenFail.error,
        message: tokenFail.message,
      });
      continue;
    }

    const runShopPullLowMemory = async (accessToken: string, apiShopId: string, fileKey: string) => {
      const shopErrors: any[] = [];
      const orderSnSet = new Set<string>();

      for (const status of statuses) {
        await shopeeSyncDelay();
        try {
          const sns = await shopeeFetchAllOrderSnsByStatus(apiShopId, accessToken, status);
          for (const sn of sns) orderSnSet.add(sn);
          statusCounts[`${fileKey}:${status}`] = sns.length;
          console.log(`[Shopee Sync] Shop ${fileKey} (api=${apiShopId}) / ${status}: ${sns.length} đơn.`);
        } catch (statusErr: any) {
          const errMsg = statusErr?.message || String(statusErr);
          console.error(`[Shopee Sync] Shop ${fileKey} / ${status} lỗi:`, errMsg);
          shopErrors.push({ shopId: fileKey, status, error: statusErr?.error || "shopee_api_error", message: errMsg });
        }
      }

      let orderSnList = Array.from(orderSnSet);
      orderSnSet.clear();
      if (orderSnList.length > SHOPEE_SYNC_MAX_ORDER_SNS_PER_SHOP) {
        console.warn(
          `[Shopee Sync] Shop ${fileKey}: cắt ${orderSnList.length} → ${SHOPEE_SYNC_MAX_ORDER_SNS_PER_SHOP} đơn để tránh quá tải RAM.`,
        );
        orderSnList = orderSnList.slice(0, SHOPEE_SYNC_MAX_ORDER_SNS_PER_SHOP);
      }

      const syncedSnSet = new Set<string>();
      const totalSnTarget = orderSnList.length;
      if (onProgress) onProgress(0, totalSnTarget, `Shop ${fileKey}: bắt đầu tải ${totalSnTarget} đơn...`);

      for (let i = 0; i < orderSnList.length; i += SHOPEE_SYNC_CHUNK_SIZE) {
        const chunkSns = orderSnList.slice(i, i + SHOPEE_SYNC_CHUNK_SIZE);
        const { normalized: batchNormalized, errors: chunkErrors } = await fetchNormalizeShopeeOrderChunk(
          apiShopId,
          accessToken,
          fileKey,
          chunkSns,
        );
        shopErrors.push(...chunkErrors);

        for (const norm of batchNormalized) {
          syncedSnSet.add(norm.orderSn);
        }

        if (batchNormalized.length > 0) {
          const upsert = await persistShopeeOrderChunk(orders, batchNormalized);
          addedCount += upsert.added;
          updatedCount += upsert.updated;
          syncedCount += batchNormalized.length;

          console.log(
            `[Shopee Sync] RAM/Mongo checkpoint: đã lưu chunk ${Math.floor(i / SHOPEE_SYNC_CHUNK_SIZE) + 1} (${batchNormalized.length} đơn, ${SHOPEE_SYNC_CHUNK_SIZE}/chunk) — shop ${fileKey}.`,
          );
        }

        if (onProgress) {
          onProgress(
            Math.min(i + SHOPEE_SYNC_CHUNK_SIZE, totalSnTarget),
            totalSnTarget,
            `Shop ${fileKey}: đã xử lý ${Math.min(i + SHOPEE_SYNC_CHUNK_SIZE, totalSnTarget)}/${totalSnTarget} đơn`,
          );
        }

        if (i + SHOPEE_SYNC_CHUNK_SIZE < orderSnList.length) {
          await shopeeSyncDelay(SHOPEE_SYNC_CHUNK_DELAY_MS);
        }
      }

      orderSnList = [];

      return { shopErrors, syncedSnSet, totalSnTarget };
    };

    try {
      let pullResult = await runShopPullLowMemory(auth.token, auth.apiShopId, auth.fileKey);

      if (
        pullResult.shopErrors.some((e) => isShopeeInvalidTokenError(e.error, e.message)) &&
        !pullResult.shopErrors.every((e) => e.error === "no_valid_access_token")
      ) {
        console.warn(`[Shopee Sync] shop_id=${shopKey} invalid access_token — đang refresh và thử lại...`);
        await shopeeSyncDelay();
        auth = (await getShopeeAccessTokenForApi(shopKey, { forceRefresh: true })) || auth;
        if (auth) {
          const retry = await runShopPullLowMemory(auth.token, auth.apiShopId, auth.fileKey);
          if (
            !retry.shopErrors.some((e) => isShopeeInvalidTokenError(e.error, e.message)) ||
            retry.syncedSnSet.size > pullResult.syncedSnSet.size
          ) {
            pullResult = retry;
          } else {
            pullResult.shopErrors = [
              {
                shopId: shopKey,
                error: "invalid_access_token",
                message: "Token không hợp lệ sau khi refresh — vào Cài đặt → OAuth lại shop này.",
              },
            ];
          }
        }
      }

      errors.push(...pullResult.shopErrors);

      if (pullResult.totalSnTarget === 0) continue;

      const fetchComplete =
        pullResult.totalSnTarget > 0 && pullResult.syncedSnSet.size >= pullResult.totalSnTarget;
      if (fetchComplete) {
        orders = orders.filter((o: any) => {
          if (o.channel !== "shopee" || String(o.shopId) !== String(auth!.fileKey)) return true;
          if (pullResult.syncedSnSet.has(o.orderSn)) return false;
          if (!SHOPEE_SYNC_UI_STATUSES.has(o.status)) return true;
          return false;
        });
        try {
          saveOrders(orders);
        } catch (saveErr: any) {
          errors.push({ error: "save_orders_failed", message: saveErr?.message || String(saveErr) });
        }
      } else if (pullResult.totalSnTarget > pullResult.syncedSnSet.size) {
        console.warn(
          `[Shopee Sync] shop_id=${shopKey}: get_order_detail thiếu ${pullResult.totalSnTarget - pullResult.syncedSnSet.size}/${pullResult.totalSnTarget} đơn — giữ đơn cũ, không xóa.`,
        );
      }

      pullResult.syncedSnSet.clear();
    } catch (error: any) {
      const errorMsg = error?.message || formatShopeeApiError(error) || String(error);
      console.error(`[Shopee Sync] Lỗi shop_id=${shopKey}:`, errorMsg);
      errors.push({
        shopId: shopKey,
        error: error?.error || error?.code || "sync_shop_failed",
        message: errorMsg,
      });
    }

    await shopeeSyncDelay();
  }

  const uiStatusCounts = {
    unprocessed: orders.filter((o: any) => o.status === "unprocessed").length,
    processed: orders.filter((o: any) => o.status === "processed").length,
    shipping: orders.filter((o: any) => o.status === "shipping").length,
    pending_confirm: orders.filter((o: any) => o.status === "pending_confirm").length,
  };
  console.log(`[Shopee Sync] UI counts sau đồng bộ:`, JSON.stringify(uiStatusCounts));

  const uniqueErrors = dedupeErrors(errors);

  return {
    synced: syncedCount,
    added: addedCount,
    updated: updatedCount,
    orders: [],
    statusCounts,
    uiStatusCounts,
    errors: uniqueErrors.length ? uniqueErrors : undefined,
    warning:
      uniqueErrors.some((e) => isShopeeInvalidTokenError(e.error, e.message))
        ? "Một số shop có token Shopee hết hạn — vào Cài đặt bấm OAuth lại shop bị lỗi."
        : undefined,
  };
}
const ORDERS_DB_PATH = path.join(APP_ROOT, "data", "orders.json");

// Local JSON-file "database" holding orders synced in from real marketplace webhooks (Shopee, ...).

type OrderLookupIndex = {
  byId: Map<string, number>;
  byOrderSn: Map<string, number>;
  byTracking: Map<string, number>;
  byInternal: Map<string, number>;
  byPackage: Map<string, number>;
};

let orderLookupIndex: OrderLookupIndex | null = null;

function normalizeOrderIndexKey(raw: string): string {
  return String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/[\s\-_#./\\|:;,]+/g, "");
}

function rebuildOrderLookupIndex(orders: any[]): OrderLookupIndex {
  const byId = new Map<string, number>();
  const byOrderSn = new Map<string, number>();
  const byTracking = new Map<string, number>();
  const byInternal = new Map<string, number>();
  const byPackage = new Map<string, number>();

  orders.forEach((order, index) => {
    const put = (map: Map<string, number>, value: unknown) => {
      const key = normalizeOrderIndexKey(String(value || ""));
      if (key) map.set(key, index);
    };
    put(byId, order.id);
    put(byId, String(order.id || "").replace(/^shopee-/i, ""));
    put(byOrderSn, order.orderSn);
    put(byTracking, order.trackingNumber);
    put(byInternal, order.internalTrackingCode);
    put(byPackage, order.packageNumber);
  });

  return { byId, byOrderSn, byTracking, byInternal, byPackage };
}

function getOrderLookupIndex(orders: any[]): OrderLookupIndex {
  if (!orderLookupIndex) {
    orderLookupIndex = rebuildOrderLookupIndex(orders);
  }
  return orderLookupIndex;
}

function loadOrders(): any[] {
  try {
    if (!fs.existsSync(ORDERS_DB_PATH)) {
      orderLookupIndex = rebuildOrderLookupIndex([]);
      return [];
    }
    const raw = fs.readFileSync(ORDERS_DB_PATH, "utf-8");
    const parsed = raw.trim() ? JSON.parse(raw) : [];
    const orders = Array.isArray(parsed) ? parsed.map(repairMisassignedTracking) : [];
    orderLookupIndex = rebuildOrderLookupIndex(orders);
    return orders;
  } catch (error) {
    console.error("[Orders DB] Failed to read orders.json:", error);
    orderLookupIndex = rebuildOrderLookupIndex([]);
    return [];
  }
}

function saveOrders(orders: any[]): void {
  try {
    fs.mkdirSync(path.dirname(ORDERS_DB_PATH), { recursive: true });
    const sanitized = orders.map(repairMisassignedTracking);
    fs.writeFileSync(ORDERS_DB_PATH, JSON.stringify(sanitized), "utf-8");
    orderLookupIndex = rebuildOrderLookupIndex(sanitized);
  } catch (error) {
    console.error("[Orders DB] Failed to write orders.json:", error);
  }
}

function toDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseDashboardOrderDate(dateStr: string): Date {
  const raw = String(dateStr || "").trim();
  if (!raw) return new Date(NaN);
  const datePart = raw.split("T")[0];
  const [y, m, d] = datePart.split("-").map(Number);
  if (!y || !m || !d) return new Date(NaN);
  return new Date(y, m - 1, d);
}

function isDashboardOrder(order: any): boolean {
  const sn = String(order?.orderSn || order?.id || "");
  if (!sn) return false;
  const hasAmount = Number(order?.totalAmount) > 0;
  const hasItems = Array.isArray(order?.items) && order.items.length > 0;
  if (!hasAmount && !hasItems && sn.startsWith("260709")) return false;
  return true;
}

function getDashboardDateRange(rangeKey: string) {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);

  switch (rangeKey) {
    case "this_month":
      return { start: new Date(y, m, 1), end, key: "this_month", label: "Tháng này" };
    case "last_month":
      return {
        start: new Date(y, m - 1, 1),
        end: new Date(y, m, 0, 23, 59, 59, 999),
        key: "last_month",
        label: "Tháng trước",
      };
    case "this_quarter": {
      const qStart = Math.floor(m / 3) * 3;
      return { start: new Date(y, qStart, 1), end, key: "this_quarter", label: "Quý này" };
    }
    case "this_year":
      return { start: new Date(y, 0, 1), end, key: "this_year", label: "Năm nay" };
    case "today": {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      return { start, end, key: "today", label: "Hôm nay" };
    }
    case "last_7_days":
    default: {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      start.setDate(start.getDate() - 6);
      return { start, end, key: "last_7_days", label: "7 ngày qua" };
    }
  }
}

function isDateInRange(dateStr: string, start: Date, end: Date): boolean {
  const d = parseDashboardOrderDate(dateStr);
  if (Number.isNaN(d.getTime())) return false;
  const s = new Date(start);
  s.setHours(0, 0, 0, 0);
  const e = new Date(end);
  e.setHours(23, 59, 59, 999);
  return d >= s && d <= e;
}

function findOrderItemMeta(orders: any[], productId: string): { title: string | null; image: string | null } {
  for (const order of orders) {
    const items = Array.isArray(order?.items) ? order.items : [];
    const hit = items.find((i: any) => String(i.productId) === productId);
    if (hit) {
      return {
        title: hit.productTitle ? String(hit.productTitle) : null,
        image: hit.productImage ? String(hit.productImage) : null,
      };
    }
  }
  return { title: null, image: null };
}

function buildDashboardChart(orders: any[], range: { start: Date; end: Date; key: string }) {
  const buckets = new Map<string, { key: string; label: string; amount: number }>();

  if (range.key === "this_year" || range.key === "this_quarter") {
    const cursor = new Date(range.start.getFullYear(), range.start.getMonth(), 1);
    const endMonth = new Date(range.end.getFullYear(), range.end.getMonth(), 1);
    while (cursor <= endMonth) {
      const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`;
      buckets.set(key, {
        key,
        label: `T${cursor.getMonth() + 1}`,
        amount: 0,
      });
      cursor.setMonth(cursor.getMonth() + 1);
    }
  } else {
    const cursor = new Date(range.start);
    cursor.setHours(0, 0, 0, 0);
    const endDay = new Date(range.end);
    endDay.setHours(0, 0, 0, 0);
    while (cursor <= endDay) {
      const key = toDateKey(cursor);
      buckets.set(key, {
        key,
        label: `${String(cursor.getDate()).padStart(2, "0")}/${String(cursor.getMonth() + 1).padStart(2, "0")}`,
        amount: 0,
      });
      cursor.setDate(cursor.getDate() + 1);
    }
  }

  for (const order of orders) {
    const dateStr = String(order.date || "").split("T")[0];
    let bucketKey = dateStr;
    if (range.key === "this_year" || range.key === "this_quarter") {
      const d = parseDashboardOrderDate(dateStr);
      bucketKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    }
    const bucket = buckets.get(bucketKey);
    if (bucket) {
      bucket.amount += Number(order.totalAmount) || 0;
    }
  }

  return Array.from(buckets.values());
}

const PRODUCTS_DB_PATH = path.join(APP_ROOT, "data", "products.json"); // legacy — chỉ dùng khi migrate
const LOCAL_INVENTORY_CACHE_PATH = path.join(APP_ROOT, "data", "local_inventory.json"); // legacy
const SQLITE_LEGACY_PATH = path.join(APP_ROOT, "database.sqlite"); // legacy — không dùng runtime

/** Lấy children nếu đã có (không gom nhóm nặng). */
function getProductChildrenList(p: any): any[] {
  try {
    if (Array.isArray(p?.children) && p.children.length > 0) return p.children;
    if (Array.isArray(p?.children_models) && p.children_models.length > 0) return p.children_models;
  } catch {
    /* ignore */
  }
  return [];
}

/** Đọc products TRỰC TIẾP từ MongoDB (Model.find). */
async function loadProducts(): Promise<any[]> {
  try {
    return await loadProductsFromStore();
  } catch (error) {
    console.error("[Products DB] Failed to read from MongoDB:", error);
    throw error instanceof Error ? error : new Error(String(error));
  }
}

async function loadProductById(productId: string): Promise<any | null> {
  try {
    return await loadProductByIdFromStore(productId);
  } catch (error) {
    console.error(`[Products DB] loadProductById failed id=${productId}:`, error);
    return null;
  }
}

function collectCatalogLookupKeysFromOrders(orders: any[]): { productIds: string[]; shopeeItemIds: string[] } {
  const productIds = new Set<string>();
  const shopeeItemIds = new Set<string>();
  for (const order of Array.isArray(orders) ? orders : []) {
    for (const item of Array.isArray(order?.items) ? order.items : []) {
      const pid = String(item?.productId || "").trim();
      if (pid) {
        shopeeItemIds.add(pid);
        productIds.add(pid);
        productIds.add(`shopee-item-${pid}`);
      }
      const modelId = String(item?.modelId || item?.shopeeModelId || "").trim();
      if (modelId) {
        shopeeItemIds.add(modelId);
        productIds.add(modelId);
      }
      const sku = String(item?.modelSku || item?.sku || "").trim();
      if (sku) productIds.add(sku);
    }
  }
  return { productIds: [...productIds], shopeeItemIds: [...shopeeItemIds] };
}

/** Chỉ tải catalog cho các SKU/item có trong lô đơn — tránh ProductModel.find({}). */
async function loadProductsForOrders(orders: any[]): Promise<any[]> {
  const { productIds, shopeeItemIds } = collectCatalogLookupKeysFromOrders(orders);
  if (productIds.length === 0 && shopeeItemIds.length === 0) return [];
  try {
    const rows = await loadProductsByIdsFromStore(productIds, shopeeItemIds);
    console.log(
      `[Products DB] loadProductsForOrders — ${orders.length} đơn → query ${productIds.length} id / ${shopeeItemIds.length} itemId → ${rows.length} sản phẩm`,
    );
    return rows;
  } catch (error) {
    console.error("[Products DB] loadProductsForOrders failed:", error);
    return [];
  }
}

/**
 * Local Cache Master — luôn query MongoDB.
 */
async function refreshCache(): Promise<LocalInventoryCache> {
  ensureDataDirs();
  const payload = await buildLocalInventoryCacheFromStore();
  console.log(
    `[Local Cache] refreshCache OK (MongoDB find) — products=${payload.products.length}, listings=${payload.listings.length}`
  );
  return payload;
}

/** Đọc Local Cache từ MongoDB. */
async function loadLocalInventoryCache(): Promise<LocalInventoryCache> {
  try {
    return await buildLocalInventoryCacheFromStore();
  } catch (error) {
    console.error("[Local Cache] Đọc MongoDB thất bại:", error);
    throw error instanceof Error ? error : new Error(String(error));
  }
}

/**
 * Đảm bảo Mongo sẵn sàng + migrate legacy nếu cần.
 */
async function initLocalInventoryIfNeeded(_force = false): Promise<LocalInventoryCache> {
  ensureDataDirs();
  await maybeMigrateJsonToMongoOnBoot();
  return await loadLocalInventoryCache();
}

/** Ghi products — await insertMany MongoDB. */
async function saveProducts(products: any[]): Promise<void> {
  try {
    ensureDataDirs();
    const list = Array.isArray(products)
      ? products.filter((p) => p != null && typeof p === "object")
      : [];
    await saveProductsToStoreAsync(list);
    console.log(
      `Đã lưu DB thành công — MongoDB products insertMany: ${list.length} dòng -> ${getMongoUriMasked()}`
    );
  } catch (error) {
    console.error("[Products DB] Failed to write MongoDB:", error);
    throw error instanceof Error ? error : new Error(String(error));
  }
}

async function saveProductsAsync(products: any[]): Promise<void> {
  await saveProducts(products);
}

/** Alias nhẹ — giữ tương thích chỗ gọi cũ (không còn regroup). */
function groupProductsByItemId(products: any[]): any[] {
  return Array.isArray(products) ? products : [];
}

function groupFlatProductsToParents(products: any[]): any[] {
  return Array.isArray(products) ? products : [];
}

const CHANNEL_LISTINGS_DB_PATH = path.join(APP_ROOT, "data", "channel_listings.json"); // legacy
const SHOPEE_SYNC_ERRORS_DB_PATH = path.join(APP_ROOT, "data", "shopee_sync_errors.json");
const SHOPEE_SYNC_ERRORS_MAX_ROWS = 500;

function renameLegacyJsonIfExists(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = `${filePath}.migrated.${stamp}`;
  try {
    fs.renameSync(filePath, dest);
    console.log(`[Mongo Migrate] Renamed ${path.basename(filePath)} → ${path.basename(dest)}`);
  } catch (err) {
    console.warn(`[Mongo Migrate] Không rename được ${filePath}:`, err);
  }
}

function readLegacyJsonArray(filePath: string): any[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf-8");
    if (!raw || !raw.trim()) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Tìm file backup migrate mới nhất (products.json.migrated.*) */
function findLatestMigratedJson(baseName: string): string | null {
  const dataDir = path.join(APP_ROOT, "data");
  if (!fs.existsSync(dataDir)) return null;
  const prefix = `${baseName}.migrated.`;
  const matches = fs
    .readdirSync(dataDir)
    .filter((f) => f.startsWith(prefix))
    .sort();
  if (matches.length === 0) return null;
  return path.join(dataDir, matches[matches.length - 1]);
}

/** Boot-time: nếu Mongo trống mà còn JSON/legacy → migrate lên Atlas. */
async function maybeMigrateJsonToMongoOnBoot(): Promise<void> {
  try {
    const productCount = await countProducts();
    const listingCount = await countChannelListings();
    const legacyProducts =
      PRODUCTS_DB_PATH && fs.existsSync(PRODUCTS_DB_PATH)
        ? PRODUCTS_DB_PATH
        : findLatestMigratedJson("products.json");
    const legacyListings = fs.existsSync(CHANNEL_LISTINGS_DB_PATH)
      ? CHANNEL_LISTINGS_DB_PATH
      : findLatestMigratedJson("channel_listings.json");
    const hasLegacy =
      !!legacyProducts ||
      !!legacyListings ||
      fs.existsSync(LOCAL_INVENTORY_CACHE_PATH) ||
      !!findLatestMigratedJson("local_inventory.json");

    if (!hasLegacy) {
      console.log(
        `[MongoDB] Ready — products=${productCount}, listings=${listingCount} @ ${getMongoUriMasked()} (ready=${isMongoReady()})`
      );
      return;
    }

    if (productCount > 0 || listingCount > 0) {
      console.log(
        `[MongoDB] Đã có dữ liệu (products=${productCount}, listings=${listingCount}) — archive JSON legacy.`
      );
      renameLegacyJsonIfExists(PRODUCTS_DB_PATH);
      renameLegacyJsonIfExists(CHANNEL_LISTINGS_DB_PATH);
      renameLegacyJsonIfExists(LOCAL_INVENTORY_CACHE_PATH);
      return;
    }

    console.log("[Mongo Migrate] Mongo trống + còn JSON legacy — bắt đầu migrate...");
    let products = legacyProducts ? readLegacyJsonArray(legacyProducts) : [];
    let listings = legacyListings ? readLegacyJsonArray(legacyListings) : [];

    const invPath = fs.existsSync(LOCAL_INVENTORY_CACHE_PATH)
      ? LOCAL_INVENTORY_CACHE_PATH
      : findLatestMigratedJson("local_inventory.json");
    if (invPath) {
      try {
        const inv = JSON.parse(fs.readFileSync(invPath, "utf-8"));
        const invProducts = Array.isArray(inv?.products) ? inv.products : [];
        const invListings = Array.isArray(inv?.listings) ? inv.listings : [];
        const byId = new Map<string, any>();
        for (const p of [...invProducts, ...products]) {
          const id = String(p?.id || "").trim();
          if (id) byId.set(id, p);
        }
        products = Array.from(byId.values());
        const byListingId = new Map<string, any>();
        for (const r of [...invListings, ...listings]) {
          const id = String(r?.id || "").trim();
          if (id) byListingId.set(id, r);
        }
        listings = Array.from(byListingId.values());
      } catch (err) {
        console.warn("[Mongo Migrate] Không đọc được local_inventory:", err);
      }
    }

    await seedStoreFromArrays(products, listings);

    console.log(
      `[Mongo Migrate] Xong — products=${await countProducts()}, listings=${await countChannelListings()} (mongoReady=${isMongoReady()})`
    );
    renameLegacyJsonIfExists(PRODUCTS_DB_PATH);
    renameLegacyJsonIfExists(CHANNEL_LISTINGS_DB_PATH);
    renameLegacyJsonIfExists(LOCAL_INVENTORY_CACHE_PATH);
    if (fs.existsSync(SQLITE_LEGACY_PATH)) {
      try {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        fs.renameSync(SQLITE_LEGACY_PATH, `${SQLITE_LEGACY_PATH}.legacy.${stamp}`);
        console.log("[Mongo Migrate] Archived database.sqlite (không còn dùng)");
      } catch {
        /* ignore */
      }
    }
  } catch (err) {
    console.error("[Mongo Migrate] Boot migrate thất bại:", err);
  }
}

function readShopeeSyncErrorsDb(): any[] {
  try {
    if (!fs.existsSync(SHOPEE_SYNC_ERRORS_DB_PATH)) return [];
    const raw = fs.readFileSync(SHOPEE_SYNC_ERRORS_DB_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error("[Shopee Sync Errors DB] Failed to read:", err);
    return [];
  }
}

async function appendShopeeSyncErrorToDb(entry: {
  itemId?: number | string;
  modelId?: number | string;
  sku?: string;
  shopId?: string;
  action: string;
  error: string;
  productId?: string;
}): Promise<void> {
  const row = {
    id: `se-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    platform: "shopee",
    itemId: entry.itemId != null ? String(entry.itemId) : undefined,
    modelId: entry.modelId != null ? String(entry.modelId) : undefined,
    sku: entry.sku ? String(entry.sku) : undefined,
    shopId: entry.shopId ? String(entry.shopId) : undefined,
    action: entry.action,
    error: String(entry.error || "unknown_error").slice(0, 500),
    productId: entry.productId ? String(entry.productId) : undefined,
  };

  try {
    const prev = readShopeeSyncErrorsDb();
    const next = [row, ...prev].slice(0, SHOPEE_SYNC_ERRORS_MAX_ROWS);
    fs.mkdirSync(path.dirname(SHOPEE_SYNC_ERRORS_DB_PATH), { recursive: true });
    fs.writeFileSync(SHOPEE_SYNC_ERRORS_DB_PATH, JSON.stringify(next, null, 2), "utf-8");
  } catch (err) {
    console.error("[Shopee Sync Errors DB] Failed to write:", err);
  }

  const channelId = row.modelId && row.itemId ? `${row.itemId}:${row.modelId}` : row.itemId;
  if (!channelId) return;

  try {
    const listings = await readChannelListingsDb();
    const key = `shopee::${channelId}`;
    let changed = false;
    const nextListings = listings.map((listing: any) => {
      if (`${listing.platform}::${listing.channelId}` !== key) return listing;
      changed = true;
      return {
        ...sanitizeChannelListingRow(listing),
        status: "failed",
        syncError: row.error,
        updatedAt: row.timestamp,
      };
    });
    if (changed) await writeChannelListingsDb(nextListings);
  } catch (err) {
    console.error("[Shopee Sync Errors DB] Failed to update channel_listings:", err);
  }
}

async function readChannelListingsDb(): Promise<any[]> {
  try {
    return await loadChannelListingsFromStore();
  } catch (error) {
    console.error("[Channel Listings DB] Failed to read from MongoDB:", error);
    throw error instanceof Error ? error : new Error(String(error));
  }
}

async function writeChannelListingsDb(rows: any[]): Promise<void> {
  await writeChannelListingsDbAsync(rows);
}

async function writeChannelListingsDbAsync(rows: any[]): Promise<void> {
  ensureDataDirs();
  const payload = Array.isArray(rows) ? rows.filter((r) => r != null && typeof r === "object") : [];
  await saveChannelListingsToStoreAsync(payload);
  console.log(
    `Đã lưu DB thành công — MongoDB channel_listings insertMany: ${payload.length} dòng -> ${getMongoUriMasked()}`
  );
}

/** Sản phẩm kéo từ Shopee dạng shopee-item-* — KHÔNG phải Kho gốc thủ công. */
function isSyntheticShopeePullProduct(p: any): boolean {
  const id = String(p?.id || "");
  return id.startsWith("shopee-item-");
}

function sanitizeChannelListingRow(row: any): any {
  const platform = String(row?.platform || "shopee").trim() || "shopee";
  const channelId = String(row?.channelId || "").trim();
  const statusRaw = String(row?.status || "unlinked");
  const status = ["success", "failed", "unlinked", "invalid"].includes(statusRaw) ? statusRaw : "unlinked";
  const linkedProductId =
    row?.linkedProductId != null && String(row.linkedProductId).trim() !== ""
      ? String(row.linkedProductId)
      : undefined;
  return {
    id: String(row?.id || `cl-${platform}-${channelId || "unknown"}`),
    title: String(row?.title ?? ""),
    sku: String(row?.sku ?? ""),
    imageUrl: row?.imageUrl ? String(row.imageUrl) : undefined,
    channelId,
    platform,
    shopName: String(row?.shopName ?? ""),
    shopId: row?.shopId != null && String(row.shopId).trim() !== "" ? String(row.shopId) : undefined,
    status,
    linkedProductId,
    // Snapshot tên/SKU kho gốc — dùng khi JOIN miss (pagination / file lệch).
    linkedProductTitle:
      row?.linkedProductTitle != null && String(row.linkedProductTitle).trim() !== ""
        ? String(row.linkedProductTitle).trim()
        : undefined,
    linkedProductSku:
      row?.linkedProductSku != null && String(row.linkedProductSku).trim() !== ""
        ? String(row.linkedProductSku).trim()
        : undefined,
    itemId: row?.itemId != null && String(row.itemId).trim() !== "" ? String(row.itemId) : undefined,
    modelId: row?.modelId != null && String(row.modelId).trim() !== "" ? String(row.modelId) : undefined,
    syncError: row?.syncError ? String(row.syncError).slice(0, 500) : undefined,
    updatedAt: String(row?.updatedAt || new Date().toISOString()),
  };
}

/** Index id → product (parent + children) để JOIN mapping ↔ kho gốc. */
function buildMasterProductLookupById(products?: any[]): Map<string, any> {
  const index = new Map<string, any>();
  for (const p of Array.isArray(products) ? products : []) {
    if (!p) continue;
    if (p.id != null) index.set(String(p.id), p);
    for (const c of getProductChildrenList(p)) {
      if (c?.id != null) index.set(String(c.id), c);
    }
  }
  return index;
}

/**
 * JOIN mapping ↔ Kho gốc — lookup BẮT BUỘC theo record.linkedProductId trong DATA,
 * không phụ thuộc UI có render ID hay không.
 * Phòng thủ: mọi truy cập linkedProduct dùng ?. ; lỗi 1 dòng không crash toàn bộ.
 */
function enrichChannelListingsWithMaster(listings: any[], products?: any[]): any[] {
  try {
    const safeListings = Array.isArray(listings) ? listings : [];
    let lookup: Map<string, any>;
    try {
      const sourceProducts = Array.isArray(products) ? products : [];
      lookup = buildMasterProductLookupById(sourceProducts);
    } catch (lookupErr: unknown) {
      console.error("[Mapping Products] buildMasterProductLookupById failed:", lookupErr);
      lookup = new Map();
    }
    let brokenCount = 0;

    const enriched = safeListings.map((row) => {
      try {
        if (!row || typeof row !== "object") {
          return sanitizeChannelListingRow({ status: "unlinked" });
        }
        const base = sanitizeChannelListingRow(row);
        const linkedId =
          base.linkedProductId ||
          (row?.linkedProduct?.id != null ? String(row.linkedProduct.id) : undefined);

        if (!linkedId) {
          if (base.status === "success") {
            brokenCount++;
            return {
              ...base,
              status: "unlinked",
              linkedProductId: undefined,
              linkedProductTitle: undefined,
              linkedProductSku: undefined,
              linkedProduct: undefined,
              syncError: "Lỗi liên kết (Mất dữ liệu): thiếu linkedProductId trong record",
              linkBroken: true,
            };
          }
          return {
            ...base,
            linkedProductTitle: undefined,
            linkedProductSku: undefined,
            linkedProduct: undefined,
          };
        }

        const master = lookup.get(String(linkedId));
        if (!master) {
          brokenCount++;
          const snapTitle =
            base.linkedProductTitle ||
            String(row?.linkedProduct?.title || "").trim() ||
            undefined;
          const snapSku =
            base.linkedProductSku ||
            String(row?.linkedProduct?.sku || "").trim() ||
            undefined;
          if (base.status === "success") {
            return {
              ...base,
              status: "unlinked",
              linkedProductId: undefined,
              linkedProductTitle: undefined,
              linkedProductSku: undefined,
              linkedProduct: undefined,
              syncError: `Lỗi liên kết (Mất dữ liệu): không tìm thấy SP id=${linkedId}${snapTitle ? ` (trước đó: ${snapTitle})` : ""}`,
              linkBroken: true,
              previousLinkedProductId: linkedId,
              previousLinkedTitle: snapTitle,
              previousLinkedSku: snapSku,
            };
          }
          return {
            ...base,
            linkedProductTitle: undefined,
            linkedProductSku: undefined,
            linkedProduct: undefined,
            linkBroken: true,
          };
        }

        const title = String(master?.title || base.linkedProductTitle || "").trim();
        const sku = String(master?.sku || base.linkedProductSku || "").trim();
        if (base.status === "success" && !title && !sku) {
          brokenCount++;
          return {
            ...base,
            status: "unlinked",
            linkedProductId: undefined,
            linkedProduct: undefined,
            linkedProductTitle: undefined,
            linkedProductSku: undefined,
            syncError: `Lỗi liên kết (Mất dữ liệu): SP id=${linkedId} thiếu title/sku`,
            linkBroken: true,
          };
        }

        return {
          ...base,
          linkedProductId: String(linkedId),
          linkedProductTitle: title || undefined,
          linkedProductSku: sku || undefined,
          linkedProduct: {
            id: String(master?.id ?? linkedId),
            title: title || String(master?.id ?? linkedId),
            sku: sku || "—",
          },
          syncError: base.status === "success" ? undefined : base.syncError,
          linkBroken: false,
        };
      } catch (rowErr: unknown) {
        console.error("[Mapping Products] enrich row skip:", rowErr);
        try {
          return sanitizeChannelListingRow({
            ...(row && typeof row === "object" ? row : {}),
            status: "unlinked",
            linkedProductId: undefined,
            syncError: "enrich_row_error",
            linkBroken: true,
          });
        } catch {
          return {
            id: `cl-error-${Date.now()}`,
            title: "",
            sku: "",
            channelId: "",
            platform: "shopee",
            shopName: "",
            status: "unlinked",
            updatedAt: new Date().toISOString(),
            linkBroken: true,
          };
        }
      }
    });

    if (brokenCount > 0) {
      console.warn(
        `[Mapping Products] Có ${brokenCount} dòng status=success nhưng linkedProduct null/mất — đã hạ về unlinked (in-memory)`
      );
    }
    return enriched;
  } catch (err: unknown) {
    console.error("[Mapping Products] enrichChannelListingsWithMaster failed:", err);
    return (Array.isArray(listings) ? listings : []).map((row) => {
      try {
        return sanitizeChannelListingRow(row);
      } catch {
        return {
          id: `cl-fallback-${Date.now()}`,
          title: "",
          sku: "",
          channelId: "",
          platform: "shopee",
          shopName: "",
          status: "unlinked",
          updatedAt: new Date().toISOString(),
        };
      }
    });
  }
}

/**
 * Heal liên kết hỏng — CHỈ gọi chủ động qua POST /api/mapping-products/heal.
 * KHÔNG gọi trên GET (tránh OOM / crash cPanel khi ghi file lớn).
 * @returns số dòng đã ghi DB
 */
async function persistHealedBrokenMappingLinks(enriched: any[]): Promise<number> {
  try {
    const broken = Array.isArray(enriched) ? enriched.filter((r) => r?.linkBroken === true) : [];
    if (broken.length === 0) return 0;

    const existing = await readChannelListingsDb();
    const byId = new Map(
      (Array.isArray(existing) ? existing : [])
        .filter((r: any) => r?.id != null)
        .map((r: any) => [String(r.id), r])
    );
    let changed = 0;
    for (const row of broken) {
      const id = String(row?.id || "");
      if (!id) continue;
      const prev = byId.get(id);
      if (!prev) continue;
      byId.set(
        id,
        sanitizeChannelListingRow({
          ...prev,
          status: "unlinked",
          linkedProductId: undefined,
          linkedProductTitle: undefined,
          linkedProductSku: undefined,
          syncError: row?.syncError,
        })
      );
      changed++;
    }
    if (changed > 0) {
      await writeChannelListingsDb(Array.from(byId.values()));
      console.log(`[Mapping Products] Đã heal ${changed} liên kết hỏng → unlinked trong DB`);
    }
    return changed;
  } catch (err: unknown) {
    console.error("[Mapping Products] persistHealedBrokenMappingLinks failed:", err);
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/**
 * Xóa orphan mapping một cách bảo thủ:
 * - Giữ nguyên mọi dòng chưa từng liên kết.
 * - Chỉ xóa dòng có linkedProductId/linkedProduct.id hoặc status=success,
 *   nhưng không còn trỏ tới sản phẩm parent/child trong Kho gốc.
 * - Hàm này chỉ ghi channel_listings (MongoDB), tuyệt đối không gọi (await saveProducts()).
 */
async function purgeBrokenChannelListings(): Promise<{
  scanned: number;
  purged: number;
  remaining: number;
  missingLinkedId: number;
  missingMasterProduct: number;
  malformed: number;
  masterProductCount: number;
}> {
  const listings = await readChannelListingsDb();
  const masterProducts = await loadProducts();
  const masterLookup = buildMasterProductLookupById(masterProducts);
  const kept: any[] = [];
  let missingLinkedId = 0;
  let missingMasterProduct = 0;
  let malformed = 0;

  for (const row of listings) {
    if (!row || typeof row !== "object") {
      malformed++;
      continue;
    }

    const linkedId =
      row?.linkedProductId != null && String(row.linkedProductId).trim() !== ""
        ? String(row.linkedProductId).trim()
        : row?.linkedProduct?.id != null && String(row.linkedProduct.id).trim() !== ""
          ? String(row.linkedProduct.id).trim()
          : "";
    const claimsLink = row?.status === "success" || linkedId !== "";

    // Dòng chưa liên kết là dữ liệu sàn hợp lệ, không phải orphan.
    if (!claimsLink) {
      kept.push(row);
      continue;
    }
    if (!linkedId) {
      missingLinkedId++;
      continue;
    }
    if (!masterLookup.has(linkedId)) {
      missingMasterProduct++;
      continue;
    }

    kept.push(row);
  }

  const purged = listings.length - kept.length;
  if (purged > 0) {
    await writeChannelListingsDb(kept);
  }
  console.log(
    `[Mapping Purge] scanned=${listings.length}, purged=${purged}, remaining=${kept.length}, missingLinkedId=${missingLinkedId}, missingMaster=${missingMasterProduct}, malformed=${malformed}, masterUntouched=${masterProducts.length}`,
  );

  return {
    scanned: listings.length,
    purged,
    remaining: kept.length,
    missingLinkedId,
    missingMasterProduct,
    malformed,
    masterProductCount: masterProducts.length,
  };
}

async function upsertChannelListingsFromShopeeSync(
  syncedProducts: any[],
  shopId: string,
  shopName: string,
): Promise<any[]> {
  // Reuse UPSERT batch (item_id + model_id) rồi gắn lại linkedProductId theo SKU/kho.
  await upsertChannelListingsBatch(asShopeeArray(syncedProducts), shopId, shopName);

  const existing = await readChannelListingsDb();
  const masterProducts = await loadProducts();
  const byKey = new Map<string, any>();

  for (const listing of existing) {
    const ids = resolveUpsertItemModelFromRow(listing);
    if (!ids) continue;
    byKey.set(channelListingUpsertKey(ids.itemId, ids.modelId), listing);
  }

  for (const item of asShopeeArray(syncedProducts)) {
    try {
      const ids = resolveUpsertItemModelFromRow(item);
      if (!ids) continue;

      const key = channelListingUpsertKey(ids.itemId, ids.modelId);
      const prev = byKey.get(key);

      const matchedMaster =
        masterProducts.find(
          (p) =>
            (p?.shopeeId && String(p.shopeeId) === ids.channelId) ||
            (item?.shopeeItemId &&
              p?.shopeeItemId &&
              String(p.shopeeItemId) === String(item.shopeeItemId) &&
              (!item?.sku ||
                normalizeSkuKey(p?.sku) === normalizeSkuKey(item?.sku))) ||
            (item?.sku &&
              normalizeSkuKey(p?.sku) === normalizeSkuKey(item?.sku)),
        ) || (item?.id ? item : undefined);

      const status =
        matchedMaster?.id || prev?.linkedProductId
          ? "success"
          : prev?.status === "failed"
            ? "failed"
            : "unlinked";

      byKey.set(
        key,
        sanitizeChannelListingRow({
          id: prev?.id || `cl-shopee-${ids.channelId}`,
          title: String(item?.title || prev?.title || ""),
          sku: String(item?.sku || prev?.sku || ""),
          imageUrl: item?.avatarUrl || item?.imageUrl || prev?.imageUrl,
          channelId: ids.channelId,
          platform: "shopee",
          shopName,
          shopId: String(shopId),
          itemId: ids.itemId,
          modelId: ids.modelId || prev?.modelId,
          status,
          linkedProductId: matchedMaster?.id || prev?.linkedProductId,
        })
      );
    } catch (rowErr: unknown) {
      console.error("DB Save Error: (sync upsert skip)", rowErr);
    }
  }

  const merged = Array.from(byKey.values());
  console.log(`[Mapping Save] Chuẩn bị UPSERT ${merged.length} dòng -> MongoDB @ ${getMongoUriMasked()}`);
  try {
    await writeChannelListingsDbAsync(merged);
  } catch (err: any) {
    const errMsg = err?.message || String(err);
    console.error(`[Mapping Save] Lỗi lưu Database: ${errMsg}`);
    throw new Error(`Lỗi lưu Database: ${errMsg}`);
  }
  console.log(`[Channel Listings] Đã UPSERT ${merged.length} liên kết sàn sau đồng bộ Shopee shop_id=${shopId}`);
  return merged;
}

/** Chỉ lưu sản phẩm sàn từ Shopee — UPSERT theo item_id + model_id, KHÔNG auto-map SKU. */
async function upsertChannelListingsFromShopeeFetch(
  syncedProducts: any[],
  shopId: string,
  shopName: string,
): Promise<any[]> {
  await upsertChannelListingsBatch(asShopeeArray(syncedProducts), shopId, shopName);
  const merged = await readChannelListingsDb();
  console.log(`[Shopee Channel Fetch] Đã UPSERT ${merged.length} sản phẩm sàn shop_id=${shopId}`);
  return merged;
}

/**
 * Đọc Local Cache Master từ MongoDB (`products` + `channel_listings`).
 */
async function readLocalInventoryFileSync(): LocalInventoryCache {
  const cache = await loadLocalInventoryCache();
  if (!Array.isArray(cache.products) || cache.products.length === 0) {
    throw new Error(
      "MongoDB không có sản phẩm Kho gốc (products=[]). Hãy khởi tạo/sync dữ liệu trước."
    );
  }
  console.log(
    `[Local Cache] MongoDB OK — masterData(products)=${cache.products.length}, listings=${cache.listings.length}`
  );
  return cache;
}

/**
 * SKU khớp tuyệt đối — CHỈ trim + toLowerCase.
 * Cấm includes / regex / cắt tiền tố một phần (tránh M15 ↔ 1).
 */
function normalizeSkuKey(sku: unknown): string {
  return String(sku ?? "").trim().toLowerCase();
}

function skusExactMatch(listingSku: unknown, masterSku: unknown): boolean {
  const a = normalizeSkuKey(listingSku);
  const b = normalizeSkuKey(masterSku);
  return a !== "" && b !== "" && a === b;
}

/** @deprecated tên cũ — luôn exact match */
function skusLooselyMatch(listingSku: unknown, masterSku: unknown): boolean {
  return skusExactMatch(listingSku, masterSku);
}

/**
 * Index SKU từ .products — khóa = trim().toLowerCase() tuyệt đối.
 * Gồm sản phẩm mẹ + children/variants/models.
 */
function buildMasterSkuIndex(masterData: any[]): Map<string, any> {
  const index = new Map<string, any>();
  if (!Array.isArray(masterData)) return index;

  const addSku = (row: any) => {
    if (!row || isSyntheticShopeePullProduct(row)) return;
    const key = normalizeSkuKey(row.sku);
    if (key && !index.has(key)) index.set(key, row);
  };

  for (const masterItem of masterData) {
    if (!masterItem) continue;
    addSku(masterItem);
    for (const child of getProductChildrenList(masterItem)) addSku(child);
    if (Array.isArray(masterItem.variants)) {
      for (const v of masterItem.variants) addSku(v);
    }
    if (Array.isArray(masterItem.models)) {
      for (const m of masterItem.models) addSku(m);
    }
  }
  return index;
}

/** Tìm sản phẩm kho theo SKU sàn — CHỈ exact match. */
function findMasterProductBySku(
  masterSkuIndex: Map<string, any>,
  listingSku: unknown,
  _masterData?: any[]
): any | null {
  const key = normalizeSkuKey(listingSku);
  if (!key) return null;
  return masterSkuIndex.get(key) || null;
}

/** Đã có liên kết → BẢO VỆ, tuyệt đối không ghi đè. */
function isListingAlreadyLinkedProtected(listing: any): boolean {
  if (!listing || typeof listing !== "object") return false;
  if (listing.linkBroken === true) return false;
  const linkedId =
    listing.linkedProductId != null && String(listing.linkedProductId).trim() !== ""
      ? String(listing.linkedProductId).trim()
      : listing.linkedProduct?.id != null && String(listing.linkedProduct.id).trim() !== ""
        ? String(listing.linkedProduct.id).trim()
        : "";
  if (linkedId) return true;
  if (listing.status === "success" && listing.linkedProduct != null) return true;
  return false;
}

/** Ghi products MongoDB 1 lần — không cần refresh file cache. */
async function writeProductsFileOnly(products: any[]): Promise<void> {
  ensureDataDirs();
  const list = Array.isArray(products)
    ? products.filter((p) => p != null && typeof p === "object")
    : [];
  await saveProductsToStoreAsync(list);
  console.log(`[Batch Auto-link] Ghi MongoDB products xong — ${list.length} dòng.`);
}

function persistBatchAutoLinkListingUpdate(
  dbListings: any[],
  rowIndex: number,
  nextRow: any
): any {
  const patched = sanitizeChannelListingRow(nextRow);
  dbListings[rowIndex] = patched;
  return patched;
}

function findChannelListingRowIndex(
  rows: any[],
  opts?: { id?: unknown; listingId?: unknown; channelId?: unknown; platform?: unknown }
): number {
  const listingId = String(opts?.id || opts?.listingId || "").trim();
  const channelId = String(opts?.channelId || "").trim();
  const platform = String(opts?.platform || "").trim().toLowerCase();

  if (listingId) {
    const byId = rows.findIndex((row) => String(row?.id || "").trim() === listingId);
    if (byId !== -1) return byId;
  }

  if (channelId) {
    return rows.findIndex((row) => {
      const safe = sanitizeChannelListingRow(row);
      if (String(safe.channelId || "").trim() !== channelId) return false;
      if (!platform) return true;
      return String(safe.platform || "").trim().toLowerCase() === platform;
    });
  }

  return -1;
}

async function autoLinkSingleListingFromDatabase(opts?: {
  id?: unknown;
  listingId?: unknown;
  channelId?: unknown;
  platform?: unknown;
}): Promise<{
  success: boolean;
  listing?: any;
  message: string;
  matchedProductId?: string;
}> {
  const dbListings = await readChannelListingsDb();
  if (!Array.isArray(dbListings) || dbListings.length === 0) {
    throw new Error("Không có dữ liệu channel_listings để liên kết.");
  }

  const rowIndex = findChannelListingRowIndex(dbListings, opts);
  if (rowIndex === -1) {
    throw new Error("Không tìm thấy sản phẩm sàn cần liên kết.");
  }

  const current = sanitizeChannelListingRow(dbListings[rowIndex]);
  const masterProducts = await loadProducts();
  if (!Array.isArray(masterProducts) || masterProducts.length === 0) {
    throw new Error("Kho sản phẩm chính đang trống. Hãy khởi tạo/sync dữ liệu trước.");
  }

  if (isListingAlreadyLinkedProtected(current)) {
    const enrichedExisting = enrichChannelListingsWithMaster([current], masterProducts)[0];
    return {
      success: true,
      listing: enrichedExisting,
      matchedProductId:
        current.linkedProductId != null && String(current.linkedProductId).trim() !== ""
          ? String(current.linkedProductId).trim()
          : undefined,
      message: "Sản phẩm này đã được liên kết trước đó.",
    };
  }

  const normalizedSku = normalizeSkuKey(current?.sku);
  if (!normalizedSku) {
    return {
      success: false,
      listing: enrichChannelListingsWithMaster([current], masterProducts)[0],
      message: "SKU sản phẩm sàn đang trống hoặc không hợp lệ.",
    };
  }

  const masterSkuIndex = buildMasterSkuIndex(masterProducts);
  const masterItem = findMasterProductBySku(masterSkuIndex, current?.sku, masterProducts);
  if (!masterItem) {
    return {
      success: false,
      listing: enrichChannelListingsWithMaster([current], masterProducts)[0],
      message: `Không tìm thấy SKU khớp trong Kho gốc cho "${normalizedSku}" (gốc: "${String(current?.sku || "").trim()}").`,
    };
  }

  const patched = persistBatchAutoLinkListingUpdate(dbListings, rowIndex, {
    ...current,
    status: "success",
    linkedProductId:
      masterItem?.id != null && String(masterItem.id).trim() !== ""
        ? String(masterItem.id).trim()
        : undefined,
    linkedProductTitle: String(masterItem?.title || "").trim() || undefined,
    linkedProductSku: String(masterItem?.sku || "").trim() || undefined,
    syncError: undefined,
  });

  await upsertChannelListingToStore(patched);
  await flushDbWrites();
  const cache = await refreshCache();
  await sleep(1);

  const verifiedListings = enrichChannelListingsWithMaster(cache.listings, cache.products);
  const verifiedListing =
    verifiedListings.find((row) => String(row?.id || "").trim() === String(patched.id).trim()) ||
    enrichChannelListingsWithMaster([patched], cache.products)[0];

  return {
    success: true,
    listing: verifiedListing,
    matchedProductId:
      masterItem?.id != null && String(masterItem.id).trim() !== ""
        ? String(masterItem.id).trim()
        : undefined,
    message: "Liên kết tự động thành công.",
  };
}

/**
 * Batch Auto-link — chỉ dùng Database hiện tại:
 * 1) Lấy channel_listings chưa liên kết
 * 2) Lấy toàn bộ Kho gốc từ products DB
 * 3) So khớp SKU đã chuẩn hóa
 * 4) Ghi DB tuần tự bằng for...of, tuyệt đối không Promise.all
 */
async function batchAutoLinkFromDatabase(opts?: {
  cursor?: number;
  limit?: number;
}): Promise<{
  linkedCount: number;
  listings: any[];
  alreadyLinked: number;
  unlinkedRemaining: number;
  cacheUpdatedAt: string;
  masterProductCount: number;
  skuIndexSize: number;
  scannedCount: number;
  requestedLimit: number;
  nextCursor: number;
  hasMore: boolean;
}> {
  try {
    console.log("[Batch Auto-link] Bắt đầu đối chiếu từ Database hiện tại...");

    // ===== 2) LỌC DỮ LIỆU CŨ — CHỈ LẤY "CHƯA LIÊN KẾT" =====
    const dbListings = await readChannelListingsDb();
    if (!Array.isArray(dbListings) || dbListings.length === 0) {
      throw new Error("Không có dữ liệu channel_listings để liên kết.");
    }
    const masterProducts = await loadProducts();
    if (!Array.isArray(masterProducts) || masterProducts.length === 0) {
      throw new Error("Kho sản phẩm chính đang trống. Hãy khởi tạo/sync dữ liệu trước.");
    }

    const requestedCursor = Number.isFinite(Number(opts?.cursor))
      ? Math.max(0, Math.floor(Number(opts?.cursor)))
      : 0;
    const requestedLimitRaw = Number.isFinite(Number(opts?.limit))
      ? Math.floor(Number(opts?.limit))
      : AUTO_LINK_BATCH_LIMIT_DEFAULT;
    const requestedLimit = Math.min(AUTO_LINK_BATCH_LIMIT_MAX, Math.max(1, requestedLimitRaw));

    let alreadyLinked = 0;
    let linkedCount = 0;
    let unlinkedTotal = 0;
    let scannedCount = 0;
    let nextCursor = dbListings.length;
    let wroteChanges = false;
    const newlyLinkedRows: any[] = [];
    // Dùng đúng helper matching hiện có: trim().toLowerCase() và cắt prefix trước "_".
    const masterSkuIndex = buildMasterSkuIndex(masterProducts);
    console.log(
      `[Batch Auto-link] DB loaded: masterProducts=${masterProducts.length}, skuIndex=${masterSkuIndex.size}, listings=${dbListings.length}, cursor=${requestedCursor}, limit=${requestedLimit}`
    );

    // ===== 3, 4) SO KHỚP SÂU + GHI DB TUẦN TỰ THEO BATCH NHỎ =====
    for (let rowIndex = requestedCursor; rowIndex < dbListings.length; rowIndex += 1) {
      const item = sanitizeChannelListingRow(dbListings[rowIndex]);
      if (item.status !== "unlinked" || isListingAlreadyLinkedProtected(item)) {
        alreadyLinked += 1;
        continue;
      }

      unlinkedTotal += 1;
      scannedCount += 1;
      nextCursor = rowIndex + 1;

      const targetSku = normalizeSkuKey(item?.sku);
      if (targetSku) {
        const masterItem = findMasterProductBySku(masterSkuIndex, item?.sku, masterProducts);
        if (masterItem) {
          const patched = persistBatchAutoLinkListingUpdate(dbListings, rowIndex, {
            ...item,
            status: "success",
            linkedProductId:
              masterItem?.id != null && String(masterItem.id).trim() !== ""
                ? String(masterItem.id).trim()
                : undefined,
            linkedProductTitle: String(masterItem?.title || "").trim() || undefined,
            linkedProductSku: String(masterItem?.sku || "").trim() || undefined,
            syncError: undefined,
          });
          newlyLinkedRows.push(patched);
          linkedCount += 1;
          wroteChanges = true;
          console.log(`[Batch Auto-link] Đã xử lý tuần tự thành công: ${linkedCount}`);
        }
      }

      if (scannedCount >= requestedLimit) {
        break;
      }
    }

    if (wroteChanges) {
      for (const listing of newlyLinkedRows) {
        await upsertChannelListingToStore(listing);
      }
      await flushDbWrites();
      await sleep(1);
    }

    const unlinkedRemaining = dbListings.filter((row) => {
      const safeRow = sanitizeChannelListingRow(row);
      return safeRow.status === "unlinked" && !isListingAlreadyLinkedProtected(safeRow);
    }).length;
    const hasMore = nextCursor < dbListings.length;
    console.log(
      `[Batch Auto-link] Hoàn tất — linked=${linkedCount}, protected=${alreadyLinked}, scanned=${scannedCount}, unlinked=${unlinkedTotal}, remaining=${unlinkedRemaining}, nextCursor=${nextCursor}, hasMore=${hasMore}`
    );

    return {
      linkedCount,
      listings: newlyLinkedRows,
      alreadyLinked,
      unlinkedRemaining,
      cacheUpdatedAt: new Date().toISOString(),
      masterProductCount: masterProducts.length,
      skuIndexSize: masterSkuIndex.size,
      scannedCount,
      requestedLimit,
      nextCursor,
      hasMore,
    };
  } catch (error: unknown) {
    console.error("[Batch Auto-link] Matching failed:", error);
    throw error instanceof Error ? error : new Error(String(error));
  }
}
const SUPPLIERS_DB_PATH = path.join(APP_ROOT, "data", "suppliers.json");

function normalizeSupplier(raw: any): any {
  const totalOrderValue = Number(raw?.totalOrderValue) || 0;
  const totalPaid = Number(raw?.totalPaid) || 0;
  return {
    id: String(raw?.id || `sup-${Date.now()}`),
    name: String(raw?.name || "").trim(),
    supplierCode: String(raw?.supplierCode || raw?.supplier_code || "").trim().toUpperCase(),
    totalOrderValue,
    totalPaid,
    totalDebt: Number(raw?.totalDebt ?? totalOrderValue - totalPaid) || 0,
    status: raw?.status === "inactive" ? "inactive" : "active",
  };
}

function loadSuppliers(): any[] {
  try {
    if (!fs.existsSync(SUPPLIERS_DB_PATH)) return [];
    const raw = fs.readFileSync(SUPPLIERS_DB_PATH, "utf-8");
    const parsed = raw.trim() ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.map(normalizeSupplier) : [];
  } catch (error) {
    console.error("[Suppliers DB] Failed to read suppliers.json:", error);
    return [];
  }
}

function saveSuppliers(suppliers: any[]): void {
  try {
    fs.mkdirSync(path.dirname(SUPPLIERS_DB_PATH), { recursive: true });
    fs.writeFileSync(SUPPLIERS_DB_PATH, JSON.stringify(suppliers, null, 2), "utf-8");
  } catch (error: any) {
    console.error(
      "Lỗi chi tiết khi lưu shop/OAuth:",
      error?.response?.data || error?.message || String(error),
    );
    console.error("[Suppliers DB] Failed to write suppliers.json:", error);
  }
}

const CHANNEL_SETTINGS_PATH = path.join(APP_ROOT, "data", "channel_settings.json");

const DEFAULT_CHANNEL_SETTINGS: Record<string, any> = {
  shopeeConnected: false,
  shopeeShopId: "",
  shopeeApiKey: "",
  tiktokConnected: false,
  tiktokShopId: "",
  tiktokApiKey: "",
  shops: [],
};

const GENERIC_SHOPEE_SHOP_LABELS = new Set(["shopee shop", "gian hàng"]);

function isGenericShopeeShopLabel(name: string | undefined): boolean {
  const label = String(name || "").trim();
  if (!label) return true;
  if (GENERIC_SHOPEE_SHOP_LABELS.has(label.toLowerCase())) return true;
  if (/^shopee\s+\d+$/i.test(label)) return true;
  return false;
}

function getConnectedShopNameMap(): Map<string, string> {
  const settings = loadChannelSettings();
  const map = new Map<string, string>();
  for (const shop of settings.shops || []) {
    const id = normalizeShopIdKey(shop.shopId || shop.id);
    const name = String(shop.shopName || "").trim();
    if (id && name && !isGenericShopeeShopLabel(name)) {
      map.set(id, name);
    }
  }
  return map;
}

function resolveConnectedShopDisplayName(
  shopId: string | number | undefined,
  fallbackName?: string,
): string | undefined {
  const sid = normalizeShopIdKey(shopId);
  if (sid) {
    const fromSettings = getConnectedShopNameMap().get(sid);
    if (fromSettings) return fromSettings;
  }
  const fallback = String(fallbackName || "").trim();
  if (fallback && !isGenericShopeeShopLabel(fallback)) return fallback;
  return sid ? `Shop ${sid}` : undefined;
}

/** Chỉ ĐỌC mapping từ MongoDB — tuyệt đối không ghi / không rebuild / không auto-link. */
async function readChannelListingsForGet(): any[] {
  const existing = await readChannelListingsDb();
  console.log(
    `[Mapping GET] Đọc DB (read-only): ${existing.length} dòng từ MongoDB @ ${getMongoUriMasked()}`
  );
  return existing;
}

async function hydrateChannelListingsOnBoot(): Promise<void> {
  try {
    ensureDataDirs();
    const cache = await initLocalInventoryIfNeeded(true);
    console.log(
      `[Boot] MongoDB sẵn sàng: products=${cache.products.length}, listings=${cache.listings.length} @ ${getMongoUriMasked()} (ready=${isMongoReady()})`
    );
  } catch (err: any) {
    console.error(`[Boot] Không thể khởi tạo MongoDB mapping/cache:`, err?.message || err);
  }
}

function enrichOrderShopName(order: any): any {
  if (!order || order.channel !== "shopee") return order;
  const resolved = resolveConnectedShopDisplayName(order.shopId, order.shopName);
  if (!resolved || order.shopName === resolved) return order;
  return { ...order, shopName: resolved };
}

function enrichOrdersWithShopNames(orders: any[]): any[] {
  return orders.map(enrichOrderShopName);
}

function logOAuthSaveError(context: string, error: any): void {
  const detail = error?.response?.data ?? error?.message ?? String(error);
  console.error(`Lỗi chi tiết khi lưu shop/OAuth (${context}):`, detail);
}

function normalizeConnectedShop(raw: any): Record<string, any> | null {
  if (!raw || typeof raw !== "object") return null;
  const platform = String(raw?.platform || raw?.type || "").trim().toLowerCase();
  if (!["shopee", "tiktok", "woocommerce"].includes(platform)) return null;
  const shopId = String(raw?.shopId ?? raw?.shop_id ?? "").trim();
  const shopName = String(raw?.shopName ?? raw?.shop_name ?? raw?.name ?? "").trim();
  const apiKey = String(raw?.apiKey ?? raw?.api_key ?? raw?.partner_id ?? "").trim();
  if (!shopId || !shopName || !apiKey) {
    console.warn(
      "[Channel Settings] Shop thiếu trường bắt buộc:",
      JSON.stringify({ platform, shopId: shopId || null, shopName: shopName || null, hasApiKey: Boolean(apiKey) }),
    );
    return null;
  }
  const shop: Record<string, any> = {
    id: String(raw?.id || `shop-${platform}-${shopId}`),
    platform,
    shopId,
    shopName,
    apiKey,
    connected: Boolean(raw?.connected),
    lastSynced: raw?.lastSynced ? String(raw.lastSynced) : undefined,
  };
  if (raw?.apiSecret) shop.apiSecret = String(raw.apiSecret).trim();
  if (raw?.wooUrl) shop.wooUrl = String(raw.wooUrl).trim();
  return shop;
}

function shopListKey(shop: Record<string, any>): string {
  const platform = String(shop?.platform || "").trim().toLowerCase();
  const shopId = normalizeShopIdKey(shop?.shopId) || String(shop?.shopId ?? "").trim();
  return `${platform}:${shopId}`;
}

/** UPSERT danh sách shop — giữ metadata cũ (id, shopName, apiKey) khi OAuth cập nhật token. */
function upsertShopsInChannelSettings(
  existing: Record<string, any>[] = [],
  incoming: Record<string, any>[] = [],
): Record<string, any>[] {
  const map = new Map<string, Record<string, any>>();

  for (const raw of existing) {
    const normalized = normalizeConnectedShop(raw);
    if (!normalized) continue;
    map.set(shopListKey(normalized), normalized);
  }

  for (const raw of incoming) {
    const normalized = normalizeConnectedShop(raw);
    if (!normalized) continue;
    const key = shopListKey(normalized);
    const prev = map.get(key);
    if (prev) {
      map.set(key, {
        ...prev,
        ...normalized,
        id: prev.id || normalized.id,
        shopName: normalized.shopName || prev.shopName,
        apiKey: normalized.apiKey || prev.apiKey,
        apiSecret: normalized.apiSecret ?? prev.apiSecret,
        wooUrl: normalized.wooUrl ?? prev.wooUrl,
        connected: normalized.connected ?? prev.connected,
        lastSynced: normalized.lastSynced || prev.lastSynced,
      });
    } else {
      map.set(key, normalized);
    }
  }

  return dedupeShopsByPlatformId([...map.values()]);
}

function dedupeShopsByPlatformId(shops: Record<string, any>[]): Record<string, any>[] {
  const map = new Map<string, Record<string, any>>();
  for (const shop of shops) {
    if (!shop) continue;
    const key = `${shop.platform}:${normalizeShopIdKey(shop.shopId) || String(shop.shopId)}`;
    map.set(key, shop);
  }
  return [...map.values()];
}

function loadChannelSettings(): Record<string, any> {
  try {
    if (!fs.existsSync(CHANNEL_SETTINGS_PATH)) return { ...DEFAULT_CHANNEL_SETTINGS, shops: [] };
    const raw = fs.readFileSync(CHANNEL_SETTINGS_PATH, "utf-8");
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    const rawShops = Array.isArray(parsed?.shops) ? parsed.shops : [];
    const shops = upsertShopsInChannelSettings([], rawShops);
    if (rawShops.length > shops.length) {
      console.warn(
        `[Channel Settings] ${rawShops.length - shops.length} shop bị loại khi đọc file (schema cũ/lỗi)`,
      );
    }
    return { ...DEFAULT_CHANNEL_SETTINGS, ...parsed, shops };
  } catch (error: any) {
    logOAuthSaveError("loadChannelSettings", error);
    return { ...DEFAULT_CHANNEL_SETTINGS, shops: [] };
  }
}

function saveChannelSettings(settings: Record<string, any>): boolean {
  try {
    ensureDataDirs();
    const onDisk = loadChannelSettings();
    const incoming = Array.isArray(settings?.shops) ? settings.shops : [];
    const shops = upsertShopsInChannelSettings(onDisk.shops || [], incoming);
    const payload = { ...DEFAULT_CHANNEL_SETTINGS, ...onDisk, ...settings, shops };
    fs.writeFileSync(CHANNEL_SETTINGS_PATH, JSON.stringify(payload, null, 2), "utf-8");
    console.log(
      `[Channel Settings] UPSERT ${shops.length} shop(s) → ${CHANNEL_SETTINGS_PATH}`,
      shops.map((s) => s.shopId).join(", "),
    );
    return true;
  } catch (error: any) {
    logOAuthSaveError("saveChannelSettings", error);
    return false;
  }
}

/** Sau OAuth — UPSERT shop theo shop_id, giữ tên/API key người dùng đã nhập. */
function syncOAuthShopsToChannelSettings(
  savedShopIds: string[],
  opts?: { expectedShopId?: string },
): void {
  if (!savedShopIds.length && !opts?.expectedShopId) return;
  try {
    const settings = loadChannelSettings();
    const now = new Date().toISOString();
    const incoming: Record<string, any>[] = [];

    const ids = new Set<string>(savedShopIds.map((id) => normalizeShopIdKey(id)).filter(Boolean));
    const expected = normalizeShopIdKey(opts?.expectedShopId);
    if (expected) ids.add(expected);

    for (const key of ids) {
      incoming.push({
        platform: "shopee",
        shopId: key,
        shopName: `Shopee ${key}`,
        apiKey: SHOPEE_PARTNER_ID || "oauth",
        connected: savedShopIds.some((id) => normalizeShopIdKey(id) === key),
        lastSynced: now,
        id: `shop-shopee-${key}`,
      });
    }

    const shops = upsertShopsInChannelSettings(settings.shops || [], incoming);
    if (!saveChannelSettings({ ...settings, shops })) {
      console.error("[Shopee OAuth] syncOAuthShopsToChannelSettings: ghi channel_settings.json thất bại");
      return;
    }

    const verify = loadChannelSettings();
    const verifyIds = (verify.shops || []).map((s: any) => String(s.shopId));
    for (const key of ids) {
      if (!verifyIds.includes(key)) {
        console.error(`[Shopee OAuth] UPSERT xong nhưng shop_id=${key} KHÔNG có trong file sau khi đọc lại`);
      }
    }
  } catch (error: any) {
    logOAuthSaveError("syncOAuthShopsToChannelSettings", error);
  }
}

const IMPORTS_DB_PATH = path.join(APP_ROOT, "data", "imports.json");

function loadImports(): any[] {
  try {
    if (!fs.existsSync(IMPORTS_DB_PATH)) return [];
    const raw = fs.readFileSync(IMPORTS_DB_PATH, "utf-8");
    const parsed = raw.trim() ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error("[Imports DB] Failed to read imports.json:", error);
    return [];
  }
}

function saveImports(imports: any[]): void {
  try {
    fs.mkdirSync(path.dirname(IMPORTS_DB_PATH), { recursive: true });
    fs.writeFileSync(IMPORTS_DB_PATH, JSON.stringify(imports, null, 2), "utf-8");
  } catch (error) {
    console.error("[Imports DB] Failed to write imports.json:", error);
  }
}

const EXPENSES_DB_PATH = path.join(APP_ROOT, "data", "expenses.json");
const EXPENSES_CLEAR_MARKER = path.join(APP_ROOT, "data", ".expenses-cleared-v2");

function loadExpenses(): any[] {
  try {
    if (!fs.existsSync(EXPENSES_DB_PATH)) return [];
    const raw = fs.readFileSync(EXPENSES_DB_PATH, "utf-8");
    const parsed = raw.trim() ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error("[Expenses DB] Failed to read expenses.json:", error);
    return [];
  }
}

function saveExpenses(expenses: any[]): void {
  try {
    fs.mkdirSync(path.dirname(EXPENSES_DB_PATH), { recursive: true });
    fs.writeFileSync(EXPENSES_DB_PATH, JSON.stringify(expenses, null, 2), "utf-8");
  } catch (error) {
    console.error("[Expenses DB] Failed to write expenses.json:", error);
  }
}

function migrateExpensesStorageOnce(): void {
  if (fs.existsSync(EXPENSES_CLEAR_MARKER)) return;
  saveExpenses([]);
  try {
    fs.mkdirSync(path.dirname(EXPENSES_CLEAR_MARKER), { recursive: true });
    fs.writeFileSync(EXPENSES_CLEAR_MARKER, new Date().toISOString(), "utf-8");
    console.log("[Expenses] Đã xóa sạch dữ liệu chi phí cũ (migration một lần).");
  } catch (error) {
    console.error("[Expenses] Failed to write clear marker:", error);
  }
}

migrateExpensesStorageOnce();

function applyBulkProductUpdate(
  product: any,
  opts: { stock?: { mode: string; value: number }; price?: { mode: string; value: number } }
): any {
  let stock = Number(product.stock) || 0;
  let sellingPrice = Number(product.sellingPrice) || 0;

  if (opts.stock) {
    const v = Number(opts.stock.value) || 0;
    if (opts.stock.mode === "set") stock = v;
    else if (opts.stock.mode === "delta") stock = stock + v;
    else if (opts.stock.mode === "increase") stock = stock + v;
    else if (opts.stock.mode === "decrease") stock = stock - v;
  }

  if (opts.price) {
    const v = Number(opts.price.value) || 0;
    switch (opts.price.mode) {
      case "set":
        sellingPrice = v;
        break;
      case "percent_up":
        sellingPrice = Math.round(sellingPrice * (1 + v / 100));
        break;
      case "percent_down":
        sellingPrice = Math.round(sellingPrice * (1 - v / 100));
        break;
      case "fixed_up":
        sellingPrice = sellingPrice + v;
        break;
      case "fixed_down":
        sellingPrice = Math.max(Number(product.importPrice) || 0, sellingPrice - v);
        break;
    }
  }

  stock = Math.max(0, Math.round(stock));
  sellingPrice = Math.max(0, Math.round(sellingPrice));

  return {
    ...product,
    stock,
    sellingPrice,
    status: stock <= 0 ? "out_of_stock" : product.status === "draft" ? "draft" : "active",
    lastSynced: new Date().toISOString(),
  };
}

function mergeProductPatch(product: any, patch: any): any {
  const merged = { ...product };
  if (patch.title !== undefined) merged.title = String(patch.title);
  if (patch.sku !== undefined) merged.sku = String(patch.sku);
  if (patch.stock !== undefined) merged.stock = Math.max(0, Math.round(Number(patch.stock)));
  if (patch.sellingPrice !== undefined) merged.sellingPrice = Math.max(0, Math.round(Number(patch.sellingPrice)));
  if (patch.wholesalePrice !== undefined) merged.wholesalePrice = Math.max(0, Math.round(Number(patch.wholesalePrice)));
  if (patch.importPrice !== undefined) merged.importPrice = Math.max(0, Math.round(Number(patch.importPrice)));
  if (patch.weight !== undefined) merged.weight = Math.max(0, Number(patch.weight));
  if (patch.brand !== undefined) merged.brand = String(patch.brand);
  if (patch.supplierId !== undefined) merged.supplierId = patch.supplierId ? String(patch.supplierId) : undefined;
  if (patch.barcode !== undefined) merged.barcode = String(patch.barcode);
  if (patch.stockMin !== undefined) merged.stockMin = Math.max(0, Math.round(Number(patch.stockMin)));
  if (patch.stockMax !== undefined) merged.stockMax = Math.max(0, Math.round(Number(patch.stockMax)));
  if (patch.description !== undefined) merged.description = String(patch.description);
  if (patch.category !== undefined) merged.category = String(patch.category);
  if (patch.unit !== undefined) merged.unit = String(patch.unit).trim();
  if (patch.status !== undefined) merged.status = patch.status;
  if (patch.channels !== undefined && Array.isArray(patch.channels)) merged.channels = patch.channels;
  if (patch.shopeeId !== undefined) merged.shopeeId = patch.shopeeId ? String(patch.shopeeId) : undefined;
  if (patch.shopeeItemId !== undefined) merged.shopeeItemId = patch.shopeeItemId ? String(patch.shopeeItemId) : undefined;
  if (patch.shopeeModelId !== undefined) merged.shopeeModelId = patch.shopeeModelId ? String(patch.shopeeModelId) : undefined;
  if (patch.tiktokId !== undefined) merged.tiktokId = patch.tiktokId ? String(patch.tiktokId) : undefined;
  if (patch.wooId !== undefined) merged.wooId = patch.wooId ? String(patch.wooId) : undefined;
  if (merged.stock <= 0 && merged.status !== "draft") merged.status = "out_of_stock";
  else if (merged.stock > 0 && merged.status === "out_of_stock") merged.status = "active";
  merged.lastSynced = new Date().toISOString();
  return merged;
}

// Some orders inserted purely from an older buggy webhook normalization never
// got a shop_id recorded (see normalizeShopeeOrder fix above). Self-heal them
// on read: if the order itself lacks shop_id but exactly one Shopee shop is
// connected in this project, that's unambiguously the right shop — use it
// instead of letting a missing field wrongly block real ship_order/print calls.
function resolveOrderShopId(order: any): string | undefined {
  if (order?.shopId) return normalizeShopIdKey(order.shopId) || undefined;
  if (order?.channel !== "shopee") return undefined;
  const shopIds = listShopeeOAuthShopIds();
  return shopIds.length === 1 ? shopIds[0] : undefined;
}

/** Kiểm tra shopId đơn có khớp token OAuth — không tự sửa/migrate hàng loạt. */
function validateOrderShopForShipment(order: any): {
  ok: boolean;
  shopId?: string;
  error?: string;
  message?: string;
} {
  if (order?.channel !== "shopee") {
    return { ok: true, shopId: resolveOrderShopId(order) };
  }

  const oauthShops = listShopeeOAuthShopIds();
  const stored = order?.shopId ? normalizeShopIdKey(order.shopId) : "";

  if (!stored) {
    if (oauthShops.length === 1) {
      return { ok: true, shopId: oauthShops[0] };
    }
    return {
      ok: false,
      error: "missing_shop_id",
      message: "Đơn hàng thiếu shop_id, không xác định được shop Shopee.",
    };
  }

  const tokens = loadShopeeTokens();
  if (getShopeeTokenRecord(tokens, stored)) {
    return { ok: true, shopId: stored };
  }

  console.warn(
    `[Shopee Ship] shopId lệch — đơn ${order.orderSn || order.id}: shopId=${stored}, token OAuth=[${oauthShops.join(", ")}] — bỏ qua, không gọi Shopee`,
  );
  return {
    ok: false,
    error: "shop_id_mismatch",
    message: "Đơn hàng thuộc Shop khác, không thể thao tác.",
  };
}

// Resolve an order row by internal id OR Shopee order_sn (bulk UI may send either).
function findOrderRecord(orders: any[], idOrSn: string): { index: number; order: any } | null {
  const key = String(idOrSn || "").trim();
  if (!key) return null;
  const idx = getOrderLookupIndex(orders);
  const normalized = normalizeOrderIndexKey(key);
  let index =
    idx.byId.get(normalized) ??
    idx.byOrderSn.get(normalized);
  if (index === undefined && !key.startsWith("shopee-")) {
    index = idx.byId.get(normalizeOrderIndexKey(`shopee-${key}`));
  }
  if (index === undefined) return null;
  return { index, order: orders[index] };
}

// Build a de-duplicated list of orders to ship from orderIds and/or orderSns arrays.
function resolveOrdersFromRequest(orders: any[], orderIds?: string[], orderSns?: string[]): { index: number; order: any }[] {
  const hits: { index: number; order: any }[] = [];
  const seen = new Set<number>();
  const tryAdd = (idOrSn: string) => {
    const hit = findOrderRecord(orders, idOrSn);
    if (hit && !seen.has(hit.index)) {
      seen.add(hit.index);
      hits.push(hit);
    }
  };
  for (const id of orderIds || []) tryAdd(String(id));
  for (const sn of orderSns || []) tryAdd(String(sn));
  return hits;
}

// Shopee sometimes returns an "already shipped" style error when ship_order is
// retried on an order that was actually prepared earlier — treat as success so
// bulk runs don't report 0/N for orders that are already on Shopee's side.
function isAlreadyShippedError(result: any): boolean {
  const blob = `${result?.error || ""} ${result?.message || ""}`.toLowerCase();
  return blob.includes("already") || blob.includes("has been shipped") || blob.includes("logistics order is completed");
}

type ShipOrderJobStatus = "pending" | "running" | "printing" | "done" | "failed";

type ShipOrderJob = {
  id: string;
  status: ShipOrderJobStatus;
  total: number;
  completed: number;
  successCount: number;
  results: any[];
  printDocument: any | null;
  orders: any[] | null;
  error?: string;
  createdAt: number;
  updatedAt: number;
};

const shipOrderJobs = new Map<string, ShipOrderJob>();
const SHIP_JOB_TTL_MS = 30 * 60 * 1000;

type OrderSyncJobStatus = "pending" | "running" | "done" | "failed";

type OrderSyncJob = {
  id: string;
  status: OrderSyncJobStatus;
  total: number;
  completed: number;
  synced: number;
  added: number;
  updated: number;
  message: string;
  errors?: any[];
  uiStatusCounts?: Record<string, number>;
  warning?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
};

const orderSyncJobs = new Map<string, OrderSyncJob>();
const ORDER_SYNC_JOB_TTL_MS = 30 * 60 * 1000;
let activeOrderSyncJobId: string | null = null;

function createOrderSyncJobId(): string {
  return `sync-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function pruneOldOrderSyncJobs(): void {
  const cutoff = Date.now() - ORDER_SYNC_JOB_TTL_MS;
  for (const [id, job] of orderSyncJobs) {
    if (job.updatedAt < cutoff) {
      orderSyncJobs.delete(id);
      if (activeOrderSyncJobId === id) activeOrderSyncJobId = null;
    }
  }
}

function getRunningOrderSyncJob(): OrderSyncJob | null {
  if (!activeOrderSyncJobId) return null;
  const job = orderSyncJobs.get(activeOrderSyncJobId);
  if (!job || job.status === "done" || job.status === "failed") return null;
  return job;
}

function createShipOrderJobId(): string {
  return `ship-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function pruneOldShipOrderJobs(): void {
  const cutoff = Date.now() - SHIP_JOB_TTL_MS;
  for (const [id, job] of shipOrderJobs) {
    if (job.updatedAt < cutoff) shipOrderJobs.delete(id);
  }
}

// Broken/mock orders (0đ total AND no items) or ghost webhook rows with no
// real product snapshot — leftovers from older test/config attempts.
function isValidOrder(order: any): boolean {
  const hasAmount = Number(order?.totalAmount) > 0;
  const hasItems = Array.isArray(order?.items) && order.items.length > 0;
  if (!hasAmount && !hasItems) return false;
  const sn = String(order?.orderSn || "");
  if (sn.startsWith("260709") && !hasItems && Number(order?.totalAmount) === 0) return false;
  return true;
}

// Normalize a raw Shopee push-notification payload into this project's Order shape.
// IMPORTANT: Shopee's push envelope is { shop_id, code, timestamp, data: {...} } —
// `shop_id` lives at the TOP LEVEL, sibling to `data`, never inside `data` itself.
// Reading `data.shop_id` (the inner object) always returns undefined and was the
// root cause of orders silently losing their shop_id in the local database.
function normalizeShopeeOrder(payload: any): any | null {
  const data = payload?.data || payload || {};
  const orderSn = data.ordersn || data.order_sn || data.orderSn;
  if (!orderSn) return null;
  const shopId = payload?.shop_id ?? data.shop_id;

  const rawStatus = String(data.status || data.order_status || "READY_TO_SHIP").toUpperCase();
  const itemList = Array.isArray(data.item_list) ? data.item_list : [];
  const mappedItems = itemList.length
    ? itemList.map((it: any) => mapShopeeOrderLineItem(it)).filter(Boolean)
    : [];

  const order: any = {
    id: `shopee-${orderSn}`,
    orderSn: String(orderSn),
    channel: "shopee",
    shopId: shopId ? String(shopId) : undefined,
    shopName: resolveConnectedShopDisplayName(shopId, data.shop_name) || (shopId ? `Shop ${shopId}` : "Gian hàng"),
    totalAmount: Number(data.total_amount || 0),
    withholdingCitTax: 0,
    withholding_cit_tax: 0,
    revenue: 0,
    status: SHOPEE_ORDER_STATUS_MAP[rawStatus] || "unprocessed",
    date: data.create_time ? new Date(data.create_time * 1000).toISOString() : new Date().toISOString(),
    packageNumber: data.package_number || undefined,
    isPrepared: false,
    isPrinted: false,
    items: mappedItems,
  };
  if (itemList.length > 0) {
    applyShopeePartialCancelMeta(order, data, mappedItems);
  }
  applyShopeeOrderFinanceFields(order, {
    totalAmount: order.totalAmount,
    withholdingCitTax: extractShopeeWithholdingCitTax(data),
  });
  const rawTrack = data.tracking_no || data.tracking_number;
  if (rawTrack) applyShopeeTrackingCode(order, rawTrack);
  repairMisassignedTracking(order);
  return order;
}

async function processShopeeWebhookPayload(body: any): Promise<void> {
  try {
    const normalized = normalizeShopeeOrder(body);
    if (!normalized) return;

    const orders = loadOrders();
    const existingIndex = orders.findIndex((o: any) => o.orderSn === normalized.orderSn);
    const existing = existingIndex >= 0 ? orders[existingIndex] : undefined;
    if (normalized.partialCancel) {
      await restoreLocalStockForPartialCancel(normalized.shopId || existing?.shopId, existing, normalized);
    }
    if (existingIndex >= 0) {
      orders[existingIndex] = mergeShopeeOrderOnSync(existing, normalized);
    } else {
      orders.unshift(normalized);
    }
    saveOrders(orders);
    console.log(`[Shopee Webhook] Order ${normalized.orderSn} upserted into local orders database.`);
  } catch (error) {
    console.error("[Shopee Webhook] Async processing error:", error);
  }
}

const authMiddleware = (req: any, res: any, next: any) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ success: false, error: "Yêu cầu cung cấp Token xác thực hợp lệ.", message: "Yêu cầu cung cấp Token xác thực hợp lệ." });
  }
  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ success: false, error: "Token không hợp lệ hoặc đã hết hạn.", message: "Token không hợp lệ hoặc đã hết hạn." });
  }
};

async function startServer() {
  const app = express();
  const PORT = process.env.PORT || 3000;
  const appWithRouteMethods = app as any;
  for (const method of ["get", "post", "put", "patch", "delete"] as const) {
    const registerRoute = appWithRouteMethods[method].bind(app);
    appWithRouteMethods[method] = (routePath: unknown, ...handlers: any[]) => {
      if (typeof routePath !== "string" || !routePath.startsWith("/api/")) {
        return registerRoute(routePath, ...handlers);
      }
      return registerRoute(
        routePath,
        ...handlers.map((handler) => {
          if (typeof handler !== "function" || handler.length === 4) return handler;
          return (req: any, res: any, next: any) => {
            try {
              return Promise.resolve(handler(req, res, next)).catch((err: unknown) => {
                if (res.headersSent) return next(err);
                return sendStrictApiErrorJson(res, err);
              });
            } catch (err: unknown) {
              if (res.headersSent) return next(err);
              return sendStrictApiErrorJson(res, err);
            }
          };
        })
      );
    };
  }

  app.use((req, res, next) => {
    const origin = req.headers.origin as string | undefined;
    const allowedOrigin =
      origin &&
      (/^https:\/\/([a-z0-9-]+\.)*vercel\.app$/i.test(origin) ||
        /^https:\/\/([a-z0-9-]+\.)*linhkienamthanh\.net$/i.test(origin) ||
        /^http:\/\/localhost(:\d+)?$/i.test(origin));
    if (allowedOrigin) {
      res.setHeader('Access-Control-Allow-Origin', origin!);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }
    next();
  });

  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));

  /** DB chưa sẵn sàng → trả 503 NGAY (sync, không await/chờ). Auth/health/oauth/ship-order vẫn chạy. */
  app.use((req, res, next) => {
    const pathName = String(req.path || req.originalUrl || "").split("?")[0];
    if (!pathName.startsWith("/api/")) return next();
    const allowWithoutDb =
      pathName === "/api/login" ||
      pathName.startsWith("/api/health") ||
      pathName.startsWith("/api/auth/") ||
      pathName === "/api/shopee/callback" ||
      pathName === "/api/shopee/oauth/complete" ||
      pathName === "/api/shopee/webhook" ||
      pathName.startsWith("/api/public/") ||
      pathName.startsWith("/api/shopee/ship-order") ||
      pathName === "/api/shopee/print-document";
    if (allowWithoutDb) return next();
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({
        success: false,
        message: "Database đang kết nối, vui lòng thử lại sau",
        error: "database_connecting",
        readyState: mongoose.connection.readyState,
      });
    }
    return next();
  });

  app.post("/api/login", (req, res) => {
    const { username, password } = req.body;
    const expectedUsername = process.env.ADMIN_USERNAME || "admin";
    const expectedPassword = process.env.ADMIN_PASSWORD || "password123";
    if (username === expectedUsername && password === expectedPassword) {
      const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: "24h" });
      return res.json({ token, username });
    } else {
      return res.status(401).json({ error: "T\xEAn \u0111\u0103ng nh\u1EADp ho\u1EB7c m\u1EADt kh\u1EA9u kh\xF4ng ch\xEDnh x\xE1c." });
    }
  });

  app.get("/api/auth/verify", authMiddleware, async (req: any, res) => {
    res.json({ valid: true, username: req.user.username });
  });

  app.get("/api/config/public", (_req, res) => {
    res.json({
      appUrl: APP_BASE_URL,
      apiBaseUrl: APP_BASE_URL,
      shopeeCallbackUrl: SHOPEE_CALLBACK_URL,
      shopeeWebhookUrl: SHOPEE_WEBHOOK_URL,
    });
  });

  app.get("/api/health", (_req, res) => {
    const shopIds = listShopeeOAuthShopIds();
    let dataDirWritable = false;
    try {
      ensureDataDirs();
      fs.accessSync(path.join(APP_ROOT, "data"), fs.constants.W_OK);
      dataDirWritable = true;
    } catch {
      dataDirWritable = false;
    }
    res.status(200).json({
      ok: true,
      service: "cpanel-backend",
      host: APP_BASE_URL,
      appRoot: APP_ROOT,
      tokensPath: SHOPEE_TOKENS_PATH,
      tokensFileExists: fs.existsSync(SHOPEE_TOKENS_PATH),
      dataDirWritable,
      shopeeOAuthShopIds: shopIds,
      lastOAuth: loadLastOAuthAudit(),
      oauthHint:
        shopIds.length > 0
          ? "Vào Cài đặt → shop Shopee → bấm OAuth (shop_id phải khớp). Sau OAuth kiểm tra lastOAuth.success=true."
          : "Chưa có shop OAuth — bấm nút OAuth trong Cài đặt.",
      checkedAt: new Date().toISOString(),
      routes: {
        mappingProducts: true,
      },
    });
  });

  // ─── Mapping products — ĐẶT SỚM, TRƯỚC static / SPA catch-all ───
  const handleMappingProductsGet = async (_req: any, res: any) => {
    try {
      // BẮT BUỘC đọc TRỰC TIẾP từ MongoDB — không dùng cache/mảng RAM sau restart.
      const cache = await reloadCachesFromDb();
      const rawListings = cache.listings;
      const listings = enrichChannelListingsWithMaster(rawListings, cache.products);
      const successWithProduct = listings.filter(
        (l) =>
          l?.status === "success" &&
          l?.linkedProduct &&
          (l?.linkedProductTitle || l?.linkedProductSku || l?.linkedProduct?.title)
      ).length;
      const broken = listings.filter((l) => l?.linkBroken).length;
      console.log(
        `[Mapping Products] GET db — ${listings.length} dòng (success+product=${successWithProduct}, broken=${broken}) mongo=${isMongoReady()}`
      );
      return res.status(200).json({
        success: true,
        listings,
        count: listings.length,
        cacheUpdatedAt: cache.updatedAt,
        source: isMongoReady() ? "mongodb" : "json_fallback",
      });
    } catch (error: any) {
      console.error("[Mapping Products] GET lỗi:", error?.message || error);
      // Thử lại truy vấn MongoDB một lần — không fallback sang mảng RAM.
      try {
        const raw = await readChannelListingsForGet();
        const safe = (Array.isArray(raw) ? raw : []).map((r) => sanitizeChannelListingRow(r));
        return res.status(200).json({
          success: true,
          listings: safe,
          count: safe.length,
          source: "mongodb_retry",
          message: error?.message || String(error),
        });
      } catch (fallbackErr: any) {
        return res.status(500).json({
          success: false,
          error: fallbackErr?.message || error?.message || String(error),
        });
      }
    }
  };

  const handleMappingProductsUpsert = async (req: any, res: any) => {
    try {
      const incoming = req.body?.listings;
      if (!Array.isArray(incoming)) {
        return res.status(400).json({
          success: false,
          message: "Thiếu mảng listings trong request body.",
          hint: "PUT/POST /api/mapping-products cần body { listings: [...] }. Liên kết tự động dùng POST /api/shopee/channel-products/auto-link (không cần listings).",
        });
      }
      console.log(`[Mapping Save] UPSERT nhận ${incoming.length} dòng (${req.method})`);
      const sanitized = incoming.map((row: any) => sanitizeChannelListingRow(row));
      for (const listing of sanitized) {
        await upsertChannelListingToStore(listing);
      }
      await flushDbWrites();
      const cache = await refreshCache();
      console.log(`Đã lưu DB thành công — mapping upsert ${sanitized.length} dòng + refreshCache`);
      const verified = enrichChannelListingsWithMaster(cache.listings, cache.products);
      return res.status(200).json({
        success: true,
        count: verified.length,
        listings: verified,
        cacheUpdatedAt: cache.updatedAt,
        source: isMongoReady() ? "mongodb" : "json_fallback",
      });
    } catch (error: any) {
      const errMsg = error?.message || String(error);
      console.error("[Mapping Save] UPSERT lỗi:", errMsg);
      return res.status(500).json({
        success: false,
        message: `Lỗi lưu Database: ${errMsg}`,
        error: errMsg,
      });
    }
  };

  /** Heal chủ động — tách biệt hoàn toàn khỏi GET (không auto-ghi trên đọc). */
  const handleMappingProductsHeal = async (_req: any, res: any) => {
    try {
      const products = await loadProducts();
      const enriched = enrichChannelListingsWithMaster(await readChannelListingsDb(), products);
      const healed = await persistHealedBrokenMappingLinks(enriched);
      const listings = enrichChannelListingsWithMaster(await readChannelListingsDb(), products);
      console.log(`[Mapping Products] HEAL xong: healed=${healed}, total=${listings.length}`);
      return res.status(200).json({
        success: true,
        healed,
        count: listings.length,
        listings,
      });
    } catch (error: any) {
      const errMsg = error?.message || String(error);
      console.error("[Mapping Products] HEAL lỗi:", errMsg);
      return res.status(500).json({
        success: false,
        message: `Lỗi heal Database: ${errMsg}`,
        error: errMsg,
      });
    }
  };

  // Batch Auto-link — mọi thao tác đọc file và DB nằm trong try/catch của API.
  const handleBatchAutoLink = async (req: any, res: any) => {
    try {
      const body = req?.body && typeof req.body === "object" ? req.body : {};
      const result = await batchAutoLinkFromDatabase({
        cursor: body.cursor,
        limit: body.limit,
      });
      const data = {
        linkedCount: result.linkedCount,
        alreadyLinked: result.alreadyLinked,
        unlinkedRemaining: result.unlinkedRemaining,
        listings: result.listings,
        cacheUpdatedAt: result.cacheUpdatedAt,
        masterProductCount: result.masterProductCount,
        skuIndexSize: result.skuIndexSize,
        scannedCount: result.scannedCount,
        limit: result.requestedLimit,
        nextCursor: result.nextCursor,
        hasMore: result.hasMore,
        source: "database",
      };
      console.log(
        `Đã lưu DB thành công — batch-auto-link linked=${result.linkedCount}, scanned=${result.scannedCount}, remaining=${result.unlinkedRemaining}, nextCursor=${result.nextCursor}`
      );
      return res.status(200).json({
        success: true,
        data,
        message:
          result.linkedCount > 0
            ? `Đã liên kết thành công ${result.linkedCount} sản phẩm`
            : "Không tìm thấy SKU trùng khớp trong Database hiện tại",
        ...data,
      });
    } catch (error: unknown) {
      console.error("[Batch Auto-link] Exception:", error);
      if (!res.headersSent) {
        const message = error instanceof Error ? error.message : String(error);
        return res.status(500).json({ success: false, error: message });
      }
    }
  };
  const handleSingleAutoLink = async (req: any, res: any) => {
    try {
      const body = req?.body && typeof req.body === "object" ? req.body : {};
      const result = await autoLinkSingleListingFromDatabase({
        id: body.id,
        listingId: body.listingId,
        channelId: body.channelId,
        platform: body.platform,
      });

      return res.status(200).json({
        success: result.success,
        listing: result.listing,
        matchedProductId: result.matchedProductId,
        message: result.message,
      });
    } catch (error: unknown) {
      console.error("[Auto-link Single] Exception:", error);
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ success: false, error: message });
    }
  };
  app.post("/api/mapping-products/auto-link-single", authMiddleware, handleSingleAutoLink);
  app.post("/api/mapping-products/batch-auto-link", authMiddleware, handleBatchAutoLink);

  // BẮT BUỘC: đăng ký purge-broken (MongoDB channel_listings).
  app.post("/api/mapping-products/purge-broken", authMiddleware, async (_req, res) => {
    try {
      // 1) Tìm kiếm: mapping linkedProduct null/undefined hoặc ID không còn trong Kho gốc
      const cache = await loadLocalInventoryCache();
      const listings =
        Array.isArray(cache.listings) && cache.listings.length > 0
          ? cache.listings
          : await readChannelListingsDb();
      const masterLookup = buildMasterProductLookupById(cache.products);
      const kept: any[] = [];
      let deletedCount = 0;

      for (const row of Array.isArray(listings) ? listings : []) {
        if (!row || typeof row !== "object") {
          deletedCount += 1;
          continue;
        }

        const linkedId =
          row?.linkedProductId != null && String(row.linkedProductId).trim() !== ""
            ? String(row.linkedProductId).trim()
            : row?.linkedProduct?.id != null && String(row.linkedProduct.id).trim() !== ""
              ? String(row.linkedProduct.id).trim()
              : "";

        const linkedProductMissing =
          row?.linkedProduct == null ||
          typeof row.linkedProduct !== "object" ||
          row?.linkedProduct?.id == null ||
          String(row.linkedProduct.id).trim() === "";

        const claimsLink = row?.status === "success" || linkedId !== "";
        const isBroken =
          claimsLink &&
          ((!linkedId && linkedProductMissing) || (linkedId !== "" && !masterLookup.has(linkedId)));

        if (isBroken) {
          deletedCount += 1;
          continue;
        }

        kept.push(row);
      }

      if (deletedCount > 0) {
        await writeChannelListingsDb(kept);
      }
      const nextCache = await refreshCache();

      return res.json({
        success: true,
        deletedCount,
        cacheUpdatedAt: nextCache.updatedAt,
      });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        message: error?.message || String(error),
      });
    }
  });
  app.post("/api/mapping-products/heal", authMiddleware, handleMappingProductsHeal);
  app.get("/api/mapping-products", authMiddleware, handleMappingProductsGet);
  app.put("/api/mapping-products", authMiddleware, handleMappingProductsUpsert);
  app.post("/api/mapping-products", authMiddleware, handleMappingProductsUpsert);

    // PDF vận đơn — public (tab in mới không gửi Bearer). LiteSpeed thường chặn /labels/* trước Node;
    // route /api/public/labels/* luôn vào Express.
    app.get("/api/public/labels/:filename", (req, res) => {
      const result = serveLabelPdfFromDisk(req.params.filename, res);
      if (result === "not_found") {
        res.status(404).type("text/plain").send("Không tìm thấy file vận đơn.");
      }
    });

    app.get("/api/labels/:filename", (req, res) => {
      const result = serveLabelPdfFromDisk(req.params.filename, res);
      if (result === "not_found") {
        res.status(404).type("text/plain").send("Không tìm thấy file vận đơn.");
      }
    });

    function logShopeeIngress(prefix: string, req: any) {
    console.log(
      prefix,
      JSON.stringify({
        at: new Date().toISOString(),
        method: req.method,
        url: req.url,
        query: req.query || {},
        headers: req.headers || {},
        body: req.body ?? null,
      }),
    );
  }

  // Shopee Open Platform OAuth redirect callback.
  // Register in Shopee Partner App Settings: SHOPEE_CALLBACK_URL (domain quanly.linhkienamthanh.net)
  app.get("/api/shopee/oauth/complete", async (req, res) => {
    console.log("DEBUG RAW RESPONSE:", JSON.stringify(req.query));
    logShopeeIngress("[Shopee OAuth Complete]", req);
    const code = queryParamOne(req.query.code);
    const shopIdRaw = queryParamOne(req.query.shop_id);
    const mainAccountIdRaw = queryParamOne(req.query.main_account_id);
    const expectedShop = queryParamOne(req.query.expected_shop);

    console.log(
      "[Shopee OAuth Complete] REQUEST (Vercel proxy JSON)",
      JSON.stringify({
        code_present: Boolean(code),
        shop_id_raw: shopIdRaw || null,
        main_account_id_raw: mainAccountIdRaw || null,
        expected_shop: expectedShop || null,
        SHOPEE_TOKENS_PATH,
      }),
    );

    if (!code || (!shopIdRaw && !mainAccountIdRaw)) {
      return res.status(200).type("text/plain; charset=utf-8").send(SHOPEE_CALLBACK_IDLE_MSG);
    }

    try {
      const result = await completeShopeeOAuthFlow(code, {
        shopIdRaw: shopIdRaw || undefined,
        mainAccountIdRaw: mainAccountIdRaw || undefined,
        expectedShopId: expectedShop || undefined,
      });
      console.log("[Shopee OAuth Complete] KẾT QUẢ", JSON.stringify(result));
      return res.status(result.success ? 200 : 400).json({
        ...result,
        message: result.success
          ? `OAuth thành công. Token đã lưu cho shop ${result.oauth_shop_id}.`
          : result.message || result.error || "OAuth thất bại",
        tokens_path: SHOPEE_TOKENS_PATH,
      });
    } catch (error: any) {
      logOAuthSaveError("Shopee OAuth Complete", error);
      return res.status(500).json({
        success: false,
        error: error?.message || "unknown_error",
      });
    }
  });

  app.get("/api/shopee/callback", async (req, res) => {
    console.log("DEBUG RAW RESPONSE:", JSON.stringify(req.query));
    logShopeeIngress("[Shopee Callback]", req);
    const code = queryParamOne(req.query.code);
    const shopIdRaw = queryParamOne(req.query.shop_id);
    const mainAccountIdRaw = queryParamOne(req.query.main_account_id);
    const expectedShop = queryParamOne(req.query.expected_shop);

    console.log(
      "[Shopee Callback] REQUEST NHẬN ĐƯỢC",
      JSON.stringify({
        at: new Date().toISOString(),
        method: req.method,
        url: req.url,
        code_present: Boolean(code),
        code_length: code.length,
        shop_id_raw: shopIdRaw || null,
        main_account_id_raw: mainAccountIdRaw || null,
        expected_shop: expectedShop || null,
        query: req.query || {},
        SHOPEE_TOKENS_PATH,
        SHOPEE_CALLBACK_URL,
        APP_ROOT,
        cwd: process.cwd(),
      }),
    );

    if (!code || (!shopIdRaw && !mainAccountIdRaw)) {
      console.log("[Shopee Callback] Truy cập trực tiếp — thiếu code/shop_id");
      return res.status(200).type("text/plain; charset=utf-8").send(SHOPEE_CALLBACK_IDLE_MSG);
    }

    const oauthShopId = normalizeShopIdKey(shopIdRaw);
    const mainAccountId = normalizeShopIdKey(mainAccountIdRaw);
    if (!oauthShopId && !mainAccountId) {
      console.error(`[Shopee Callback] shop_id/main_account_id không hợp lệ: shop_id=${shopIdRaw}, main_account_id=${mainAccountIdRaw}`);
      return res.status(400).json({
        success: false,
        error: "invalid_shop_id",
        message: `Shop ID / Main Account ID không hợp lệ`,
        tokens_path: SHOPEE_TOKENS_PATH,
      });
    }

    try {
      const result = await completeShopeeOAuthFlow(code, {
        shopIdRaw: shopIdRaw || undefined,
        mainAccountIdRaw: mainAccountIdRaw || undefined,
        expectedShopId: expectedShop || undefined,
      });

      if (!result.success) {
        console.error(`[Shopee Callback] Đổi code thất bại:`, result.error, result.message);
        if (shouldOAuthRedirectToFrontend(req)) {
          return res.redirect(302, buildOAuthFrontendRedirectUrl(req, result));
        }
        return res.status(400).json({
          ...result,
          message: result.message || result.error || "token_exchange_failed",
          tokens_path: SHOPEE_TOKENS_PATH,
        });
      }

      console.log(
        `[Shopee Callback] OAuth OK. Token đã lưu cho: [${result.saved_shop_ids.join(", ")}]. verified=${result.verified_in_file} File: ${SHOPEE_TOKENS_PATH}`,
      );
      if (shouldOAuthRedirectToFrontend(req)) {
        return res.redirect(302, buildOAuthFrontendRedirectUrl(req, result));
      }
      return res.status(200).json({
        ...result,
        message: result.message || `OAuth thành công. Token đã lưu cho: [${result.saved_shop_ids.join(", ")}].`,
        tokens_path: SHOPEE_TOKENS_PATH,
        callback_url: SHOPEE_CALLBACK_URL,
      });
    } catch (error: any) {
      logOAuthSaveError("Shopee Callback", error);
      saveOAuthAudit({
        callback_shop_id: oauthShopId || mainAccountId || null,
        main_account_id: mainAccountId || null,
        success: false,
        error: error?.message || "unknown_error",
        tokens_path: SHOPEE_TOKENS_PATH,
        app_root: APP_ROOT,
      });
      const failResult = {
        success: false,
        error: error?.message || "unknown_error",
        message: error?.message || "Lỗi xử lý OAuth callback",
        oauth_shop_id: oauthShopId,
      };
      if (shouldOAuthRedirectToFrontend(req)) {
        return res.redirect(302, buildOAuthFrontendRedirectUrl(req, failResult));
      }
      return res.status(500).json({
        ...failResult,
        tokens_path: SHOPEE_TOKENS_PATH,
      });
    }
  });

  app.get("/api/shopee/webhook", (req, res) => {
    logShopeeIngress("[Shopee Webhook]", req);
    console.log("[Shopee Webhook] GET verification probe — 200 empty");
    res.status(200).end();
  });

  app.post("/api/shopee/webhook", (req, res) => {
    logShopeeIngress("[Shopee Webhook]", req);
    res.status(200).end();
    const payload = req.body;
    setImmediate(() => {
      void processShopeeWebhookPayload(payload)
        .then(() => {
          console.log("[Shopee Webhook] Đã xử lý và lưu payload vào database.");
        })
        .catch((error) => {
          console.error("[Shopee Webhook] Lỗi xử lý payload:", error);
        });
    });
  });

  // Real synced orders list — this is what the Order Management UI reads from.
  // --- Products warehouse API (MongoDB products) ---
  // Phân trang nhẹ — trả flat list ổn định (gom nhóm UI ở Frontend).
  const PRODUCTS_PAGE_SIZE_DEFAULT = 50;
  const PRODUCTS_PAGE_SIZE_MAX = 50;

  app.get("/api/products", authMiddleware, async (req, res) => {
    try {
      await reloadCachesFromDb();
      const all = await loadProducts();
      const rawPage = Number(req.query?.page);
      const rawSize = Number(req.query?.pageSize ?? req.query?.limit);
      const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1;
      const pageSize = Number.isFinite(rawSize) && rawSize > 0
        ? Math.min(PRODUCTS_PAGE_SIZE_MAX, Math.floor(rawSize))
        : PRODUCTS_PAGE_SIZE_DEFAULT;

      const total = all.length;
      const totalPages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)) || 1);
      const safePage = Math.min(page, totalPages);
      const start = (safePage - 1) * pageSize;
      const products = all.slice(start, start + pageSize);

      return res.status(200).json({
        success: true,
        products,
        page: safePage,
        pageSize,
        total,
        totalPages,
        hasMore: safePage < totalPages,
        grouped: false,
        source: isMongoReady() ? "mongodb" : "json_fallback",
      });
    } catch (err: unknown) {
      console.error("[Products API] GET /api/products failed:", err);
      try {
        // Fallback tối thiểu — tránh 502
        return res.status(200).json({
          success: true,
          products: [],
          page: 1,
          pageSize: PRODUCTS_PAGE_SIZE_DEFAULT,
          total: 0,
          totalPages: 1,
          hasMore: false,
          grouped: false,
          message: err instanceof Error ? err.message : "products_read_error",
        });
      } catch {
        return res.status(503).json({ success: false, error: "products_unavailable" });
      }
    }
  });

  // Đồng bộ nhanh tồn/giá lên Shopee — đăng ký SỚM (trước mọi route :id) để tránh 404.
  const handleProductSyncShopee = async (req: any, res: any) => {
    console.log("Bắt đầu đồng bộ Shopee", req.body);
    try {
      const requestedIds = Array.isArray(req.body?.productIds)
        ? req.body.productIds
        : [req.params?.id || req.body?.id || req.body?.productId];
      const productIds = [
        ...new Set(requestedIds.map((id: unknown) => String(id || "").trim()).filter(Boolean)),
      ];
      if (productIds.length === 0) {
        return res.status(400).json({
          success: false,
          error:
            "Thiếu product id. Gửi body { id }, { productId } hoặc { productIds: [...] }.",
        });
      }
      const products = await loadProducts();
      const results: Array<{
        productId: string;
        success: boolean;
        message: string;
      }> = [];

      for (const productId of productIds) {
        const row = findProductRowById(products, productId);
        if (!row) {
          results.push({
            productId,
            success: false,
            message: "Không tìm thấy sản phẩm trong kho.",
          });
          continue;
        }
        const shopee = await pushProductStockPriceToShopeeImmediate(row, {
          syncStock: true,
          syncPrice: true,
        });
        if (shopee.skipped || !shopee.ok) {
          results.push({
            productId,
            success: false,
            message:
              shopee.message ||
              (shopee.skipped
                ? "Chưa liên kết Mapping Shopee."
                : "Shopee từ chối đồng bộ tồn/giá"),
          });
          continue;
        }

        row.lastSynced = new Date().toISOString();
        results.push({
          productId,
          success: true,
          message: shopee.message,
        });
      }

      const succeeded = results.filter((result) => result.success);
      if (succeeded.length > 0) {
        await saveProducts(products);
      }
      const failed = results.filter((result) => !result.success);
      if (failed.length > 0) {
        const detail = failed
          .map((result) => `${result.productId}: ${result.message}`)
          .join(" | ");
        return res.status(400).json({
          success: false,
          message: `Shopee báo lỗi: ${detail}`,
          error: `Shopee báo lỗi: ${detail}`,
          shopeeSynced: succeeded.length > 0,
          results,
        });
      }
      return res.status(200).json({
        success: true,
        shopeeSynced: true,
        shopeeMessage: results.map((result) => result.message).join(" | "),
        message: "Đồng bộ thành công",
        results,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[Products API] sync-shopee failed:", err);
      return res.status(500).json({
        success: false,
        message: message || "Internal Server Error",
        error: message || "Internal Server Error",
      });
    }
  };
  app.post("/api/products/sync-shopee", authMiddleware, handleProductSyncShopee);
  app.post("/api/products/:id/sync-shopee", authMiddleware, handleProductSyncShopee);

  app.post("/api/products", authMiddleware, async (req, res) => {
    const body = req.body || {};
    if (!body.title || !body.sku) {
      return res.status(400).json({ error: "title_and_sku_required" });
    }
    const products = await loadProducts();
    const product = {
      id: body.id || `prod-${Date.now()}`,
      title: String(body.title),
      sku: String(body.sku),
      stock: Math.max(0, Math.round(Number(body.stock) || 0)),
      importPrice: Math.max(0, Math.round(Number(body.importPrice) || 0)),
      sellingPrice: Math.max(0, Math.round(Number(body.sellingPrice) || 0)),
      channels: Array.isArray(body.channels) ? body.channels : ["shopee"],
      category: body.category || "Chưa phân loại",
      description: body.description || "",
      imageUrl: body.imageUrl || undefined,
      status: body.status || "active",
      shopeeId: body.shopeeId,
      shopeeItemId: body.shopeeItemId,
      shopeeModelId: body.shopeeModelId,
      modelName: body.modelName,
      weight: body.weight != null ? Number(body.weight) : undefined,
      tiktokId: body.tiktokId,
      wooId: body.wooId,
      lastSynced: new Date().toISOString(),
    };
    products.unshift(product);
    // a) Lưu DB → saveProducts tự gọi await refreshCache()
    await saveProducts(products);
    const cache = await loadLocalInventoryCache();
    // b+c) Trả product + inventory từ Local Cache để UI hiển thị ngay, không reload trang tổng.
    return res.status(201).json({
      ...product,
      localInventory: cache.products,
      cacheUpdatedAt: cache.updatedAt,
    });
  });

  app.get("/api/local-inventory", authMiddleware, async (_req, res) => {
    try {
      await reloadCachesFromDb();
      const cache = await loadLocalInventoryCache();
      return res.status(200).json({
        success: true,
        updatedAt: cache.updatedAt,
        products: cache.products,
        listings: enrichChannelListingsWithMaster(cache.listings, cache.products),
        count: {
          products: cache.products.length,
          listings: cache.listings.length,
        },
        source: isMongoReady() ? "mongodb" : "json_fallback",
      });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        message: error?.message || String(error),
      });
    }
  });

  app.post("/api/local-inventory/refresh", authMiddleware, async (_req, res) => {
    try {
      const cache = await refreshCache();
      return res.status(200).json({
        success: true,
        updatedAt: cache.updatedAt,
        products: cache.products,
        listingsCount: cache.listings.length,
      });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        message: error?.message || String(error),
      });
    }
  });

  app.put("/api/products/replace", authMiddleware, async (req, res) => {
    const incoming = req.body?.products;
    if (!Array.isArray(incoming)) {
      return res.status(400).json({ error: "products_array_required" });
    }
    await saveProducts(incoming);
    return res.json({ count: incoming.length, products: incoming });
  });

  app.patch("/api/products/:id", authMiddleware, async (req, res) => {
    try {
      const products = await loadProducts();
      const patch = req.body || {};
      const topIndex = products.findIndex((p: any) => p.id === req.params.id);
      if (topIndex !== -1) {
        const before = products[topIndex];
        const merged = mergeProductPatch(before, patch);
        products[topIndex] = merged;
        await saveProducts(products);
        const changes = detectStockPriceChanges(before, merged);
        const shopee = await pushProductStockPriceToShopeeImmediate(merged, {
          syncStock: changes.stock,
          syncPrice: changes.price,
        });
        if (!shopee.ok) {
          return res.status(400).json({
            success: false,
            error: shopee.message || "Shopee từ chối cập nhật tồn/giá",
            product: merged,
            shopeeSynced: false,
            shopeeMessage: shopee.message,
          });
        }
        return res.json({
          ...merged,
          success: true,
          shopeeSynced: !shopee.skipped,
          shopeeMessage: shopee.message,
        });
      }

      // Cập nhật Child SKU nằm trong children
      for (let i = 0; i < products.length; i++) {
        const children = getProductChildrenList(products[i]);
        const childIdx = children.findIndex((c: any) => c.id === req.params.id);
        if (childIdx === -1) continue;
        const beforeChild = children[childIdx];
        const mergedChild = mergeProductPatch(beforeChild, patch);
        const nextChildren = [...children];
        nextChildren[childIdx] = mergedChild;
        const totalStock = nextChildren.reduce((s: number, c: any) => s + (Number(c.stock) || 0), 0);
        products[i] = { ...products[i], children: nextChildren, stock: totalStock };
        await saveProducts(products);
        const changes = detectStockPriceChanges(beforeChild, mergedChild);
        const shopee = await pushProductStockPriceToShopeeImmediate(mergedChild, {
          syncStock: changes.stock,
          syncPrice: changes.price,
        });
        if (!shopee.ok) {
          return res.status(400).json({
            success: false,
            error: shopee.message || "Shopee từ chối cập nhật tồn/giá",
            product: mergedChild,
            shopeeSynced: false,
            shopeeMessage: shopee.message,
          });
        }
        return res.json({
          ...mergedChild,
          success: true,
          shopeeSynced: !shopee.skipped,
          shopeeMessage: shopee.message,
        });
      }

      return res.status(404).json({ success: false, error: "product_not_found" });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[Products API] PATCH /api/products/:id failed:", err);
      return res.status(500).json({ success: false, error: message || "Internal Server Error" });
    }
  });

  app.post("/api/products/inventory-balance", authMiddleware, async (req, res) => {
    try {
      const items = req.body?.items;
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ success: false, message: "Chưa có dòng tồn kho nào để cân bằng." });
      }

      const skuStockMap = new Map<string, number>();
      for (const item of items) {
        const sku = String(item?.sku || "").trim();
        if (!sku) continue;
        const actual = Math.max(0, Math.round(Number(item.actual_stock)));
        if (!Number.isFinite(actual)) continue;
        skuStockMap.set(sku, actual);
      }

      if (skuStockMap.size === 0) {
        return res.status(400).json({ success: false, message: "Dữ liệu cân bằng kho không hợp lệ." });
      }

      const products = await loadProducts();
      let updatedCount = 0;
      const next = products.map((p: any) => {
        const children = getProductChildrenList(p);
        if (children.length > 0) {
          let changed = false;
          const nextChildren = children.map((c: any) => {
            const sku = String(c.sku || "").trim();
            if (!skuStockMap.has(sku)) return c;
            updatedCount++;
            changed = true;
            return mergeProductPatch(c, { stock: skuStockMap.get(sku) });
          });
          if (!changed) return p;
          const totalStock = nextChildren.reduce((s: number, c: any) => s + (Number(c.stock) || 0), 0);
          return { ...p, children: nextChildren, stock: totalStock };
        }
        const sku = String(p.sku || "").trim();
        if (!skuStockMap.has(sku)) return p;
        updatedCount++;
        return mergeProductPatch(p, { stock: skuStockMap.get(sku) });
      });

      if (updatedCount === 0) {
        return res.status(404).json({ success: false, message: "Không tìm thấy SKU nào trong kho gốc để cập nhật." });
      }

      const updatedProducts = flattenProductsForStockSync(next).filter((p: any) =>
        skuStockMap.has(String(p.sku || "").trim())
      );

      await saveProducts(next);
      console.log(`[Inventory Balance] Cập nhật kho gốc ${updatedCount} SKU`);

      // Đồng bộ Shopee qua hàng đợi (rate-limit) — chỉ SKU đã Mapping / có item_id.
      const queued = await enqueueShopeeStockPriceSync(updatedProducts, {
        syncStock: true,
        syncPrice: false,
      });

      const parts: string[] = [];
      parts.push("kho gốc đã cập nhật");
      if (queued > 0) {
        parts.push(`${queued} SKU đã xếp hàng đồng bộ tồn kho lên Shopee`);
      } else {
        parts.push("không có SKU Mapping Shopee để đồng bộ (hoặc chưa liên kết)");
      }

      const msg = `Cân bằng kho thành công (${parts.join(", ")}).`;
      console.log(`[Inventory Balance] ${msg}`);

      return res.status(200).json({
        success: true,
        message: msg,
        shopeeQueued: queued,
        shopeeWarnings: [],
        staleSkus: [],
      });
    } catch (err: unknown) {
      console.error("[Inventory Balance] Exception:", err);
      return sendApiErrorJson(res, err, 500);
    }
  });

  app.post("/api/sync-stock", authMiddleware, async (req, res) => {
    try {
      // Đồng bộ 1 CHIỀU: Kho gốc (Master) → Sàn. Không kéo tồn từ Sàn đè Kho gốc.
      const products = await loadProducts();
      const shopId = resolveShopeeTokenShopId(req.body?.shopId);
      const warnings: string[] = [];

      if (!isShopeeConfigValid()) {
        return res.status(400).json({
          success: false,
          message: "Shopee: cấu hình Partner chưa hợp lệ.",
        });
      }
      if (!shopId) {
        return res.status(400).json({
          success: false,
          message: "Shopee: chưa có shop được ủy quyền.",
        });
      }

      const shopeeResult = await pushStockUpdatesToShopee(products, shopId);
      if (shopeeResult.warnings?.length) warnings.push(...shopeeResult.warnings);
      if (!shopeeResult.ok && shopeeResult.errors.length > 0) {
        const onlyStale = shopeeResult.errors.every((e) => isStaleShopeeItemErrorText(e));
        if (!onlyStale) {
          const detailMsg = shopeeResult.errors.join(" | ");
          return res.status(400).json({
            success: false,
            message: `Đẩy tồn Kho gốc → Shopee thất bại: ${detailMsg}`,
            error: detailMsg,
            shopeeErrors: shopeeResult.errors,
            shopeeWarnings: warnings,
          });
        }
        warnings.push(...shopeeResult.errors);
      }

      const message =
        shopeeResult.pushed > 0
          ? `Đã đẩy ${shopeeResult.pushed} SKU từ Kho gốc lên Shopee (đồng bộ 1 chiều).`
          : "Không có SKU nào cần đẩy lên Shopee (đã khớp hoặc chưa liên kết).";

      return res.json({
        success: true,
        message,
        direction: "warehouse_to_channel",
        shopee: {
          pushed: shopeeResult.pushed,
          staleSkus: shopeeResult.staleSkus,
          warnings,
        },
        tiktok: { updated: 0, message: "TikTok Shop API chưa được tích hợp trên server." },
        warnings,
        products: await loadProducts(),
      });
    } catch (err: unknown) {
      console.error("[Sync Stock]", err);
      return sendApiErrorJson(res, err, 500);
    }
  });

  app.post("/api/products/bulk-save", authMiddleware, async (req, res) => {
    const updates = req.body?.updates;
    if (!Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({ error: "updates_required" });
    }
    const patchMap = new Map<string, any>();
    for (const u of updates) {
      if (u?.id) patchMap.set(String(u.id), u);
    }
    const products = await loadProducts();
    const beforeFlat = flattenProductsForStockSync(products);
    let updatedCount = 0;
    const changedRows: any[] = [];
    const next = products.map((p: any) => {
      const patch = patchMap.get(String(p.id));
      if (patch) {
        updatedCount++;
        patchMap.delete(String(p.id));
        const merged = mergeProductPatch(p, patch);
        const before = beforeFlat.find((b: any) => String(b.id) === String(p.id));
        const changes = detectStockPriceChanges(before || p, merged);
        if (changes.stock || changes.price) changedRows.push(merged);
        return merged;
      }

      const children = getProductChildrenList(p);
      if (children.length === 0) return p;

      let childChanged = false;
      const nextChildren = children.map((c: any) => {
        const childPatch = patchMap.get(String(c.id));
        if (!childPatch) return c;
        updatedCount++;
        patchMap.delete(String(c.id));
        childChanged = true;
        const mergedChild = mergeProductPatch(c, childPatch);
        const beforeChild = beforeFlat.find((b: any) => String(b.id) === String(c.id));
        const changes = detectStockPriceChanges(beforeChild || c, mergedChild);
        if (changes.stock || changes.price) changedRows.push(mergedChild);
        return mergedChild;
      });
      if (!childChanged) return p;

      const totalStock = nextChildren.reduce(
        (s: number, c: any) => s + (Number(c.stock) || 0),
        0
      );
      return { ...p, children: nextChildren, stock: totalStock };
    });
    await saveProducts(next);
    if (changedRows.length > 0) {
      const anyStock = changedRows.some((row) => {
        const before = beforeFlat.find((b: any) => String(b.id) === String(row.id));
        return detectStockPriceChanges(before || {}, row).stock;
      });
      const anyPrice = changedRows.some((row) => {
        const before = beforeFlat.find((b: any) => String(b.id) === String(row.id));
        return detectStockPriceChanges(before || {}, row).price;
      });
      await enqueueShopeeStockPriceSync(changedRows, { syncStock: anyStock, syncPrice: anyPrice });
    }
    return res.json({ updated: updatedCount, products: next });
  });

  app.delete("/api/products/:id", authMiddleware, async (req, res) => {
    try {
      const id = String(req.params.id);
      const products = await loadProducts();
      let found = false;
      const next: any[] = [];

      for (const p of products) {
        if (p.id === id) {
          found = true;
          continue; // xóa parent / dòng flat
        }
        const children = getProductChildrenList(p);
        if (children.length > 0) {
          const filteredChildren = children.filter((c: any) => c.id !== id);
          if (filteredChildren.length !== children.length) {
            found = true;
            if (filteredChildren.length === 0) continue; // không còn child → bỏ parent rỗng
            const totalStock = filteredChildren.reduce(
              (s: number, c: any) => s + (Number(c.stock) || 0),
              0
            );
            next.push({ ...p, children: filteredChildren, stock: totalStock });
            continue;
          }
        }
        next.push(p);
      }

      if (!found) {
        return res.status(404).json({ error: "product_not_found" });
      }
      await saveProducts(next);
      return res.json({ deleted: id, success: true });
    } catch (err: unknown) {
      console.error("[Products] DELETE failed:", err);
      return res.status(500).json({
        error: "delete_failed",
        message: err instanceof Error ? err.message : "Xóa sản phẩm thất bại",
      });
    }
  });

  app.post("/api/products/clear-all", authMiddleware, async (_req, res) => {
    await saveProducts([]);
    return res.json({ success: true, cleared: true, products: [] });
  });

  /** Xóa sạch Kho gốc + Mapping (để test sync sạch). */
  const handleInventoryClearAll = async (_req: any, res: any) => {
    try {
      await saveProducts([]);
      await writeChannelListingsDb([]);
      try {
        writeProductListingsDb([]);
      } catch {
        /* optional */
      }
      // await saveProducts([]) refresh cache trước khi mapping bị xóa; refresh lại để cache đồng bộ cả hai DB.
      await refreshCache();
      console.log("[Inventory] Đã xóa sạch Kho gốc (products) + Mapping (channel_listings).");
      return res.status(200).json({
        success: true,
        message: "Đã xóa toàn bộ Kho gốc và dữ liệu Liên kết (Mapping).",
        cleared: true,
        products: [],
        channelListings: [],
      });
    } catch (error: unknown) {
      const errObj = error instanceof Error ? error : new Error(String(error));
      console.error("[Inventory] clear-all failed:", errObj);
      return res.status(500).json({
        success: false,
        message: errObj.message,
        error: errObj.toString(),
      });
    }
  };
  app.delete("/api/inventory/clear-all", authMiddleware, handleInventoryClearAll);
  app.post("/api/inventory/clear-all", authMiddleware, handleInventoryClearAll);

  app.post("/api/products/bulk-update", authMiddleware, async (req, res) => {
    const { productIds, stock, price } = req.body || {};
    if (!Array.isArray(productIds) || productIds.length === 0) {
      return res.status(400).json({ error: "productIds_required" });
    }
    if (!stock && !price) {
      return res.status(400).json({ error: "stock_or_price_required" });
    }
    const idSet = new Set(productIds.map(String));
    const products = await loadProducts();
    let updatedCount = 0;
    const changedRows: any[] = [];
    const next = products.map((p: any) => {
      const children = getProductChildrenList(p);
      if (children.length > 0) {
        let changed = false;
        const nextChildren = children.map((c: any) => {
          if (!idSet.has(c.id)) return c;
          updatedCount++;
          changed = true;
          const merged = applyBulkProductUpdate(c, { stock, price });
          changedRows.push(merged);
          return merged;
        });
        if (!changed && !idSet.has(p.id)) return p;
        if (idSet.has(p.id)) {
          updatedCount++;
          const parentPatched = applyBulkProductUpdate(p, { stock, price });
          changedRows.push(parentPatched);
          const totalStock = nextChildren.reduce((s: number, c: any) => s + (Number(c.stock) || 0), 0);
          return { ...parentPatched, children: nextChildren, stock: totalStock };
        }
        const totalStock = nextChildren.reduce((s: number, c: any) => s + (Number(c.stock) || 0), 0);
        return { ...p, children: nextChildren, stock: totalStock };
      }
      if (!idSet.has(p.id)) return p;
      updatedCount++;
      const merged = applyBulkProductUpdate(p, { stock, price });
      changedRows.push(merged);
      return merged;
    });
    await saveProducts(next);
    if (changedRows.length > 0) {
      await enqueueShopeeStockPriceSync(changedRows, {
        syncStock: !!stock,
        syncPrice: !!price,
      });
    }
    return res.json({ updated: updatedCount, products: next });
  });

  app.post("/api/products/bulk-channel-sync", authMiddleware, async (req, res) => {
    try {
      const { productIds, channels, shopId, shops } = req.body || {};
      if (!Array.isArray(productIds) || productIds.length === 0) {
        return res.status(400).json({ error: "productIds_required" });
      }

      const channelList: string[] = Array.isArray(channels) && channels.length
        ? channels
        : ["shopee"];

      const idSet = new Set(productIds.map(String));
      const products = flattenProductsForStockSync(await loadProducts()).filter((p: any) => idSet.has(p.id));
      if (products.length === 0) {
        return res.status(404).json({ error: "Không tìm thấy sản phẩm nào trong kho." });
      }

      const shopList: any[] = Array.isArray(shops) ? shops : [];
      const wooShop = shopList.find((s) => s.platform === "woocommerce" && s.connected !== false);

      const shopeeShopId = resolveShopeeTokenShopId(shopId || shopList.find((s) => s.platform === "shopee")?.shopId);
      let shopeeToken: string | null = null;
      if (channelList.includes("shopee")) {
        if (!shopeeShopId) {
          return res.status(400).json({
            error: "Chưa có shop Shopee được ủy quyền.",
            logs: products.flatMap((p: any) => [
              {
                productId: p.id,
                sku: p.sku,
                channel: "shopee",
                action: "auth",
                success: false,
                message: "Chưa có shop Shopee được ủy quyền",
              },
            ]),
          });
        }
        shopeeToken = await getValidShopeeAccessToken(shopeeShopId);
        if (!shopeeToken) {
          return res.status(400).json({
            error: `Chưa có access_token hợp lệ cho shop_id=${shopeeShopId}.`,
            logs: products.flatMap((p: any) => [
              {
                productId: p.id,
                sku: p.sku,
                channel: "shopee",
                action: "auth",
                success: false,
                message: `Chưa có access_token hợp lệ cho shop_id=${shopeeShopId}`,
              },
            ]),
          });
        }
      }

      const logs: ChannelSyncLine[] = [];

      for (const product of products) {
        for (const channel of channelList) {
          if (channel === "shopee" && shopeeShopId && shopeeToken) {
            const lines = await syncProductToShopee(product, shopeeShopId, shopeeToken);
            logs.push(...lines);
            await new Promise((r) => setTimeout(r, 150));
          } else if (channel === "woocommerce") {
            const lines = await syncProductToWoo(product, wooShop);
            logs.push(...lines);
            await new Promise((r) => setTimeout(r, 100));
          } else if (channel === "tiktok") {
            const lines = await syncProductToTikTok(product);
            logs.push(...lines);
          }
        }
      }

      const successCount = logs.filter((l) => l.success).length;
      const failCount = logs.filter((l) => !l.success).length;
      const syncedProductIds = new Set(
        logs.filter((l) => l.success).map((l) => l.productId)
      );

      if (syncedProductIds.size > 0) {
        const allProducts = await loadProducts();
        const now = new Date().toISOString();
        const next = allProducts.map((p: any) =>
          syncedProductIds.has(p.id) ? { ...p, lastSynced: now } : p
        );
        await saveProducts(next);
      }

      return res.status(failCount === 0 ? 200 : 400).json({
        success: failCount === 0,
        message:
          failCount === 0
            ? "Đồng bộ thành công"
            : `Lỗi từ Shopee: ${logs
                .filter((l) => !l.success)
                .map((l) => l.message)
                .filter(Boolean)
                .join(" | ") || "Shopee từ chối cập nhật giá/tồn kho"}`,
        error:
          failCount === 0
            ? undefined
            : `Lỗi từ Shopee: ${logs
                .filter((l) => !l.success)
                .map((l) => l.message)
                .filter(Boolean)
                .join(" | ") || "Shopee từ chối cập nhật giá/tồn kho"}`,
        logs,
        successCount,
        failCount,
        total: logs.length,
        products: await loadProducts(),
      });
    } catch (error: any) {
      console.error("[Bulk Channel Sync]", error);
      return res.status(500).json({
        error: error?.message || "Đồng bộ đa kênh thất bại",
        logs: [],
      });
    }
  });

  // --- Suppliers API (data/suppliers.json) ---
  app.get("/api/suppliers", authMiddleware, async (_req, res) => {
    return res.json(loadSuppliers());
  });

  app.post("/api/suppliers", authMiddleware, async (req, res) => {
    const body = req.body || {};
    if (!body.name?.trim() || !body.supplierCode?.trim()) {
      return res.status(400).json({ error: "name_and_supplierCode_required" });
    }
    const suppliers = loadSuppliers();
    const code = String(body.supplierCode).trim().toUpperCase();
    if (suppliers.some((s) => s.supplierCode === code)) {
      return res.status(400).json({ error: "supplier_code_duplicate" });
    }
    const supplier = normalizeSupplier({
      id: `sup-${Date.now()}`,
      name: body.name,
      supplierCode: code,
      totalOrderValue: 0,
      totalPaid: 0,
      totalDebt: 0,
      status: body.status || "active",
    });
    suppliers.unshift(supplier);
    saveSuppliers(suppliers);
    return res.status(201).json({ supplier, suppliers });
  });

  app.put("/api/suppliers/:id", authMiddleware, async (req, res) => {
    const suppliers = loadSuppliers();
    const index = suppliers.findIndex((s) => s.id === req.params.id);
    if (index === -1) {
      return res.status(404).json({ error: "supplier_not_found" });
    }
    const body = req.body || {};
    const code = body.supplierCode
      ? String(body.supplierCode).trim().toUpperCase()
      : suppliers[index].supplierCode;
    if (
      suppliers.some((s, i) => i !== index && s.supplierCode === code)
    ) {
      return res.status(400).json({ error: "supplier_code_duplicate" });
    }
    const updated = normalizeSupplier({
      ...suppliers[index],
      ...body,
      id: suppliers[index].id,
      supplierCode: code,
    });
    suppliers[index] = updated;
    saveSuppliers(suppliers);
    return res.json({ supplier: updated, suppliers });
  });

  app.delete("/api/suppliers/:id", authMiddleware, async (req, res) => {
    const suppliers = loadSuppliers();
    const target = suppliers.find((s) => s.id === req.params.id);
    if (!target) {
      return res.status(404).json({ error: "supplier_not_found" });
    }
    if (target.totalDebt > 0) {
      return res.status(400).json({ error: "supplier_has_debt" });
    }
    const next = suppliers.filter((s) => s.id !== req.params.id);
    saveSuppliers(next);
    return res.json({ deleted: req.params.id, suppliers: next });
  });

  app.post("/api/suppliers/clear-all", authMiddleware, async (_req, res) => {
    saveSuppliers([]);
    console.log("[Suppliers] Đã xóa sạch toàn bộ dữ liệu nhà cung cấp.");
    return res.json({ success: true, cleared: true, suppliers: [] });
  });

  // --- Imports API (data/imports.json) ---
  app.get("/api/imports", authMiddleware, async (_req, res) => {
    return res.json(loadImports());
  });

  app.get("/api/imports/product-context/:productId", authMiddleware, async (req, res) => {
    const productId = String(req.params.productId);
    const products = await loadProducts();
    const product = products.find((p: any) => p.id === productId);
    if (!product) {
      return res.status(404).json({ error: "product_not_found" });
    }

    const imports = loadImports();
    const sku = String(product.sku || "");
    const history = imports.filter(
      (imp: any) => imp.productId === productId || (sku && imp.productSku === sku)
    );
    const latest = history.length > 0
      ? [...history].sort((a: any, b: any) => {
          const tb = new Date(b.date || 0).getTime();
          const ta = new Date(a.date || 0).getTime();
          if (tb !== ta) return tb - ta;
          return String(b.id || "").localeCompare(String(a.id || ""));
        })[0]
      : null;

    return res.json({
      productId,
      oldPrice: Math.max(0, Math.round(Number(product.importPrice) || 0)),
      lastSupplierName: latest?.supplierName || null,
      lastSupplierId: latest?.supplierId || null,
      lastImportDate: latest?.date || null,
    });
  });

  app.post("/api/imports", authMiddleware, async (req, res) => {
    const body = req.body || {};
    if (!body.supplierId || !body.productId || !body.quantity || !body.newImportPrice) {
      return res.status(400).json({ error: "import_fields_required" });
    }
    const imports = loadImports();
    const qty = Math.max(1, Math.round(Number(body.quantity)));
    const unitPrice = Math.max(0, Math.round(Number(body.newImportPrice)));
    const importCost = Math.max(0, Math.round(Number(body.importCost) || 0));
    const computedTotal = qty * unitPrice + importCost;

    const entry = {
      id: body.id || `imp-${Date.now()}`,
      supplierId: String(body.supplierId),
      supplierName: String(body.supplierName || ""),
      date: body.date || new Date().toISOString().split("T")[0],
      productId: String(body.productId),
      productTitle: String(body.productTitle || ""),
      productSku: String(body.productSku || ""),
      quantity: qty,
      oldImportPrice: Math.max(0, Math.round(Number(body.oldImportPrice) || 0)),
      newImportPrice: unitPrice,
      importCost,
      totalAmount: Math.max(0, Math.round(Number(body.totalAmount) || computedTotal)),
      paidAmount: Math.max(0, Math.round(Number(body.paidAmount) || 0)),
      status: body.status || "unpaid",
      notes: body.notes || undefined,
    };
    imports.unshift(entry);
    saveImports(imports);
    return res.status(201).json({ import: entry, imports });
  });

  app.post("/api/imports/clear-all", authMiddleware, async (_req, res) => {
    saveImports([]);
    console.log("[Imports] Đã xóa sạch toàn bộ lịch sử nhập hàng.");
    return res.json({ success: true, cleared: true, imports: [] });
  });

  // --- Expenses API (data/expenses.json) ---
  app.get("/api/expenses", authMiddleware, async (_req, res) => {
    return res.json(loadExpenses());
  });

  app.post("/api/expenses", authMiddleware, async (req, res) => {
    const body = req.body || {};
    if (!body.title?.trim() || !body.amount || !body.category || !body.date) {
      return res.status(400).json({ error: "expense_fields_required" });
    }
    const expenses = loadExpenses();
    const entry = {
      id: body.id || `exp-${Date.now()}`,
      title: String(body.title).trim(),
      amount: Math.max(0, Math.round(Number(body.amount))),
      category: String(body.category),
      date: String(body.date),
      notes: body.notes ? String(body.notes) : undefined,
    };
    expenses.unshift(entry);
    saveExpenses(expenses);
    return res.status(201).json({ expense: entry, expenses });
  });

  app.delete("/api/expenses/:id", authMiddleware, async (req, res) => {
    const expenses = loadExpenses();
    const next = expenses.filter((e: any) => e.id !== req.params.id);
    if (next.length === expenses.length) {
      return res.status(404).json({ error: "expense_not_found" });
    }
    saveExpenses(next);
    return res.json({ deleted: req.params.id, expenses: next });
  });

  app.post("/api/expenses/clear-all", authMiddleware, async (_req, res) => {
    saveExpenses([]);
    console.log("[Expenses] Đã xóa sạch toàn bộ chi phí doanh nghiệp.");
    return res.json({ success: true, cleared: true, expenses: [] });
  });

  // --- Dashboard API ---
  app.get("/api/dashboard", authMiddleware, async (req, res) => {
    try {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      const dateRange = String(req.query.date_range || "last_7_days");
      const range = getDashboardDateRange(dateRange);
      const allOrders = loadOrders();
      const orders = allOrders.filter(isDashboardOrder);
      const products = await loadProducts();

      const ordersInRange = orders.filter((o: any) =>
        isDateInRange(String(o.date || ""), range.start, range.end)
      );

      const revenueOrders = ordersInRange.filter(
        (o: any) => o.status !== "cancelled" && Number(o.totalAmount) > 0
      );
      const totalRevenue = revenueOrders.reduce(
        (sum: number, o: any) => sum + (Number(o.totalAmount) || 0),
        0
      );
      const newOrderCount = ordersInRange.filter(
        (o: any) => o.status === "pending_confirm" || o.status === "unprocessed"
      ).length;
      const returnOrderCount = ordersInRange.filter(
        (o: any) => o.status === "return_pending" || o.status === "return_received"
      ).length;
      const cancelledOrderCount = ordersInRange.filter((o: any) => o.status === "cancelled").length;

      const pendingOrders = {
        pendingApproval: orders.filter((o: any) => o.status === "pending_confirm").length,
        pendingPayment: orders.filter(
          (o: any) => o.status === "pending_confirm" && o.channel === "manual"
        ).length,
        pendingPack: orders.filter(
          (o: any) => o.status === "unprocessed" && !o.isPrepared
        ).length,
        pendingPickup: orders.filter(
          (o: any) => (o.status === "unprocessed" && o.isPrepared) || o.status === "processed"
        ).length,
        shipping: orders.filter((o: any) => o.status === "shipping").length,
        returnPending: orders.filter((o: any) => o.status === "return_pending").length,
      };

      const productSales = new Map<string, { productId: string; quantitySold: number }>();
      for (const order of revenueOrders) {
        const items = Array.isArray(order.items) ? order.items : [];
        for (const item of items) {
          const pid = String(item.productId || "");
          if (!pid) continue;
          const prev = productSales.get(pid) || { productId: pid, quantitySold: 0 };
          prev.quantitySold += Math.max(0, Number(item.quantity) || 0);
          productSales.set(pid, prev);
        }
      }

      const topProducts = Array.from(productSales.values())
        .sort((a, b) => b.quantitySold - a.quantitySold)
        .slice(0, 5)
        .map((entry, idx) => {
          const prod = products.find((p: any) => p.id === entry.productId);
          const itemMeta = findOrderItemMeta(revenueOrders, entry.productId);
          return {
            rank: idx + 1,
            productId: entry.productId,
            title: prod?.title || itemMeta.title || entry.productId,
            sku: prod?.sku || "—",
            imageUrl: prod?.avatarUrl || prod?.imageUrl || itemMeta.image || null,
            quantitySold: entry.quantitySold,
          };
        });

      const LOW_STOCK_THRESHOLD = 5;
      const lowStockProducts = products
        .filter((p: any) => (Number(p.stock) || 0) < LOW_STOCK_THRESHOLD)
        .map((p: any) => ({
          id: String(p.id),
          title: String(p.title || p.sku || p.id),
          sku: String(p.sku || ""),
          stock: Number(p.stock) || 0,
        }))
        .sort((a: any, b: any) => a.stock - b.stock);

      const chart = buildDashboardChart(revenueOrders, range);

      return res.json({
        dateRange: range.key,
        dateRangeLabel: range.label,
        startDate: toDateKey(range.start),
        endDate: toDateKey(range.end),
        meta: {
          totalOrdersInDb: allOrders.length,
          dashboardOrders: orders.length,
          ordersInRange: ordersInRange.length,
        },
        kpi: {
          revenue: totalRevenue,
          newOrders: newOrderCount,
          returns: returnOrderCount,
          cancelled: cancelledOrderCount,
        },
        pendingOrders,
        chart,
        topProducts,
        inventory: {
          lowStockThreshold: LOW_STOCK_THRESHOLD,
          lowStockProducts,
        },
      });
    } catch (error: any) {
      console.error("[Dashboard API] Error:", error);
      return res.status(500).json({
        error: "dashboard_query_failed",
        message: error?.message || "Không thể tải dữ liệu dashboard.",
      });
    }
  });

  app.get("/api/orders", authMiddleware, async (req, res) => {
    let rawOrders = loadOrders().filter(isValidOrder);
    let dirty = false;
    rawOrders = rawOrders.map((o: any) => {
      const before = `${o.trackingNumber || ""}|${o.internalTrackingCode || ""}`;
      repairMisassignedTracking(o);
      const after = `${o.trackingNumber || ""}|${o.internalTrackingCode || ""}`;
      if (before !== after) dirty = true;
      return o;
    });
    if (dirty) saveOrders(rawOrders);
    const products = await loadProductsForOrders(rawOrders);
    const orders = enrichOrdersWithShopNames(enrichOrdersFromCatalog(rawOrders, products));
    return res.json(orders);
  });

  function normalizeScanLookupKey(raw: string): string {
    return String(raw || "")
      .trim()
      .toUpperCase()
      .replace(/[\s\-_#./\\|:;,]+/g, "");
  }

  async function buildScanLookupKeys(raw: string): string[] {
    const text = String(raw || "").trim();
    if (!text) return [];
    const keys = new Set<string>();
    const add = (v: unknown) => {
      const normalized = normalizeScanLookupKey(String(v || ""));
      if (normalized.length >= 4) keys.add(normalized);
    };
    add(text);
    add(text.replace(/^#+/, ""));
    if (/^https?:\/\//i.test(text)) {
      try {
        const url = new URL(text);
        [
          "tracking",
          "tracking_no",
          "tracking_number",
          "tn",
          "order_sn",
          "ordersn",
          "order",
          "order_id",
          "package_number",
          "code",
          "sn",
        ].forEach((p) => {
          const v = url.searchParams.get(p);
          if (v) add(v);
        });
        url.pathname.split("/").filter(Boolean).forEach(add);
      } catch {
        /* ignore */
      }
    }
    if (text.startsWith("{") || text.startsWith("[")) {
      try {
        const parsed = JSON.parse(text);
        [
          "tracking_number",
          "trackingNumber",
          "tracking_no",
          "trackingNo",
          "order_sn",
          "orderSn",
          "package_number",
          "packageNumber",
        ].forEach((k) => {
          if (parsed?.[k]) add(parsed[k]);
        });
      } catch {
        /* ignore */
      }
    }
    return [...keys];
  }

  function flexibleScanCodeMatch(scanKey: string, fieldKey: string): boolean {
    if (!scanKey || !fieldKey) return false;
    if (scanKey === fieldKey) return true;
    if (scanKey.length >= 10 && fieldKey.length >= 10) {
      return fieldKey.endsWith(scanKey) || scanKey.endsWith(fieldKey);
    }
    return false;
  }

  /** Flexible OR: orderSn OR trackingNumber OR packageNumber — index O(1) first, suffix fallback. */
  async function findOrderByScanLookup(orders: any[], raw: string): any | null {
    const scanKeys = await buildScanLookupKeys(raw);
    if (!scanKeys.length) return null;

    const idx = getOrderLookupIndex(orders);
    for (const sk of scanKeys) {
      for (const map of [idx.byTracking, idx.byInternal, idx.byOrderSn, idx.byPackage, idx.byId]) {
        const hit = map.get(sk);
        if (hit !== undefined) return orders[hit];
      }
    }

    const trackingLike = /^SPX(VN)?|^GHN|^GHTK|^JNT|^JT|^NINJA|^VTP|^VNPOST/.test(
      normalizeScanLookupKey(raw)
    );

    if (trackingLike) {
      for (const order of orders) {
        const trackingKey = order.trackingNumber ? normalizeScanLookupKey(order.trackingNumber) : "";
        const internalKey = order.internalTrackingCode ? normalizeScanLookupKey(order.internalTrackingCode) : "";
        if (trackingKey && scanKeys.some((sk) => flexibleScanCodeMatch(sk, trackingKey))) return order;
        if (internalKey && scanKeys.some((sk) => flexibleScanCodeMatch(sk, internalKey))) return order;
      }
    }

    const internalLike = /^0FG/.test(normalizeScanLookupKey(raw));
    if (internalLike) {
      for (const order of orders) {
        const internalKey = order.internalTrackingCode ? normalizeScanLookupKey(order.internalTrackingCode) : "";
        if (internalKey && scanKeys.some((sk) => flexibleScanCodeMatch(sk, internalKey))) return order;
      }
    }

    for (const order of orders) {
      const orderSnKey = normalizeScanLookupKey(order.orderSn);
      const trackingKey = order.trackingNumber ? normalizeScanLookupKey(order.trackingNumber) : "";
      const internalKey = order.internalTrackingCode ? normalizeScanLookupKey(order.internalTrackingCode) : "";
      const packageKey = order.packageNumber ? normalizeScanLookupKey(order.packageNumber) : "";
      const idKey = normalizeScanLookupKey(String(order.id || "").replace(/^shopee-/i, ""));

      const matched = scanKeys.some(
        (sk) =>
          flexibleScanCodeMatch(sk, orderSnKey) ||
          flexibleScanCodeMatch(sk, trackingKey) ||
          flexibleScanCodeMatch(sk, internalKey) ||
          flexibleScanCodeMatch(sk, packageKey) ||
          flexibleScanCodeMatch(sk, idKey)
      );
      if (matched) return order;
    }
    return null;
  }

  // Lookup order by scanned QR/barcode — matches orderSn OR trackingNumber OR internalTrackingCode OR packageNumber.
  app.get("/api/orders/lookup", authMiddleware, async (req, res) => {
    const code = String(req.query.code || req.query.q || "").trim();
    if (!code) {
      return res.status(400).json({ error: "Thi\u1EBFu m\u00E3 qu\u00E9t (code)." });
    }
    const rawOrders = loadOrders().filter(isValidOrder);
    const foundRaw = await findOrderByScanLookup(rawOrders, code);
    if (!foundRaw) {
      return res.status(404).json({
        error: "Kh\u00F4ng t\u00ECm th\u1EA5y \u0111\u01A1n h\u00E0ng kh\u1EDBp m\u00E3 qu\u00E9t.",
        scannedCode: code,
      });
    }
    const products = await loadProductsForOrders([foundRaw]);
    const found = enrichOrdersFromCatalog([foundRaw], products)[0];
    return res.json(found);
  });

  // Cleanup utility: permanently DELETE broken/mock order records (0đ total AND
  // no items) from the local database so they stop polluting the data file.
  app.post("/api/orders/cleanup-mock", authMiddleware, async (req, res) => {
    const orders = loadOrders();
    const validOrders = orders.filter(isValidOrder);
    const removedOrders = orders.filter((o: any) => !isValidOrder(o));

    saveOrders(validOrders);
    console.log(
      `[Orders Cleanup] \u0110\xE3 x\xF3a ${removedOrders.length} \u0111\u01A1n h\xE0ng l\u1ED7i/mock (0\u0111 v\xE0 kh\xF4ng c\xF3 s\u1EA3n ph\u1EA9m). C\xF2n l\u1EA1i ${validOrders.length} \u0111\u01A1n th\u1EAD t.`,
      removedOrders.map((o: any) => o.orderSn || o.id)
    );

    return res.json({
      removed: removedOrders.length,
      remaining: validOrders.length,
      removedOrderSns: removedOrders.map((o: any) => o.orderSn || o.id),
    });
  });

  // Update a real order's status/tracking after a warehouse/UI action.
  app.patch("/api/orders/:id", authMiddleware, async (req, res) => {
    const orders = loadOrders();
    const index = orders.findIndex((o: any) => o.id === req.params.id);
    if (index === -1) {
      return res.status(404).json({ error: "Kh\xF4ng t\xECm th\u1EA5y \u0111\u01A1n h\xE0ng." });
    }
    orders[index] = { ...orders[index], ...req.body, id: orders[index].id };
    saveOrders(orders);
    return res.json(orders[index]);
  });

  const VN_ADDRESS_API = "https://provinces.open-api.vn/api";
  let vnProvincesCache: any[] | null = null;
  const vnDistrictsCache = new Map<number, any[]>();
  const vnWardsCache = new Map<number, any[]>();

  const fetchVnJson = async (url: string) => {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`VN address API ${res.status}`);
    return res.json();
  };

  app.get("/api/vietnam-address/provinces", authMiddleware, async (_req, res) => {
    try {
      if (!vnProvincesCache) {
        vnProvincesCache = await fetchVnJson(`${VN_ADDRESS_API}/p/`);
      }
      const list = (vnProvincesCache || []).map((p: any) => ({
        name: p.name,
        code: p.code,
      }));
      return res.json(list);
    } catch (error: any) {
      console.error("[VN Address] provinces:", error);
      return res.status(502).json({ error: "Không tải được danh sách Tỉnh/Thành" });
    }
  });

  app.get("/api/vietnam-address/districts/:provinceCode", authMiddleware, async (req, res) => {
    try {
      const provinceCode = Number(req.params.provinceCode);
      if (!provinceCode) return res.json([]);

      if (!vnDistrictsCache.has(provinceCode)) {
        const data = await fetchVnJson(`${VN_ADDRESS_API}/p/${provinceCode}?depth=2`);
        const districts = Array.isArray(data?.districts) ? data.districts : [];
        vnDistrictsCache.set(
          provinceCode,
          districts.map((d: any) => ({ name: d.name, code: d.code }))
        );
      }
      return res.json(vnDistrictsCache.get(provinceCode) || []);
    } catch (error: any) {
      console.error("[VN Address] districts:", error);
      return res.status(502).json({ error: "Không tải được danh sách Quận/Huyện" });
    }
  });

  app.get("/api/vietnam-address/wards/:districtCode", authMiddleware, async (req, res) => {
    try {
      const districtCode = Number(req.params.districtCode);
      if (!districtCode) return res.json([]);

      if (!vnWardsCache.has(districtCode)) {
        const data = await fetchVnJson(`${VN_ADDRESS_API}/d/${districtCode}?depth=2`);
        const wards = Array.isArray(data?.wards) ? data.wards : [];
        vnWardsCache.set(
          districtCode,
          wards.map((w: any) => ({ name: w.name, code: w.code }))
        );
      }
      return res.json(vnWardsCache.get(districtCode) || []);
    } catch (error: any) {
      console.error("[VN Address] wards:", error);
      return res.status(502).json({ error: "Không tải được danh sách Phường/Xã" });
    }
  });

  const buildCarrierLogisticsPayload = (
    carrier: string,
    customer: { name: string; phone: string },
    addr: {
      street: string;
      province: string;
      provinceCode: string;
      district: string;
      districtCode: string;
      ward: string;
      wardCode: string;
    },
    extras: { weight: number; note: string; codAmount: number }
  ) => {
    if (carrier === "ghn") {
      return {
        provider: "ghn",
        to_name: customer.name,
        to_phone: customer.phone,
        to_address: addr.street,
        to_ward_code: addr.wardCode,
        to_district_id: Number(addr.districtCode),
        to_province_id: Number(addr.provinceCode),
        to_ward_name: addr.ward,
        to_district_name: addr.district,
        to_province_name: addr.province,
        weight: extras.weight,
        note: extras.note,
        cod_amount: extras.codAmount,
      };
    }
    if (carrier === "spx") {
      return {
        provider: "spx",
        deliver_info: {
          deliver_name: customer.name,
          deliver_phone: customer.phone,
          deliver_detail_address: addr.street,
          deliver_ward: addr.ward,
          deliver_district: addr.district,
          deliver_province: addr.province,
          deliver_ward_id: addr.wardCode,
          deliver_district_id: addr.districtCode,
          deliver_province_id: addr.provinceCode,
        },
        parcel_weight: extras.weight,
        remark: extras.note,
        cod_amount: extras.codAmount,
      };
    }
    return null;
  };

  const generateCarrierTracking = (carrier: string) => {
    if (carrier === "ghn") return `GHN-VN-${Math.floor(100000000 + Math.random() * 900000000)}`;
    if (carrier === "spx") return `SPX-VN-${Math.floor(100000000 + Math.random() * 900000000)}`;
    return `DIRECT-${Math.floor(100000 + Math.random() * 900000)}`;
  };

  app.post("/api/orders/manual", authMiddleware, async (req, res) => {
    try {
      const body = req.body || {};
      const {
        shippingAddress,
        items,
        carrier = "self",
        packageWeight = 500,
        shippingFee = 0,
        shippingFeePayer = "customer",
        orderDiscount = 0,
        carrierNotes = "",
      } = body;

      const addr = shippingAddress || {};
      if (!addr.provinceCode || !addr.districtCode || !addr.wardCode || !addr.street?.trim()) {
        return res.status(400).json({
          error: "Địa chỉ chưa đầy đủ. Vui lòng chọn Tỉnh, Quận/Huyện, Phường/Xã và nhập địa chỉ chi tiết.",
        });
      }

      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: "Đơn hàng cần ít nhất 1 sản phẩm." });
      }

      const subtotal = items.reduce(
        (acc: number, it: any) => acc + Number(it.price || 0) * Number(it.quantity || 0),
        0
      );
      const feeToCollect = shippingFeePayer === "customer" ? Number(shippingFee) : 0;
      const totalAmount = subtotal + feeToCollect - Number(orderDiscount);

      const fullAddress = [addr.street, addr.ward, addr.district, addr.province]
        .filter(Boolean)
        .join(", ");

      const trackingNumber = generateCarrierTracking(carrier);
      const logisticsPayload =
        carrier !== "self"
          ? buildCarrierLogisticsPayload(
              carrier,
              { name: "Khách sỉ", phone: "0900000000" },
              {
                street: addr.street.trim(),
                province: addr.province,
                provinceCode: String(addr.provinceCode),
                district: addr.district,
                districtCode: String(addr.districtCode),
                ward: addr.ward,
                wardCode: String(addr.wardCode),
              },
              {
                weight: Number(packageWeight) || 500,
                note: carrierNotes || "",
                codAmount: totalAmount,
              }
            )
          : null;

      if (logisticsPayload) {
        console.log(
          `[Logistics ${carrier.toUpperCase()}] Payload đẩy đơn:`,
          JSON.stringify(logisticsPayload, null, 2)
        );
      }

      const newOrder = {
        id: `order-manual-${Date.now()}`,
        orderSn: `DON-NGOAI-${Math.floor(100000 + Math.random() * 900000)}`,
        channel: "manual",
        shippingAddress: {
          province: addr.province,
          provinceCode: String(addr.provinceCode),
          district: addr.district,
          districtCode: String(addr.districtCode),
          ward: addr.ward,
          wardCode: String(addr.wardCode),
          street: addr.street.trim(),
          fullAddress,
        },
        carrier,
        totalAmount,
        revenue: totalAmount,
        status: "unprocessed",
        date: new Date().toISOString(),
        trackingNumber,
        isPrepared: carrier !== "self",
        isPrinted: false,
        items: items.map((it: any) => ({
          productId: it.productId,
          productTitle: it.productTitle,
          productImage: it.productImage,
          quantity: Number(it.quantity),
          price: Number(it.price),
        })),
        logisticsPayload,
      };

      const orders = loadOrders();
      orders.unshift(newOrder);
      saveOrders(orders);

      return res.json({
        success: true,
        order: newOrder,
        trackingNumber,
        logisticsPayload,
        orders: orders.filter(isValidOrder),
      });
    } catch (error: any) {
      console.error("[Orders manual]", error);
      return res.status(500).json({ error: error.message || "Tạo đơn thủ công thất bại" });
    }
  });

  // Full Shopee order sync — chạy NGẦM (async job) để không giữ HTTP/RAM, tránh sập cPanel.
  async function executeOrderSyncBackgroundJob(jobId: string): Promise<void> {
    pruneOldOrderSyncJobs();
    const job = orderSyncJobs.get(jobId);
    if (!job) return;

    if (!tryAcquireHeavyJob(`order-sync:${jobId}`)) {
      job.status = "failed";
      job.error = "heavy_job_busy";
      job.message = "Hệ thống đang xử lý tác vụ nặng khác — vui lòng thử lại sau.";
      job.updatedAt = Date.now();
      if (activeOrderSyncJobId === jobId) activeOrderSyncJobId = null;
      return;
    }

    try {
      job.status = "running";
      job.message = "Đang quét đơn từ Shopee (chế độ tiết kiệm RAM)...";
      job.updatedAt = Date.now();

      const result = await syncShopeeOrdersFromApi([...SHOPEE_SYNC_STATUSES], {
        onProgress: (completed, total, message) => {
          job.completed = completed;
          job.total = Math.max(job.total, total);
          if (message) job.message = message;
          job.updatedAt = Date.now();
        },
      });

      job.synced = result.synced;
      job.added = result.added;
      job.updated = result.updated;
      job.errors = result.errors;
      job.uiStatusCounts = result.uiStatusCounts;
      job.warning = result.warning;
      job.completed = job.total || result.synced;
      job.status = "done";
      job.message = `Hoàn tất: ${result.synced} đơn (${result.added} mới, ${result.updated} cập nhật).`;
    } catch (err: any) {
      job.status = "failed";
      job.error = err?.message || String(err);
      job.message = job.error || "Đồng bộ thất bại";
      console.error(`[Order Sync Job ${jobId}] Failed:`, err);
    } finally {
      job.updatedAt = Date.now();
      if (activeOrderSyncJobId === jobId) activeOrderSyncJobId = null;
      releaseHeavyJob(`order-sync:${jobId}`);
    }
  }
  // Đồng bộ đơn hàng chỉ chạy khi user chủ động gọi API thủ công.

  app.post("/api/shopee/orders/sync", authMiddleware, async (req, res) => {
    try {
      if (!SHOPEE_PARTNER_ID || !SHOPEE_PARTNER_KEY) {
        return res.status(500).json({
          error: "Thi\u1EBFu SHOPEE_PARTNER_ID / SHOPEE_PARTNER_KEY (Live) trong file .env.",
          message: "Thiếu cấu hình Shopee Partner trên backend.",
        });
      }

      const tokens = loadShopeeTokens();
      if (Object.keys(tokens).length === 0) {
        return res.json({ synced: 0, orders: [], warning: "Ch\u01B0a c\xF3 shop Shopee Live n\xE0o \u0111\u01B0\u1EE3c \u1EE7y quy\u1EC1n." });
      }

      const running = getRunningOrderSyncJob();
      if (running) {
        return res.status(202).json({
          jobId: running.id,
          status: running.status,
          message: "Đồng bộ đang chạy — vui lòng chờ job hiện tại hoàn tất.",
          completed: running.completed,
          total: running.total,
        });
      }

      pruneOldOrderSyncJobs();
      const jobId = createOrderSyncJobId();
      activeOrderSyncJobId = jobId;
      orderSyncJobs.set(jobId, {
        id: jobId,
        status: "pending",
        total: 0,
        completed: 0,
        synced: 0,
        added: 0,
        updated: 0,
        message: "Đã xếp hàng — bắt đầu đồng bộ ngầm...",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      console.log(`[Shopee Sync] Khởi tạo job ngầm ${jobId} (max ${SHOPEE_SYNC_MAX_ORDER_SNS_PER_SHOP} đơn/shop, chunk ${SHOPEE_SYNC_CHUNK_SIZE}, delay ${SHOPEE_SYNC_CHUNK_DELAY_MS}ms).`);

      setImmediate(() => {
        void executeOrderSyncBackgroundJob(jobId);
      });

      return res.status(202).json({
        jobId,
        status: "pending",
        message: "Đồng bộ đang chạy ngầm — không chặn server, tránh quá tải RAM.",
      });
    } catch (error: unknown) {
      console.error("[Shopee Sync] API fatal error:", error);
      return sendApiErrorJson(res, error, 500);
    }
  });

  app.get("/api/shopee/orders/sync/job/:jobId", authMiddleware, async (req, res) => {
    const job = orderSyncJobs.get(String(req.params.jobId || ""));
    if (!job) {
      return res.status(404).json({
        error: "job_not_found",
        message: "Không tìm thấy tiến trình đồng bộ.",
      });
    }
    return res.json(job);
  });

  // Active "pull" — actively calls Shopee's real v2.order.get_order_list +
  // v2.order.get_order_detail for every Live shop that has completed OAuth,
  // instead of passively waiting for webhook pushes. Bound to the "Cập nhật
  // đơn hàng" button on the frontend.
  app.post("/api/orders/pull", authMiddleware, async (req, res) => {
    try {
      console.log("[Orders Pull] Bắt đầu gọi Shopee để đồng bộ đơn hàng...");
      if (!SHOPEE_PARTNER_ID || !SHOPEE_PARTNER_KEY) {
        return res.status(500).json({
          success: false,
          error: "Thi\u1EBFu SHOPEE_PARTNER_ID / SHOPEE_PARTNER_KEY (Live) trong file .env. Vui l\xF2ng c\u1EA5u h\xECnh tr\u01B0\u1EDBc khi k\xE9o \u0111\u01A1n.",
        });
      }

      const tokens = loadShopeeTokens();
      const shopIds = Object.keys(tokens);
      if (shopIds.length === 0) {
        console.warn("[Orders Pull] Không có shop_id nào đã liên kết OAuth.");
        return res.json({ success: true, pulled: 0, orders: [], warning: "Ch\u01B0a c\xF3 shop Shopee Live n\xE0o \u0111\u01B0\u1EE3c \u1EE7y quy\u1EC1n." });
      }

      console.log(`[Orders Pull] Tìm thấy ${shopIds.length} shop cần đồng bộ: ${shopIds.join(", ")}`);
      const orders = loadOrders();
      let pulledCount = 0;
      const errors: any[] = [];

      for (const shopId of shopIds) {
        try {
          console.log(`[Orders Pull] Shop ${shopId}: đang lấy access token...`);
          const accessToken = await getValidShopeeAccessToken(shopId);
          if (!accessToken) {
            const tokenFail = describeShopeeTokenFailure(shopId);
            errors.push({ shopId, error: tokenFail.error, message: tokenFail.message });
            console.warn(`[Orders Pull] Shop ${shopId}: không lấy được token — ${tokenFail.message}`);
            continue;
          }

          await shopeeSyncDelay();
          console.log(`[Orders Pull] Shop ${shopId}: đang gọi Shopee get_order_list...`);
          let orderSnList = await shopeeFetchAllOrderSns(shopId, accessToken);
          if (orderSnList.length > SHOPEE_SYNC_MAX_ORDER_SNS_PER_SHOP) {
            console.warn(
              `[Orders Pull] Shop ${shopId}: cắt ${orderSnList.length} → ${SHOPEE_SYNC_MAX_ORDER_SNS_PER_SHOP} đơn để tránh quá tải.`,
            );
            orderSnList = orderSnList.slice(0, SHOPEE_SYNC_MAX_ORDER_SNS_PER_SHOP);
          }
          console.log(`[Orders Pull] Shop ${shopId}: lấy được ${orderSnList.length} đơn từ Shopee.`);
          if (orderSnList.length === 0) continue;

          console.log(
            `[Orders Pull] Shop ${shopId}: bắt đầu xử lý theo lô ${SHOPEE_SYNC_CHUNK_SIZE} đơn (${orderSnList.length} đơn)...`,
          );
          for (let i = 0; i < orderSnList.length; i += SHOPEE_SYNC_CHUNK_SIZE) {
            const chunkSns = orderSnList.slice(i, i + SHOPEE_SYNC_CHUNK_SIZE);
            const chunkNo = Math.floor(i / SHOPEE_SYNC_CHUNK_SIZE) + 1;
            const totalChunks = Math.ceil(orderSnList.length / SHOPEE_SYNC_CHUNK_SIZE);
            console.log(
              `[Orders Pull] Shop ${shopId}: lô ${chunkNo}/${totalChunks} — ${chunkSns.length} đơn`,
            );

            const { normalized: batchNormalized, errors: chunkErrors } = await fetchNormalizeShopeeOrderChunk(
              shopId,
              accessToken,
              shopId,
              chunkSns,
              { enrichTracking: false },
            );
            errors.push(...chunkErrors);

            if (batchNormalized.length > 0) {
              try {
                const upsert = await persistShopeeOrderChunk(orders, batchNormalized);
                pulledCount += upsert.added + upsert.updated;
                console.log(
                  `[Orders Pull] Shop ${shopId}: đã lưu lô ${chunkNo} (+${upsert.added} mới, ~${upsert.updated} cập nhật).`,
                );
              } catch (saveErr: any) {
                const saveMessage = saveErr?.message || String(saveErr);
                console.error(`[Orders Pull] Shop ${shopId}: lỗi lưu DB lô ${chunkNo}:`, saveMessage);
                errors.push({ shopId, error: "save_orders_failed", message: saveMessage });
              }
            } else {
              console.warn(`[Orders Pull] Shop ${shopId}: lô ${chunkNo} không có dữ liệu hợp lệ.`);
            }

            if (i + SHOPEE_SYNC_CHUNK_SIZE < orderSnList.length) {
              await sleep(ORDER_SYNC_SAVE_DELAY_MS);
            }
          }

          console.log(`[Orders Pull] Shop ${shopId}: hoàn thành xử lý ${orderSnList.length} đơn.`);
          orderSnList = [];
        } catch (error: any) {
          const errorMsg = error?.message || String(error);
          console.error(`[Orders Pull] Lỗi khi kéo đơn cho shop_id=${shopId}:`, errorMsg);
          errors.push({ shopId, error: error?.error || "pull_shop_failed", message: errorMsg });
        }

        await shopeeSyncDelay();
      }

      console.log(`[Orders Pull] Hoàn thành: ${pulledCount} đơn đã cập nhật/thêm mới.`);

      return res.json({
        success: true,
        pulled: pulledCount,
        orders: [],
        errors: errors.length ? errors : undefined,
      });
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error("[Orders Pull] fatal:", err.message, err.stack);
      if (res.headersSent) return;
      return res.status(500).json({
        success: false,
        error: err.message || "Internal Server Error",
        stack: err.stack,
      });
    }
  });

  // GET /api/shopee/diagnostics?shop_id=4127421 — kiểm tra Partner ID/Key, token OAuth, ping Shopee API
  app.get("/api/shopee/diagnostics", authMiddleware, async (req, res) => {
    const shopId = req.query.shop_id ? String(req.query.shop_id) : undefined;
    console.log("[Shopee Diagnostics] Bắt đầu kiểm tra...", shopId ? `shop_id=${shopId}` : "");
    const report = await runShopeeConnectivityDiagnostics(shopId);
    console.log("[Shopee Diagnostics] Kết quả:", JSON.stringify(report, null, 2));
    return res.status(report.ok ? 200 : 502).json({
      success: report.ok,
      summary: report.code,
      ...report,
      checkedAt: new Date().toISOString(),
      backend: "cpanel-node",
    });
  });

  // Debug/test-only route: call v2.order.get_order_list directly with the
  // currently stored token for one shop and dump the RAW Shopee response
  // (no normalization, no saving) so you can see exactly what Shopee returns
  // — an empty order list [], or an error code (expired token, invalid sign...).
  // Usage: GET /api/shopee/force-sync?shop_id=4127421  (Authorization: Bearer <admin_token>)
  app.get("/api/shopee/force-sync", authMiddleware, async (req, res) => {
    console.log("[Shopee Force-Sync] ==== B\u1EAFt \u0111\u1EA7u ki\u1EC3m tra th\u1EE7 c\xF4ng ====");

    if (!isShopeeConfigValid()) {
      const msg = `SHOPEE_PARTNER_ID/SHOPEE_PARTNER_KEY trong .env ch\u01B0a h\u1EE3p l\u1EC7 (hi\u1EC7n t\u1EA1i partner_id="${SHOPEE_PARTNER_ID}"). \u0110\xE2y ph\u1EA3i l\xE0 Live Partner ID (s\u1ED1 nguy\xEAn) v\xE0 Live Partner Key th\u1EF1c t\u1EEB open.shopee.com.`;
      console.error(`[Shopee Force-Sync] \u274C ${msg}`);
      return res.status(500).json({ step: "config_check", ok: false, error: msg });
    }

    const tokens = loadShopeeTokens();
    const availableShopIds = Object.keys(tokens);
    console.log(`[Shopee Force-Sync] C\xE1c shop_id \u0111\xE3 l\u01B0u token trong data/shopee_tokens.json: [${availableShopIds.join(", ") || "kh\xF4ng c\xF3"}]`);

    const shopId = String(req.query.shop_id || availableShopIds[0] || "");
    if (!shopId) {
      const msg = "Ch\u01B0a c\xF3 shop_id n\xE0o \u0111\u01B0\u1EE3c l\u01B0u trong data/shopee_tokens.json. Ngh\u0129a l\xE0 lu\u1ED3ng OAuth /api/shopee/callback ch\u01B0a t\u1EEBng \u0111\u1ED5i code th\xE0nh access_token th\xE0nh c\xF4ng. H\xE3y b\u1EA5m l\u1EA1i n\xFAt \u1EE7y quy\u1EC1n shop tr\xEAn Shopee v\xE0 xem log [Shopee OAuth] khi callback ch\u1EA1y.";
      console.error(`[Shopee Force-Sync] \u274C ${msg}`);
      return res.status(404).json({ step: "token_lookup", ok: false, error: msg, availableShopIds });
    }

    const tokenRecord = tokens[shopId];
    if (!tokenRecord) {
      const msg = `Kh\xF4ng t\xECm th\u1EA5y token \u0111\xE3 l\u01B0u cho shop_id=${shopId}.`;
      console.error(`[Shopee Force-Sync] \u274C ${msg}`);
      return res.status(404).json({ step: "token_lookup", ok: false, error: msg, availableShopIds });
    }
    console.log(`[Shopee Force-Sync] \u0110\xE3 t\xECm th\u1EA5y token cho shop_id=${shopId}. obtained_at=${tokenRecord.obtained_at}, expire_in=${tokenRecord.expire_in}s.`);

    try {
      const accessToken = await getValidShopeeAccessToken(shopId);
      if (!accessToken) {
        const msg = `Kh\xF4ng l\u1EA5y \u0111\u01B0\u1EE3c access_token h\u1EE3p l\u1EC7 cho shop_id=${shopId} (c\xF3 th\u1EC3 refresh_token \u0111\xE3 h\u1EBFt h\u1EA1n, c\u1EA7n \u1EE7y quy\u1EC1n l\u1EA1i t\u1EEB \u0111\u1EA7u).`;
        console.error(`[Shopee Force-Sync] \u274C ${msg}`);
        return res.status(401).json({ step: "access_token", ok: false, error: msg });
      }
      console.log(`[Shopee Force-Sync] access_token \u0111ang d\xF9ng: ${accessToken.slice(0, 8)}... (\u0111\xE3 r\xFAt g\u1ECDn \u0111\u1EC3 b\u1EA3o m\u1EADt)`);

      const listResult = await shopeeGetOrderList(shopId, accessToken);
      console.log("[Shopee Force-Sync] === RAW RESPONSE t\u1EEB v2.order.get_order_list ===");
      console.log(JSON.stringify(listResult, null, 2));

      return res.json({
        step: "get_order_list",
        ok: !listResult.error,
        shopId,
        rawResponse: listResult,
        orderCount: listResult.response?.order_list?.length ?? 0,
      });
    } catch (error: any) {
      console.error("[Shopee Force-Sync] \u274C Exception:", error);
      return res.status(500).json({ step: "exception", ok: false, error: error.message || String(error) });
    }
  });

  // Đồng bộ dữ liệu sàn theo shop + khoảng thời gian.
  // Mỗi request xử lý đúng 1 page; frontend tiếp tục bằng nextOffset để giữ RAM ổn định.
  app.post("/api/sync-from-shop", authMiddleware, async (req, res) => {
    try {
      const requestedShopId = String(req.body?.shop_id || "").trim();
      const timeRange = String(req.body?.time_range || "").trim() as ShopSyncTimeRange;
      if (!requestedShopId || !["all", "24h"].includes(timeRange)) {
        return res.status(400).json({
          success: false,
          error: "invalid_sync_params",
          message: "shop_id và time_range ('all' hoặc '24h') là bắt buộc.",
        });
      }

      const channelSettings = loadChannelSettings();
      const connectedShop = asShopeeArray(channelSettings?.shops).find(
        (shop: any) =>
          normalizeShopIdKey(shop?.shopId) === normalizeShopIdKey(requestedShopId) &&
          shop?.connected === true,
      );
      if (!connectedShop) {
        return res.status(404).json({
          success: false,
          error: "connected_shop_not_found",
          message: `Không tìm thấy shop_id=${requestedShopId} trong danh sách gian hàng đã kết nối.`,
        });
      }
      if (connectedShop.platform !== "shopee") {
        return res.status(501).json({
          success: false,
          error: "platform_sync_not_implemented",
          message: `Đồng bộ sản phẩm ${connectedShop.platform} chưa được tích hợp trên server.`,
        });
      }

      if (!isShopeeConfigValid()) {
        return res.status(500).json({
          success: false,
          message: "SHOPEE_PARTNER_ID/SHOPEE_PARTNER_KEY trong .env chưa hợp lệ.",
          error: "invalid_partner_config",
          details: "invalid_partner_config",
        });
      }

      const tokenContext = await getShopeeAccessTokenForApi(requestedShopId);
      if (!tokenContext) {
        return res.status(401).json({
          success: false,
          message: `Chưa có access_token hợp lệ cho shop_id=${requestedShopId}.`,
          error: "no_valid_access_token",
          details: "no_valid_access_token",
        });
      }

      const shopId = tokenContext.apiShopId;
      const accessToken = tokenContext.token;

      ensureDataDirs();

      const shopName =
        String(connectedShop.shopName || "").trim() ||
        resolveConnectedShopDisplayName(shopId) ||
        `Shop ${shopId}`;
      const offset = Math.max(0, Number(req.body?.offset) || 0);
      const requestedSyncTo = Number(req.body?.sync_to);
      const syncTo =
        Number.isFinite(requestedSyncTo) && requestedSyncTo > 0
          ? Math.floor(requestedSyncTo)
          : Math.floor(Date.now() / 1000);
      const updateWindow: ShopeeUpdateWindow =
        timeRange === "24h" ? { from: syncTo - 24 * 60 * 60, to: syncTo } : undefined;

      console.log(
        `[Sync From Shop] platform=shopee shop_id=${shopId} range=${timeRange} offset=${offset} page_size=${SHOPEE_ITEM_LIST_PAGE_SIZE}`,
      );

      const pageResult = await pullShopeeChannelListingsPage(
        shopId,
        accessToken,
        shopName,
        offset,
        updateWindow,
      );
      let listingsCount = 0;
      try {
        await flushDbWrites();
        listingsCount = (await readChannelListingsDb()).length;
      } catch {
        listingsCount = pageResult.rowsSaved;
      }
      // Đồng bộ Local Cache Master sau mỗi trang sync (không quét từng item).
      try {
        await refreshCache();
      } catch (cacheErr: unknown) {
        console.error("[Sync From Shop] refreshCache thất bại:", cacheErr);
      }
      console.log(
        `Đã lưu DB thành công — trang offset=${offset}, listingsInDb=${listingsCount} mongo=${isMongoReady()}`
      );

      return res.status(200).json({
        success: true,
        message:
          pageResult.rowsSaved > 0
            ? `Đã lưu trang ${pageResult.pageIndex + 1}: ${pageResult.pageStats.rowsInPage} parent (${pageResult.rowsSaved} SKU)`
            : pageResult.hasMore
              ? "Trang trống — đang chuyển trang tiếp theo"
              : "Hoàn tất tải dữ liệu từ sàn",
        shopId,
        shop_id: requestedShopId,
        shopName,
        platform: "shopee",
        time_range: timeRange,
        sync_to: syncTo,
        offset: pageResult.currentOffset,
        nextOffset: pageResult.hasMore ? pageResult.nextOffset : null,
        hasMore: pageResult.hasMore,
        pageSize: SHOPEE_ITEM_LIST_PAGE_SIZE,
        pageStats: pageResult.pageStats,
        savedCount: pageResult.rowsSaved,
        fetchedCount: pageResult.pageStats.rowsInPage,
        parentCount: pageResult.pageStats.rowsInPage,
        listingsCount,
        skippedItems: pageResult.skippedItems.length > 0 ? pageResult.skippedItems.slice(0, 50) : undefined,
      });
    } catch (error: unknown) {
      console.error("DB Save Error:", error);
      console.error("[Sync From Shop] Exception:", error);
      const errObj = error instanceof Error ? error : new Error(String(error));
      if (!res.headersSent) {
        return res.status(500).json({
          success: false,
          message: errObj.message,
          error: errObj.toString(),
        });
      }
    }
  });

  // Các alias dùng chung handler đã bọc try/catch và luôn phản hồi JSON khi lỗi.
  app.post("/api/shopee/channel-products/auto-link", authMiddleware, handleBatchAutoLink);
  app.post("/api/channel-products/auto-link", authMiddleware, handleBatchAutoLink);
  app.post("/api/auto-link", authMiddleware, handleBatchAutoLink);

  // Real product sync — "Khởi tạo kho chính từ Shopee API": pulls the shop's
  // REAL listed items (v2.product.get_item_list -> get_item_base_info, plus
  // get_model_list for items with variants) and returns them normalized to
  // this project's Product shape. The frontend replaces its entire local
  // product list with this response — no more hardcoded/mock demo products.
  app.post("/api/shopee/products/sync", authMiddleware, async (req, res) => {
    try {
      if (!isShopeeConfigValid()) {
        return res.status(500).json({
          success: false,
          error: "invalid_partner_config",
          message: "SHOPEE_PARTNER_ID/SHOPEE_PARTNER_KEY trong .env chưa hợp lệ.",
          details: "invalid_partner_config",
        });
      }

      const shopId = resolveShopeeTokenShopId(req.body?.shopId);
      if (!shopId) {
        return res.status(404).json({
          success: false,
          error: "no_shopee_shop_linked",
          message: "Chưa có shop Shopee nào được ủy quyền.",
          details: "no_shopee_shop_linked",
        });
      }

      const accessToken = await getValidShopeeAccessToken(shopId);
      if (!accessToken) {
        return res.status(401).json({
          success: false,
          error: "no_valid_access_token",
          message: `Chưa có access_token hợp lệ cho shop_id=${shopId}.`,
          details: "no_valid_access_token",
        });
      }

      const rawOffset = Number(req.body?.offset ?? 0);
      const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? Math.floor(rawOffset) : 0;
      const reset = req.body?.reset === true || offset === 0;

      if (reset) {
        await clearExistingShopeeWarehouseProducts();
      }

      console.log(
        `[Shopee Product Sync] Bắt đầu đồng bộ 1 trang shop_id=${shopId}, offset=${offset}, page_size=${SHOPEE_ITEM_LIST_PAGE_SIZE}`
      );
      const result = await syncShopeeWarehouseSinglePage(shopId, accessToken, offset);
      const initialized = Number(result.productCount) || 0;
      console.log(
        `[Shopee Product Sync] Xong trang ${result.pageIndex + 1} — productCount=${initialized}, rowsInPage=${result.pageStats.rowsInPage}, hasMore=${result.hasMore}`
      );

      return res.status(200).json({
        success: true,
        shopId,
        productCount: initialized,
        stats: {
          rowCount: result.pageStats.rowsInPage,
          variantItemCount: result.pageStats.variantItemCount,
          pageCount: result.pageIndex + 1,
          itemsInPage: result.pageStats.itemsInPage,
          savedCount: result.pageStats.savedCount,
          skippedCount: result.pageStats.skippedCount,
        },
        currentOffset: result.currentOffset,
        nextOffset: result.nextOffset,
        hasMore: result.hasMore,
        pageIndex: result.pageIndex + 1,
        skippedItems: result.skippedItems?.length ? result.skippedItems : undefined,
        message: result.hasMore
          ? `Đã lưu trang ${result.pageIndex + 1} (${result.pageStats.itemsInPage} sản phẩm), tiếp tục trang sau`
          : `Đã khởi tạo xong ${initialized} sản phẩm`,
        forceRefresh: !result.hasMore,
        refresh: { forceRefresh: !result.hasMore },
      });
    } catch (error: unknown) {
      console.error("[Shopee Product Sync] Exception:", error);
      console.error("Lỗi khi lưu DB chunk:", error);
      const { message, details } = extractHttpClientError(error);
      const isRate = /429|rate.?limit|too many request/i.test(message);
      if (!res.headersSent) {
        return res.status(isRate ? 429 : 500).json({
          success: false,
          error: isRate ? "shopee_rate_limit" : "exception",
          message,
          details,
        });
      }
      return;
    }
  });

  // Tải/refresh toàn bộ phân loại (model_list / model_sku) cho MỘT sản phẩm Shopee.
  app.post("/api/shopee/products/sync-item-variants", authMiddleware, async (req, res) => {
    try {
      if (!isShopeeConfigValid()) {
        return res.status(500).json({ success: false, error: "invalid_partner_config", message: "Cấu hình Shopee Partner không hợp lệ.", details: "invalid_partner_config" });
      }

      const rawItemId = String(req.body?.itemId || req.body?.shopeeItemId || req.body?.productId || "");
      const itemIdMatch = rawItemId.match(/(\d{6,})/);
      if (!itemIdMatch) {
        return res.status(400).json({ success: false, error: "itemId_required", message: "Không xác định được item_id Shopee.", details: "itemId_required" });
      }
      const itemId = Number(itemIdMatch[1]);

      const shopId = resolveShopeeTokenShopId(req.body?.shopId);
      if (!shopId) {
        return res.status(404).json({ success: false, error: "no_shopee_shop", message: "Chưa có shop Shopee được ủy quyền.", details: "no_shopee_shop" });
      }

      const accessToken = await getValidShopeeAccessToken(shopId);
      if (!accessToken) {
        return res.status(401).json({ success: false, error: "no_valid_access_token", message: "Chưa có access_token hợp lệ.", details: "no_valid_access_token" });
      }

      const { variantProducts, error, modelCount } = await fetchShopeeItemVariants(shopId, accessToken, itemId);
      if (error && variantProducts.length === 0) {
        return res.status(400).json({ success: false, error, message: error, details: String(error) });
      }
      if (variantProducts.length === 0) {
        return res.status(404).json({ success: false, error: "no_variants_found", message: "Không lấy được phân loại từ Shopee.", details: "no_variants_found" });
      }

      const allProducts = await loadProducts();
      const merged = replaceProductsForShopeeItem(allProducts, String(itemId), variantProducts);
      await saveProducts(merged);

      console.log(`[Shopee Variant Sync] item_id=${itemId} -> ${variantProducts.length} dong (modelCount=${modelCount})`);
      return res.json({
        success: true,
        itemId: String(itemId),
        variantCount: variantProducts.length,
        modelCount,
        variants: variantProducts,
        products: merged,
      });
    } catch (err: unknown) {
      console.error("[Shopee Variant Sync] Exception:", err);
      return sendApiErrorJson(res, err, 500);
    }
  });

  // --- Shopee logistics: "Chuẩn bị hàng" (ship_order) ------------------------

  async function processShipOrderBatch(
    orders: any[],
    toShip: { index: number; order: any }[],
    shipMethod: ShipMethod,
    opts?: {
      optimistic?: boolean;
      onProgress?: (completed: number, total: number) => void;
    }
  ): Promise<{ results: any[]; successfulShopeeOrders: any[]; successCount: number }> {
    const results: any[] = [];
    const successfulShopeeOrders: any[] = [];

    for (let i = 0; i < toShip.length; i++) {
      const { index, order } = toShip[i];
      const resolvedShopId = resolveOrderShopId(order);
      if (resolvedShopId && !order.shopId) {
        orders[index].shopId = resolvedShopId;
        order.shopId = resolvedShopId;
      }

      console.log(`[Ship Order Bulk] \u0110ang x\u1EED l\xFD \u0111\u01A1n ${order.orderSn} (id=${order.id}, ${shipMethod})...`);
      let result: Awaited<ReturnType<typeof arrangeShipment>>;
      try {
        result = await withOperationTimeout(
          arrangeShipment(order, shipMethod),
          SHIP_ORDER_OPERATION_TIMEOUT_MS,
          `Ship order ${order.orderSn}`,
        );
      } catch (error: any) {
        console.error(
          `[Ship Order Bulk] Exception khi chuẩn bị đơn ${order.orderSn} (id=${order.id}, method=${shipMethod}):`,
          error?.stack || error,
        );
        result = {
          success: false,
          error: "internal_server_error",
          message: "Lỗi nội bộ server: " + (error?.message || String(error)),
        };
      }
      const treatedAsSuccess = result.success || isAlreadyShippedError(result);

      if (!treatedAsSuccess) {
        console.error(`[Ship Order Bulk] TH\u1EA4T B\u1EA0I cho \u0111\u01A1n ${order.orderSn} -> error="${result.error || ""}" message="${result.message || ""}"`);
        if (opts?.optimistic) {
          orders[index] = {
            ...orders[index],
            status: "unprocessed",
            isPrepared: false,
            shopeeSyncPending: false,
            shopeeSyncError: result.message || result.error || "Kh\u00F4ng \u0111\u1ED3ng b\u1ED9 \u0111\u01B0\u1EE3c Shopee",
          };
        }
      } else {
        orders[index] = {
          ...orders[index],
          isPrepared: true,
          status: "processed",
          trackingNumber: orders[index].trackingNumber || result.trackingNumber,
          shopId: orders[index].shopId || result.shopId || resolvedShopId,
          shopeeSyncPending: false,
          shopeeSyncError: undefined,
        };
        if (orders[index].channel === "shopee") {
          successfulShopeeOrders.push(orders[index]);
        }
      }

      results.push({
        orderId: order.id,
        orderSn: order.orderSn,
        success: treatedAsSuccess,
        alreadyShipped: !result.success && isAlreadyShippedError(result),
        ...result,
      });

      if (opts?.onProgress) opts.onProgress(i + 1, toShip.length);

      if (i < toShip.length - 1) {
        await new Promise((r) => setTimeout(r, 400));
      }
    }

    return {
      results,
      successfulShopeeOrders,
      successCount: results.filter((r) => r.success).length,
    };
  }

  // Single order: arrange pickup/dropoff (per the seller's explicit choice in the
  // "Xác nhận đơn hàng" modal) so it moves to "Chờ lấy hàng".
  app.post("/api/shopee/ship-order", authMiddleware, async (req, res) => {
    try {
      const { orderId, method } = req.body;
      const shipMethod: ShipMethod = method === "dropoff" ? "dropoff" : "pickup";
      const orders = loadOrders();
      const order = orders.find((o: any) => o.id === orderId);
      if (!order) {
        return res.status(404).json({ error: "Kh\xF4ng t\xECm th\u1EA5y \u0111\u01A1n h\xE0ng." });
      }

      console.log(`[Ship Order] Y\xEAu c\u1EA7u chu\u1EA9n b\u1EB1 h\xE0ng (${shipMethod}) cho \u0111\u01A1n ${order.orderSn} (channel=${order.channel})...`);
      const result = await withOperationTimeout(
        arrangeShipment(order, shipMethod),
        SHIP_ORDER_OPERATION_TIMEOUT_MS,
        `Ship order ${order.orderSn}`,
      );
      console.log("D\u1EEE LI\u1EC6U SHOPEE TR\u1EA2 V\u1EC0:", JSON.stringify(result));

      if (!result.success) {
        console.error(`[Ship Order] TH\u1EA4T B\u1EA0I cho \u0111\u01A1n ${order.orderSn} -> error="${result.error || ""}" message="${result.message || ""}"`);
      }

      if (result.success) {
        const index = orders.findIndex((o: any) => o.id === orderId);
        orders[index] = {
          ...orders[index],
          isPrepared: true,
          // Move the order into "Chờ lấy hàng (Đã xử lý)" the INSTANT ship_order
          // succeeds — no need to wait for the print step to flip this anymore.
          status: "processed",
          trackingNumber: orders[index].trackingNumber || result.trackingNumber,
          shopId: orders[index].shopId || result.shopId, // self-heal orders that lost shop_id from an old webhook bug
        };
        saveOrders(orders);
        return res.json({ success: true, mode: result.mode, order: orders[index] });
      }
      return res.status(400).json({ success: false, ...result });
    } catch (error: any) {
      console.error("[Ship Order] Lỗi nội bộ endpoint /api/shopee/ship-order:", error?.stack || error);
      return res.status(500).json({ success: false, message: "Lỗi nội bộ server: " + error.message });
    }
  });

  // Bulk: arrange shipment for multiple orders at once ("Xác nhận Chuẩn bị hàng loạt"),
  // all using the single method (pickup/dropoff) the seller picked in the modal.
  // Accepts both orderIds and orderSns so the frontend can send whichever it has.
  // After all ship_order calls finish, automatically creates + downloads one merged
  // NORMAL_AIR_WAYBILL PDF for every successfully prepared Shopee order.
  app.post("/api/shopee/ship-order/bulk", authMiddleware, async (req, res) => {
    try {
    const { orderIds, orderSns, method } = req.body;
    const shipMethod: ShipMethod = method === "dropoff" ? "dropoff" : "pickup";
    const idList = Array.isArray(orderIds) ? orderIds : [];
    const snList = Array.isArray(orderSns) ? orderSns : [];
    if (idList.length === 0 && snList.length === 0) {
      return res.status(400).json({ error: "Thi\u1EBFu danh s\xE1ch orderIds ho\u1EB7c orderSns." });
    }

    const orders = loadOrders();
    const toShip = resolveOrdersFromRequest(orders, idList, snList);
    if (toShip.length === 0) {
      return res.status(404).json({
        error: "orders_not_found",
        message: "Kh\xF4ng t\xECm th\u1EA5y \u0111\u01A1n n\xE0o trong database kh\u1EDBp v\u1EDBi danh s\xE1ch g\u1EEDi l\xEAn.",
        successCount: 0,
        total: 0,
        results: [],
        orders: orders.filter(isValidOrder),
      });
    }

    const results: any[] = [];
    const successfulShopeeOrders: any[] = [];

    const batch = await processShipOrderBatch(orders, toShip, shipMethod);
    results.push(...batch.results);
    successfulShopeeOrders.push(...batch.successfulShopeeOrders);

    saveOrders(orders);
    const successCount = batch.successCount;
    console.log(`[Ship Order Bulk] Ho\xE0n t\u1EA5t: ${successCount}/${toShip.length} \u0111\u01A1n chu\u1EA9n b\u1EB1 h\xE0ng th\xE0nh c\xF4ng.`);

    console.log("D\u1EEE LI\u1EC6U SHOPEE TR\u1EA2 V\u1EC0 (ship-order/bulk response g\u1EEDi cho Frontend):", JSON.stringify({ successCount, total: toShip.length, results }));
    const failedResults = results.filter(r => !r.success);
    if (failedResults.length > 0) {
      console.error(`[Ship Order Bulk] ${failedResults.length} \u0111\u01A1n L\u1ED6I chi ti\u1EBFt:`);
      for (const f of failedResults) {
        console.error(`   - \u0111\u01A1n ${f.orderSn || f.orderId}: error="${f.error || ""}" message="${f.message || ""}"`);
      }
    }

    // Closed-loop bulk print: wait 2s then fetch one merged NORMAL_AIR_WAYBILL PDF.
    let printDocument: any = null;
    if (successfulShopeeOrders.length > 0) {
      console.log(`[Ship Order Bulk] T\u1EF1 \u0111\u1ED9ng l\u1EA5y v\u1EAD n g\u1ED9p cho ${successfulShopeeOrders.length} \u0111\u01A1n Shopee v\u1EEBa chu\u1EA9n b\u1EB1...`);
      printDocument = await autoPrintLabelsForShopeeOrders(orders, successfulShopeeOrders);
      if (printDocument?.printedOrderSns?.length) {
        const printedSet = new Set(printDocument.printedOrderSns);
        for (let i = 0; i < orders.length; i++) {
          if (printedSet.has(orders[i].orderSn)) {
            orders[i] = { ...orders[i], isPrinted: true, status: "processed" };
          }
        }
        saveOrders(orders);
      }
    }

    return res.json({
      successCount,
      total: toShip.length,
      results,
      orders: orders.filter(isValidOrder),
      printDocument,
    });
    } catch (error: any) {
      console.error("[Ship Order Bulk] Lỗi nội bộ endpoint /api/shopee/ship-order/bulk:", error?.stack || error);
      return res.status(500).json({ success: false, message: "Lỗi nội bộ server: " + error.message });
    }
  });

  // --- Shopee logistics: "In đơn hàng" (create + poll + download AWB PDF) ---

  const LABEL_DOWNLOAD_CONCURRENCY = 5;

  // Public, non-authenticated static folder (like Sapo): downloaded Shopee AWB
  // files are saved here and served directly at /labels/<file>, so the browser
  // can window.open() the link straight from a new tab and print it — no
  // Authorization header available on a plain tab navigation, so this MUST
  // live outside the authMiddleware-protected API routes.
  // NOTE: deliberately NOT named "public/" — Vite treats a root-level "public/"
  // folder as its own publicDir and copies its entire contents into dist/ on
  // every `npm run build`, which would bloat/leak generated AWB files into the
  // production bundle. "storage/waybills" is served via /api/public/labels (primary) and /labels fallback.
  ensureWaybillsDir();
  migrateLegacyWaybillFiles();
  scheduleWaybillsCleanup();

  app.get("/labels/:filename", (req, res, next) => {
    const result = serveLabelPdfFromDisk(req.params.filename, res);
    if (result === "not_found") return next();
  });

  app.use("/labels", express.static(SHIPPING_DOCS_DIR, {
    setHeaders(res, filePath) {
      if (filePath.endsWith(".pdf")) {
        const name = path.basename(filePath);
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `inline; filename="${name}"`);
      } else if (filePath.endsWith(".html")) {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
      }
      res.setHeader("Cache-Control", "private, max-age=3600");
    },
  }));

  function extensionForContentType(contentType: string): string {
    if (contentType.includes("zip")) return "zip";
    if (contentType.includes("html")) return "html";
    return "pdf";
  }

  // Concatenate multiple AWB PDF buffers into one multi-page document so
  // window.print() prints every order label in a single dialog.
  async function mergePdfBuffers(buffers: Buffer[]): Promise<Buffer> {
    if (buffers.length === 0) throw new Error("No PDF buffers to merge.");
    if (buffers.length === 1) return buffers[0];

    const mergedPdf = await PDFDocument.create();
    for (const buf of buffers) {
      const src = await PDFDocument.load(buf);
      const pages = await mergedPdf.copyPages(src, src.getPageIndices());
      for (const page of pages) mergedPdf.addPage(page);
    }
    return Buffer.from(await mergedPdf.save());
  }

  function buildMergedLabelFilename(orderSns: string[]): string {
    const safe = orderSns.map((sn) => String(sn).replace(/[^a-zA-Z0-9_-]/g, "")).filter(Boolean);
    const primarySn = safe[0] || "bulk";
    return safe.length > 1 ? `${primarySn}_gop_${safe.length}_don.pdf` : `${primarySn}.pdf`;
  }

  function findExistingLabelFile(orderSn: string): string | null {
    const fname = buildMergedLabelFilename([orderSn]);
    if (resolveLabelFilePath(fname)) {
      try {
        const filePath = resolveLabelFilePath(fname)!;
        const buf = fs.readFileSync(filePath);
        if (isPdfBuffer(buf)) return fname;
      } catch {
        /* ignore */
      }
    }
    return null;
  }

  function readExistingLabelBuffer(orderSn: string): Buffer | null {
    const fname = findExistingLabelFile(orderSn);
    if (!fname) return null;
    try {
      const filePath = resolveLabelFilePath(fname);
      if (!filePath) return null;
      const buf = fs.readFileSync(filePath);
      return isPdfBuffer(buf) ? buf : null;
    } catch {
      return null;
    }
  }

  function saveLabelFile(buffer: Buffer, filename: string, contentType?: string): string {
    if (!isPdfBuffer(buffer, contentType)) {
      console.error(
        `[Shopee Print] Từ chối lưu — dữ liệu không phải PDF: ${filename}, size=${buffer.length}, type=${contentType || ""}`
      );
      throw new Error("Dữ liệu vận đơn từ Shopee không phải PDF hợp lệ.");
    }
    fs.mkdirSync(SHIPPING_DOCS_DIR, { recursive: true });
    fs.writeFileSync(path.join(SHIPPING_DOCS_DIR, filename), buffer);
    console.log(`[Shopee Print] Đã lưu vận đơn (${buffer.length} bytes) → storage/waybills/${filename}`);
    return filename;
  }

  /** Lưu PDF nền (không chặn response stream về frontend). */
  function saveLabelFileAsync(buffer: Buffer, filename: string, contentType?: string): void {
    const copy = Buffer.from(buffer);
    setImmediate(() => {
      try {
        saveLabelFile(copy, filename, contentType);
      } catch (err) {
        console.warn(`[Shopee Print] Lưu nền thất bại ${filename}:`, err);
      }
    });
  }

  // Download AWB PDFs — parallel batches (5/lần), lưu cache từng đơn trên đĩa.
  async function downloadShippingDocumentsMerged(
    shopId: string,
    accessToken: string,
    cleanOrderList: { order_sn: string; package_number?: string; tracking_number?: string }[]
  ): Promise<{ buffer: Buffer; contentType: string; savedFiles: string[] } | { error: string; message?: string }> {
    if (cleanOrderList.length === 0) {
      return { error: "empty_order_list", message: "Không có đơn nào để tải vận đơn." };
    }

    const savedFiles: string[] = [];
    const pdfBuffers: Buffer[] = [];

    const cacheOne = (orderSn: string, buffer: Buffer, contentType?: string) => {
      const filename = buildMergedLabelFilename([orderSn]);
      saveLabelFile(buffer, filename, contentType);
      savedFiles.push(filename);
      pdfBuffers.push(buffer);
    };

    if (cleanOrderList.length === 1) {
      const single = await shopeeDownloadShippingDocument(shopId, accessToken, cleanOrderList);
      if (single.error || !single.buffer) {
        return { error: single.error || "download_failed", message: single.message };
      }
      cacheOne(cleanOrderList[0].order_sn, single.buffer, single.contentType);
      return { buffer: single.buffer, contentType: single.contentType || "application/pdf", savedFiles };
    }

    for (let i = 0; i < cleanOrderList.length; i += LABEL_DOWNLOAD_CONCURRENCY) {
      const chunk = cleanOrderList.slice(i, i + LABEL_DOWNLOAD_CONCURRENCY);
      for (const order of chunk) {
        try {
          const one = await shopeeDownloadShippingDocument(shopId, accessToken, [order]);
          if (one.buffer && isPdfBuffer(one.buffer, one.contentType)) {
            cacheOne(order.order_sn, one.buffer, one.contentType);
            console.log(`[Shopee Print] Cache ${order.order_sn} (${one.buffer.length} bytes).`);
          } else {
            console.warn(`[Shopee Print] Không tải PDF ${order.order_sn}: ${one.error || one.message || "unknown"}`);
          }
        } catch (err: any) {
          console.warn(`[Shopee Print] Download failed ${order.order_sn}:`, err?.message || err);
        }
        await sleep(SHOPEE_PRODUCT_API_DELAY_MS);
      }
      if (i + LABEL_DOWNLOAD_CONCURRENCY < cleanOrderList.length) {
        await sleep(SHOPEE_PRODUCT_BATCH_PAUSE_MS);
      }
    }

    if (pdfBuffers.length === 0) {
      try {
        const batch = await shopeeDownloadShippingDocument(shopId, accessToken, cleanOrderList);
        if (batch.error || !batch.buffer) {
          return { error: batch.error || "download_failed", message: batch.message };
        }
        const mergedName = buildMergedLabelFilename(cleanOrderList.map((o) => o.order_sn));
        saveLabelFile(batch.buffer, mergedName, batch.contentType);
        return { buffer: batch.buffer, contentType: batch.contentType || "application/pdf", savedFiles: [mergedName] };
      } catch (err: any) {
        return { error: "batch_download_failed", message: err?.message || String(err) };
      }
    }

    if (pdfBuffers.length < cleanOrderList.length) {
      console.warn(`[Shopee Print] Parallel: ${pdfBuffers.length}/${cleanOrderList.length} PDF — gộp các file đã có.`);
    }

    const merged = await mergePdfBuffers(pdfBuffers);
    const mergedName = buildMergedLabelFilename(cleanOrderList.map((o) => o.order_sn));
    saveLabelFile(merged, mergedName, "application/pdf");
    savedFiles.push(mergedName);
    return { buffer: merged, contentType: "application/pdf", savedFiles };
  }

  async function mergeLabelFilesToSingleUrl(filenames: string[], orderSns: string[]): Promise<string | null> {
    const pdfBuffers: Buffer[] = [];
    for (const name of filenames) {
      const full = resolveLabelFilePath(name);
      if (!full) continue;
      const buf = fs.readFileSync(full);
      if (isPdfBuffer(buf)) pdfBuffers.push(buf);
    }
    if (pdfBuffers.length === 0) return null;
    if (pdfBuffers.length === 1) return `/labels/${filenames[0]}`;

    const merged = await mergePdfBuffers(pdfBuffers);
    const mergedName = buildMergedLabelFilename(orderSns);
    saveLabelFile(merged, mergedName, "application/pdf");
    console.log(`[Shopee Print] Đã gộp ${pdfBuffers.length} file PDF thành 1 file duy nhất: ${mergedName}`);
    return `/labels/${mergedName}`;
  }

  // Generates one real Shopee AWB/label document (grouped per shop) for the
  // given orders, polls until Shopee finishes rendering it, downloads the raw
  // file and saves it locally so the frontend can open/print it via a URL.
  // The full create→poll→download pipeline is wrapped in a retry loop: Shopee
  // sometimes hasn't finished internally processing the order's logistics
  // status yet (transient "All failed, please check result_list for detail"),
  // so up to 3 retries (4 attempts total), 3s apart, before finally giving up.
  async function generateShopeeShippingDocument(shopId: string, orderList: { order_sn: string; package_number?: string; tracking_number?: string }[]) {
    const accessToken = await getValidShopeeAccessToken(shopId);
    if (!accessToken) {
      return { success: false, error: "no_valid_access_token", message: `Ch\u01B0a c\xF3 access_token h\u1EE3p l\u1EC7 cho shop_id=${shopId}.` };
    }

    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 3000;
    let lastError: { error?: string; message?: string } = {};

    for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
      const result: any = await tryGenerateShopeeShippingDocumentOnce(shopId, accessToken, orderList);
      if (result.success) return result;

      lastError = { error: result.error, message: result.message };
      console.error(`[Shopee Print] L\u1EA5y v\u1EAD n \u0111\u01A1n TH\u1EA4T B\u1EA0I (l\u1EA7n ${attempt}/${MAX_RETRIES + 1}) cho shop_id=${shopId}: error="${result.error}" message="${result.message}"`);

      // Permanent errors (order has no valid tracking number / never actually
      // shipped) will NEVER succeed no matter how many times we retry — bail
      // out immediately instead of wasting 3 more x3s round-trips to Shopee.
      if (result.permanent) {
        console.error(`[Shopee Print] L\u1ED7i "${result.error}" l\xE0 l\u1ED7i VĨNH VI\u1EC4N (\u0111\u01A1n ch\u01B0a th\u1EF1c s\u1EF1 \u0111\u01B0\u1EE3c "Chu\u1EA9n b\u1EB1 h\xE0ng"/ship_order th\xE0nh c\xF4ng tr\xEAn Shopee) — b\u1ECF qua c\xE1c l\u1EA7n th\u1EED l\u1EA1i.`);
        break;
      }

      if (attempt <= MAX_RETRIES) {
        console.log(`[Shopee Print] T\u1EF1 \u0111\u1ED9ng th\u1EED l\u1EA1i sau ${RETRY_DELAY_MS}ms...`);
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      }
    }

    console.error(`[Shopee Print] \u0110\xE3 th\u1EED l\u1EA1i t\u1ED1i \u0111a (${MAX_RETRIES} l\u1EA7n) v\u1EABn th\u1EA5t b\u1EA1i cho shop_id=${shopId}. B\u1ECF cu\u1ED9c, \u0111\xE1nh d\u1EA5u \u0111\u01A1n l\xE0 "Ch\u01B0a in".`);
    return { success: false, error: lastError.error, message: lastError.message };
  }

  // Shopee errors that mean the order genuinely has no valid tracking number /
  // logistics assignment yet (i.e. ship_order was never actually completed for
  // it on Shopee's side) — these are PERMANENT, not transient. Retrying with a
  // delay changes nothing, so the retry loop above should fail fast on these.
  const PERMANENT_SHOPEE_DOC_ERRORS = new Set([
    "logistics.tracking_number_invalid",
    "logistics.order_status_error",
    "error_param",
  ]);

  // One single create_shipping_document → poll → download attempt (no retry logic here).
  //
  // IMPORTANT (bulk fix): create_shipping_document can PARTIALLY fail inside a
  // batch — Shopee returns HTTP 200 with error:"" at the top level, but some
  // individual orders inside response.result_list carry their own fail_error
  // (e.g. "logistics.package_can_not_print" for one bad order among 35 good
  // ones). If we keep sending the ORIGINAL orderList (including that failed
  // order) to get_shipping_document_result/download_shipping_document, Shopee
  // rejects the WHOLE batch download with "logistics.shipping_document_should_
  // print_first" — one bad order poisons every other order's PDF. So: split
  // successes from failures right here, and only poll/download the orders
  // that actually got a package_number back.
  async function tryGenerateShopeeShippingDocumentOnce(shopId: string, accessToken: string, orderList: { order_sn: string; package_number?: string; tracking_number?: string }[]) {
    const createResult = await shopeeCreateShippingDocument(shopId, accessToken, orderList);
    const createList: any[] = createResult.response?.result_list || [];
    const failedItems: any[] = createList.filter((it: any) => it.fail_error);
    // Only orders that got a real package_number back are safe to poll/download.
    const okItems: any[] = createList.filter((it: any) => it.package_number && !it.fail_error);

    if (createResult.error && okItems.length === 0) {
      // Top-level error AND nothing usable in result_list — total failure.
      if (failedItems.length > 0) {
        const first = failedItems[0];
        const detail = failedItems.map((it: any) => `${it.order_sn}: ${it.fail_message || it.fail_error}`).join("; ");
        return {
          success: false,
          error: first.fail_error || createResult.error,
          message: failedItems.length > 1 ? `${failedItems.length} \u0111\u01A1n l\u1ED7i: ${detail}` : (first.fail_message || detail),
          permanent: PERMANENT_SHOPEE_DOC_ERRORS.has(first.fail_error),
        };
      }
      return { success: false, error: createResult.error, message: createResult.message, permanent: PERMANENT_SHOPEE_DOC_ERRORS.has(createResult.error) };
    }

    if (okItems.length === 0) {
      // No top-level error, but every order in this batch individually failed.
      const detail = failedItems.map((it: any) => `${it.order_sn}: ${it.fail_message || it.fail_error}`).join("; ");
      return {
        success: false,
        error: failedItems[0]?.fail_error || "document_generation_failed",
        message: detail || "Kh\xF4ng c\xF3 \u0111\u01A1n n\xE0o t\u1EA1o v\u1EAD n th\xE0nh c\xF4ng trong l\u1EA7n g\u1ECDi n\xE0y.",
        permanent: PERMANENT_SHOPEE_DOC_ERRORS.has(failedItems[0]?.fail_error),
      };
    }

    // Rebuild orderList from ONLY the successfully-created items, carrying over
    // each order's real package_number (required by poll/download) and any
    // tracking_number we already had, keyed by order_sn.
    const originalBySn = new Map(orderList.map(o => [o.order_sn, o]));
    const cleanOrderList = okItems.map((it: any) => ({
      order_sn: it.order_sn,
      package_number: it.package_number,
      tracking_number: originalBySn.get(it.order_sn)?.tracking_number,
    }));
    const skippedOrders = failedItems.map((it: any) => ({ orderSn: it.order_sn, error: it.fail_error, message: it.fail_message }));
    if (skippedOrders.length > 0) {
      console.warn(`[Shopee Print] ${skippedOrders.length}/${orderList.length} \u0111\u01A1n b\u1ECB lo\u1EB7i b\u1ECF kh\u1ECFi l\u1EA7n t\u1EA1o v\u1EAD n n\xE0y (kh\xF4ng \u1EA3nh h\u01B0\u1EDFng \u0111\u1EBFn ${cleanOrderList.length} \u0111\u01A1n c\xF2n l\u1EA1i): ${JSON.stringify(skippedOrders)}`);
    }

    // Poll get_shipping_document_result until READY/FAILED. First wait 2s after
    // create_shipping_document — Shopee needs a moment to actually render the
    // AWB before it's ready to be fetched (matches the create -> 2s -> fetch flow).
    let status = "PROCESSING";
    let attempts = 0;
    while (status === "PROCESSING" && attempts < 6) {
      await new Promise(r => setTimeout(r, 2000));
      const pollResult = await shopeeGetShippingDocumentResult(shopId, accessToken, cleanOrderList);
      const items: any[] = pollResult.response?.result_list || [];
      // Consider the batch READY once none of the still-pending items are PROCESSING.
      const anyProcessing = items.some((it: any) => it.status === "PROCESSING");
      const anyFailed = items.some((it: any) => it.status === "FAILED");
      status = anyProcessing ? "PROCESSING" : (anyFailed && items.every((it: any) => it.status !== "READY") ? "FAILED" : "READY");
      if (status === "FAILED") {
        const item = items[0];
        return { success: false, error: item?.fail_error || "document_generation_failed", message: item?.fail_message || "Shopee kh\xF4ng th\u1EC3 t\u1EA1o v\u1EAD n \u0111\u01A1n cho \u0111\u01A1n h\xE0ng n\xE0y (c\xF3 th\u1EC3 \u0111\u01A1n ch\u01B0a \u1EDF tr\u1EA1ng th\xE1i \u0111\xE3 x\u1EED l\xFD)." };
      }
      attempts++;
    }
    if (status !== "READY") {
      return { success: false, error: "document_still_processing", message: "Shopee v\u1EABn \u0111ang x\u1EED l\xFD v\u1EAD n \u0111\u01A1n, vui l\xF2ng th\u1EED l\u1EA1i sau v\xE0i gi\xE2y." };
    }

    const downloadResult = await downloadShippingDocumentsMerged(shopId, accessToken, cleanOrderList);
    if ("error" in downloadResult || !downloadResult.buffer) {
      return { success: false, error: (downloadResult as any).error, message: (downloadResult as any).message };
    }
    if (downloadResult.buffer.length < 128) {
      return {
        success: false,
        error: "empty_label_file",
        message: "Shopee trả về file vận đơn rỗng — vui lòng thử lại sau khi đơn đã có mã vận đơn thật (SPXVN...).",
      };
    }

    const ext = extensionForContentType(downloadResult.contentType);
    const orderSns = cleanOrderList.map((o: any) => o.order_sn);
    const filename = ext === "pdf" ? buildMergedLabelFilename(orderSns) : `${orderSns[0] || `shop-${shopId}`}.${ext}`;
    const alreadyCached = "savedFiles" in downloadResult && downloadResult.savedFiles.includes(filename);
    if (!alreadyCached) {
      saveLabelFile(downloadResult.buffer, filename, downloadResult.contentType);
    }
    console.log(`[Shopee Print] Cached vận đơn (${cleanOrderList.length} đơn → ${filename}, ${downloadResult.buffer.length} bytes).`);

    return {
      success: true,
      filename,
      contentType: downloadResult.contentType,
      orderSns,
      skippedOrders,
      url: absoluteLabelUrl(`/labels/${filename}`),
    };
  }

  // Shared helper: after a bulk (or single) ship_order run, wait 4s then create +
  // download one merged NORMAL_AIR_WAYBILL PDF per shop for the given orders.
  async function autoPrintLabelsForShopeeOrders(allOrders: any[], shopeeOrders: any[]) {
    const candidates = shopeeOrders.filter((o: any) => o.channel === "shopee" && (o.shopId || resolveOrderShopId(o)));
    if (candidates.length === 0) return null;

    for (const o of candidates) {
      if (!o.shopId) {
        const resolved = resolveOrderShopId(o);
        if (resolved) {
          o.shopId = resolved;
          const idx = allOrders.findIndex((x: any) => x.orderSn === o.orderSn);
          if (idx >= 0) allOrders[idx].shopId = resolved;
        }
      }
    }

    const groups: Record<string, any[]> = {};
    for (const o of candidates) {
      if (!o.shopId) continue;
      groups[o.shopId] = groups[o.shopId] || [];
      groups[o.shopId].push(o);
    }

    for (const [shopId, groupOrders] of Object.entries(groups)) {
      const accessToken = await getValidShopeeAccessToken(shopId);
      if (!accessToken) continue;
      for (const o of groupOrders) {
        if (o.trackingNumber && isCarrierTrackingCode(o.trackingNumber)) continue;
        const trackResult = await shopeeGetTrackingNumber(shopId, accessToken, o.orderSn, o.packageNumber);
        applyShopeeGetTrackingResponse(o, trackResult);
        const idx = allOrders.findIndex((x: any) => x.orderSn === o.orderSn);
        if (idx >= 0) {
          allOrders[idx].trackingNumber = o.trackingNumber;
          allOrders[idx].internalTrackingCode = o.internalTrackingCode;
        }
      }
    }
    saveOrders(allOrders);

    // Shopee needs ~4s after a bulk ship_order run before AWB/tracking numbers are
    // ready for create_shipping_document — 2s was too fast for newly created orders.
    console.log(`[Ship Order Bulk Auto-Print] Ch\u1EDD 4 gi\xE2y \u0111\u1EC3 Shopee kh\u1EDfi t\u1EA1o m\xE3 v\u1EADn \u0111\u01A1n cho ${candidates.length} \u0111\u01A1n...`);
    await new Promise(r => setTimeout(r, 4000));

    const printedOrderSns: string[] = [];
    const skippedOrders: any[] = [];
    const savedFilenames: string[] = [];
    const pdfBuffers: Buffer[] = [];

    for (const [shopId, groupOrders] of Object.entries(groups)) {
      const orderList = groupOrders.map((o: any) => ({
        order_sn: o.orderSn,
        package_number: o.packageNumber,
        tracking_number: trackingForShopeeShippingDoc(o),
      }));
      console.log(`[Ship Order Bulk Auto-Print] Tạo vận gộp ${orderList.length} đơn shop_id=${shopId}...`);
      const docResult = await generateShopeeShippingDocument(shopId, orderList);
      if (docResult.success && docResult.filename) {
        savedFilenames.push(docResult.filename);
        if (docResult.buffer && isPdfBuffer(docResult.buffer)) pdfBuffers.push(docResult.buffer);
        printedOrderSns.push(...(docResult.orderSns || groupOrders.map((o: any) => o.orderSn)));
        if (Array.isArray(docResult.skippedOrders)) skippedOrders.push(...docResult.skippedOrders);
      } else {
        console.error(`[Ship Order Bulk Auto-Print] Thất bại shop_id=${shopId}: ${docResult.error} - ${docResult.message}`);
        skippedOrders.push({ shopId, error: docResult.error, message: docResult.message });
      }
    }

    let primaryUrl: string | null = null;
    let pdfBase64: string | null = null;
    let pdfFilename: string | null = null;

    if (pdfBuffers.length > 0) {
      const mergedBuf = pdfBuffers.length === 1 ? pdfBuffers[0] : await mergePdfBuffers(pdfBuffers);
      pdfFilename = buildMergedLabelFilename(printedOrderSns);
      pdfBase64 = mergedBuf.toString("base64");
      primaryUrl = `/labels/${pdfFilename}`;
      saveLabelFileAsync(mergedBuf, pdfFilename, "application/pdf");
    } else if (savedFilenames.length > 0) {
      primaryUrl = await mergeLabelFilesToSingleUrl(savedFilenames, printedOrderSns);
    }

    if (!primaryUrl && !pdfBase64) {
      return { url: null, printedOrderSns, skippedOrders, message: "Kh\xF4ng t\u1EA1o \u0111\u01B0\u1EE3c v\u1EAD n \u0111\u01A1n t\u1EF1 \u0111\u1ED9ng sau khi chu\u1EA9n b\u1EB1 h\xE0ng." };
    }
    return { url: primaryUrl, pdfBase64, pdfFilename, printedOrderSns, skippedOrders };
  }

  async function executeShipOrderBackgroundJob(
    jobId: string,
    shipMethod: ShipMethod,
    idList: string[],
    snList: string[]
  ): Promise<void> {
    pruneOldShipOrderJobs();
    const job = shipOrderJobs.get(jobId);
    if (!job) return;

    if (!tryAcquireHeavyJob(`ship-order:${jobId}`)) {
      job.status = "failed";
      job.error = "heavy_job_busy";
      job.updatedAt = Date.now();
      return;
    }

    try {
      job.status = "running";
      job.updatedAt = Date.now();

      const orders = loadOrders();
      const toShip = resolveOrdersFromRequest(orders, idList, snList);
      job.total = toShip.length;

      const batch = await processShipOrderBatch(orders, toShip, shipMethod, {
        optimistic: true,
        onProgress: (completed, total) => {
          job.completed = completed;
          job.total = total;
          job.updatedAt = Date.now();
        },
      });

      saveOrders(orders);
      job.results = batch.results;
      job.successCount = batch.successCount;
      job.orders = orders.filter(isValidOrder);

      if (batch.successfulShopeeOrders.length > 0) {
        job.status = "printing";
        job.updatedAt = Date.now();
        const printDocument = await autoPrintLabelsForShopeeOrders(orders, batch.successfulShopeeOrders);
        if (printDocument?.printedOrderSns?.length) {
          const printedSet = new Set(printDocument.printedOrderSns);
          for (let i = 0; i < orders.length; i++) {
            if (printedSet.has(orders[i].orderSn)) {
              orders[i] = { ...orders[i], isPrinted: true, status: "processed" };
            }
          }
          saveOrders(orders);
        }
        job.printDocument = printDocument;
        job.orders = orders.filter(isValidOrder);
      }

      job.status = "done";
    } catch (err: any) {
      job.status = "failed";
      job.error = err?.message || String(err);
      console.error(`[Ship Order Job ${jobId}] Failed:`, err);
    } finally {
      job.updatedAt = Date.now();
      releaseHeavyJob(`ship-order:${jobId}`);
    }
  }

  // Non-blocking bulk ship: ghi nhận ngay trạng thái processed, Shopee + in vận đơn chạy ngầm.
  app.post("/api/shopee/ship-order/bulk-async", authMiddleware, async (req, res) => {
    try {
    const { orderIds, orderSns, method } = req.body;
    const shipMethod: ShipMethod = method === "dropoff" ? "dropoff" : "pickup";
    const idList = Array.isArray(orderIds) ? orderIds.map(String) : [];
    const snList = Array.isArray(orderSns) ? orderSns.map(String) : [];
    if (idList.length === 0 && snList.length === 0) {
      return res.status(400).json({ error: "Thi\u1EBFu danh s\xE1ch orderIds ho\u1EB7c orderSns." });
    }

    const orders = loadOrders();
    const toShip = resolveOrdersFromRequest(orders, idList, snList);
    if (toShip.length === 0) {
      return res.status(404).json({
        error: "orders_not_found",
        message: "Kh\xF4ng t\xECm th\u1EA5y \u0111\u01A1n n\xE0o trong database kh\u1EDBp v\u1EDBi danh s\xE1ch g\u1EEDi l\xEAn.",
        successCount: 0,
        total: 0,
        results: [],
        orders: orders.filter(isValidOrder),
      });
    }

    for (const { index } of toShip) {
      orders[index] = {
        ...orders[index],
        isPrepared: true,
        status: "processed",
        shopeeSyncPending: true,
        shopeeSyncError: undefined,
      };
    }
    saveOrders(orders);

    const jobId = createShipOrderJobId();
    shipOrderJobs.set(jobId, {
      id: jobId,
      status: "pending",
      total: toShip.length,
      completed: 0,
      successCount: 0,
      results: [],
      printDocument: null,
      orders: orders.filter(isValidOrder),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    setImmediate(() => {
      void executeShipOrderBackgroundJob(jobId, shipMethod, idList, snList);
    });

    return res.status(202).json({
      accepted: true,
      jobId,
      total: toShip.length,
      orders: orders.filter(isValidOrder),
    });
    } catch (error: any) {
      console.error("[Ship Order Bulk Async] Lỗi nội bộ endpoint /api/shopee/ship-order/bulk-async:", error?.stack || error);
      return res.status(500).json({ success: false, message: "Lỗi nội bộ server: " + error.message });
    }
  });

  app.get("/api/shopee/ship-order/job/:jobId", authMiddleware, async (req, res) => {
    const job = shipOrderJobs.get(String(req.params.jobId || ""));
    if (!job) {
      return res.status(404).json({
        error: "job_not_found",
        message: "Kh\xF4ng t\xECm th\u1EA5y ti\u1EBFn tr\xECnh x\u1EED l\xFD.",
      });
    }
    return res.json(job);
  });

  // Single or bulk print: fetch the REAL Shopee AWB PDF for the given orders.
  app.post("/api/shopee/print-document", authMiddleware, async (req, res) => {
    try {
    const { orderIds } = req.body;
    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      return res.status(400).json({ error: "Thi\u1EBFu danh s\xE1ch orderIds." });
    }

    const orders = loadOrders();
    const idSet = new Set(orderIds.map(String));
    const targetOrders = orders.filter(
      (o: any) => idSet.has(String(o.id)) || idSet.has(String(o.orderSn)) || idSet.has(`shopee-${o.orderSn}`),
    );

    // Self-heal orders that lost shop_id from the old webhook-normalization bug —
    // resolveOrderShopId() falls back to the single connected Shopee shop when
    // an order's own shopId field is missing. Persist the fix back onto the
    // order in-place so it doesn't need to be resolved again next time.
    for (const o of targetOrders) {
      if (o.channel === "shopee" && !o.shopId) {
        const resolved = resolveOrderShopId(o);
        if (resolved) o.shopId = resolved;
      }
    }

    const shopeeCandidates = targetOrders.filter((o: any) => o.channel === "shopee" && o.shopId);

    // Deliberately NOT gating on order.isPrepared (local ship_order flag) anymore.
    // Per explicit product decision, if the order is genuinely ready on Shopee's
    // side, calling create_shipping_document/get_shipping_document must be allowed
    // straight away — Shopee itself is the single source of truth for whether the
    // order's logistics status actually supports document generation; if it
    // doesn't, Shopee's own API call below will return its own real error/message,
    // which is already logged and surfaced to the frontend as-is (no more local
    // "orders_not_prepared" pre-check blocking the request beforehand).
    if (shopeeCandidates.length === 0) {
      return res.status(400).json({ error: "Kh\xF4ng c\xF3 \u0111\u01A1n Shopee th\u1EADt n\xE0o (c\xF3 shop_id) trong danh s\xE1ch \u0111\u01B0\u1EE3c ch\u1ECDn \u0111\u1EC3 in v\u1EAD n." });
    }

    // Group by shop_id — create_shipping_document is per-shop.
    const groups: Record<string, any[]> = {};
    for (const o of shopeeCandidates) {
      groups[o.shopId] = groups[o.shopId] || [];
      groups[o.shopId].push(o);
    }

    // create_shipping_document REQUIRES a real tracking_number for integrated
    // channels (Shopee's own 3PL, e.g. SPX) — this is the actual root cause of
    // "logistics.tracking_number_invalid" even for an order that is genuinely
    // "Đang giao" with a valid tracking number on Shopee's own platform: we were
    // simply never sending that tracking_number in the request body. Resolve +
    // persist it here (from cache, or freshly via get_tracking_number) before
    // building each shop's order_list.
    for (const [shopId, groupOrders] of Object.entries(groups)) {
      const accessToken = await getValidShopeeAccessToken(shopId);
      if (!accessToken) continue;
      await runInBatches(
        groupOrders,
        4,
        async (o) => {
          if (o.trackingNumber && isCarrierTrackingCode(o.trackingNumber)) return;
          try {
            const trackResult = await shopeeGetTrackingNumber(shopId, accessToken, o.orderSn, o.packageNumber);
            applyShopeeGetTrackingResponse(o, trackResult);
            const idx = orders.findIndex((x: any) => x.orderSn === o.orderSn);
            if (idx >= 0) {
              orders[idx].trackingNumber = o.trackingNumber;
              orders[idx].internalTrackingCode = o.internalTrackingCode;
              console.log(`[Shopee Print] Đã lấy tracking cho đơn ${o.orderSn}: carrier=${o.trackingNumber || "—"}, internal=${o.internalTrackingCode || "—"}.`);
            } else if (!trackResult.response?.tracking_number) {
              console.error(`[Shopee Print] Không lấy được tracking_number cho đơn ${o.orderSn} (get_tracking_number trả về: ${JSON.stringify(trackResult)}). create_shipping_document có thể sẽ bị từ chối.`);
            }
          } catch (trackErr: any) {
            console.warn(`[Shopee Print] Tracking fetch failed ${o.orderSn}:`, trackErr?.message || trackErr);
          }
        },
        { itemDelayMs: SHOPEE_PRODUCT_API_DELAY_MS, batchPauseMs: SHOPEE_PRODUCT_BATCH_PAUSE_MS },
      );
    }
    saveOrders(orders);

    const documents: any[] = [];
    const savedFilenames: string[] = [];
    const allPrintedSns: string[] = [];

    const labelUrl = (filename: string) => absoluteLabelUrl(`/labels/${filename}`);

    for (const [shopId, groupOrders] of Object.entries(groups)) {
      const needsGenerate: any[] = [];

      for (const o of groupOrders) {
        const cachedBuf = readExistingLabelBuffer(o.orderSn);
        if (cachedBuf) {
          const existing = buildMergedLabelFilename([o.orderSn]);
          savedFilenames.push(existing);
          allPrintedSns.push(o.orderSn);
          documents.push({
            shopId,
            orderSns: [o.orderSn],
            url: labelUrl(existing),
            contentType: "application/pdf",
            fromCache: true,
          });
        } else {
          needsGenerate.push(o);
        }
      }

      if (needsGenerate.length === 0) continue;

      const orderList = needsGenerate.map((o: any) => ({
        order_sn: o.orderSn,
        package_number: o.packageNumber,
        tracking_number: trackingForShopeeShippingDoc(o),
      }));
      console.log(`[Shopee Print] Đang tạo vận đơn cho ${orderList.length} đơn của shop_id=${shopId}...`);
      const docResult = await generateShopeeShippingDocument(shopId, orderList);

      if (docResult.success && docResult.filename) {
        savedFilenames.push(docResult.filename);
        const sns = docResult.orderSns || needsGenerate.map((o: any) => o.orderSn);
        allPrintedSns.push(...sns);
        const docUrl = docResult.url || labelUrl(docResult.filename);
        documents.push({
          shopId,
          orderSns: sns,
          url: docUrl,
          contentType: docResult.contentType,
        });
        if (Array.isArray(docResult.skippedOrders) && docResult.skippedOrders.length > 0) {
          for (const skipped of docResult.skippedOrders) {
            documents.push({
              shopId,
              orderSns: [skipped.orderSn],
              success: false,
              error: skipped.error,
              message: skipped.message,
            });
          }
        }
      } else {
        for (const o of needsGenerate) {
          const cachedBuf = readExistingLabelBuffer(o.orderSn);
          if (cachedBuf) {
            const existing = buildMergedLabelFilename([o.orderSn]);
            savedFilenames.push(existing);
            allPrintedSns.push(o.orderSn);
            documents.push({
              shopId,
              orderSns: [o.orderSn],
              url: labelUrl(existing),
              contentType: "application/pdf",
              fromCache: true,
            });
          } else {
            documents.push({
              shopId,
              orderSns: [o.orderSn],
              success: false,
              error: docResult.error,
              message: docResult.message,
            });
          }
        }
      }
    }

    let primaryUrl: string | null = null;
    let pdfFilename: string | null = null;

    if (allPrintedSns.length > 0) {
      pdfFilename = buildMergedLabelFilename(allPrintedSns);
      const mergedOnDisk = resolveLabelFilePath(pdfFilename);
      if (!mergedOnDisk && savedFilenames.length > 1) {
        primaryUrl = await mergeLabelFilesToSingleUrl(savedFilenames, allPrintedSns);
        if (primaryUrl) primaryUrl = absoluteLabelUrl(primaryUrl);
      } else if (mergedOnDisk) {
        primaryUrl = labelUrl(pdfFilename);
      } else if (savedFilenames.length === 1) {
        primaryUrl = labelUrl(savedFilenames[0]);
        pdfFilename = savedFilenames[0];
      } else {
        primaryUrl = documents.find((d: any) => d.url)?.url || null;
        pdfFilename = savedFilenames[0] || null;
      }
    } else {
      primaryUrl = documents.find((d: any) => d.url)?.url || null;
    }

    // Mark successfully-printed orders (isPrinted=true, and auto-advance status like the old UI mock did).
    const printedOrderSns = new Set(allPrintedSns);
    const updatedOrders = orders.map((o: any) => {
      if (printedOrderSns.has(o.orderSn)) {
        return { ...o, isPrinted: true, status: o.isPrepared ? "processed" : o.status };
      }
      return o;
    });
    saveOrders(updatedOrders);

    console.log(`[Shopee Print] Ho\xE0n t\u1EA5t: ${documents.filter(d => d.url).length}/${Object.keys(groups).length} nh\xF3m shop t\u1EA1o v\u1EAD n th\xE0nh c\xF4ng.`);

    scheduleWaybillsCleanup();

    return res.json({
      mergedUrl: primaryUrl,
      pdfFilename,
      documents: documents.map((d: any) =>
        d.url
          ? {
              ...d,
              url: d.url.startsWith("http") ? d.url : absoluteLabelUrl(d.url.startsWith("/") ? d.url : `/labels/${d.url}`),
            }
          : d,
      ),
      orders: updatedOrders.filter(isValidOrder),
      shippingDocumentType: SHOPEE_SHIPPING_DOCUMENT_TYPE,
      openMode: "new_tab_pdf",
    });
    } catch (error: any) {
      console.error("[Shopee Print] fatal:", error?.response?.data || error?.message || error);
      return res.status(500).json({
        error: error?.message || "print_document_failed",
        message: error?.message || "Tạo vận đơn Shopee thất bại",
      });
    }
  });

  let ai: GoogleGenAI | null = null;
  if (process.env.GEMINI_API_KEY) {
    ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  } else {
    console.warn("Warning: GEMINI_API_KEY is not configured in .env");
  }

  const initGeminiClient = (apiKey: string) => {
    return new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: { "User-Agent": "aistudio-build" },
      },
    });
  };

  app.get("/api/settings/channels", authMiddleware, async (_req, res) => {
    try {
      const settings = loadChannelSettings();
      return res.json({
        success: true,
        settings,
        path: CHANNEL_SETTINGS_PATH,
        shopCount: Array.isArray(settings.shops) ? settings.shops.length : 0,
      });
    } catch (error: any) {
      logOAuthSaveError("GET /api/settings/channels", error);
      return res.status(500).json({
        success: false,
        error: error?.message || "load_failed",
        message: "Không đọc được cấu hình gian hàng",
      });
    }
  });

  app.put("/api/settings/channels", authMiddleware, async (req, res) => {
    try {
      const incoming = req.body?.settings;
      if (!incoming || typeof incoming !== "object") {
        return res.status(400).json({
          success: false,
          error: "invalid_settings",
          message: "Thiếu trường settings trong body",
        });
      }
      const onDisk = loadChannelSettings();
      const incomingShops = Array.isArray(incoming.shops) ? incoming.shops : [];
      const mergedShops = upsertShopsInChannelSettings(onDisk.shops || [], incomingShops);

      if (incomingShops.length > 0 && mergedShops.length === 0) {
        return res.status(400).json({
          success: false,
          error: "invalid_shop_schema",
          message: "Dữ liệu shop thiếu trường bắt buộc (platform, shopId, shopName, apiKey)",
        });
      }

      const payload = { ...DEFAULT_CHANNEL_SETTINGS, ...onDisk, ...incoming, shops: mergedShops };
      if (!saveChannelSettings(payload)) {
        return res.status(500).json({
          success: false,
          error: "save_failed",
          message: "Không ghi được file channel_settings.json trên máy chủ",
        });
      }
      const saved = loadChannelSettings();
      console.log(
        "[Channel Settings] PUT OK — shop_ids:",
        (saved.shops || []).map((s: any) => s.shopId).join(", ") || "(trống)",
      );
      return res.json({ success: true, settings: saved, shopCount: saved.shops?.length ?? 0 });
    } catch (error: any) {
      logOAuthSaveError("PUT /api/settings/channels", error);
      return res.status(500).json({
        success: false,
        error: error?.message || "save_failed",
        message: "Lưu cấu hình gian hàng thất bại",
      });
    }
  });

  app.get("/api/settings/gemini-status", authMiddleware, async (_req, res) => {
    const key = process.env.GEMINI_API_KEY || "";
    const configured = Boolean(key && key !== "chua_co_key_tam_thoi");
    return res.json({
      success: true,
      configured,
      maskedKey: configured ? maskApiKey(key) : "",
    });
  });

  app.post("/api/settings/update-gemini-key", authMiddleware, async (req, res) => {
    try {
      const { apiKey } = req.body || {};
      const trimmed = String(apiKey || "").trim();
      if (!trimmed) {
        return res.status(400).json({ success: false, error: "Vui lòng nhập Gemini API Key." });
      }
      updateEnvVar("GEMINI_API_KEY", trimmed);
      ai = initGeminiClient(trimmed);
      return res.json({ success: true, message: "Đã cập nhật API Key thành công!" });
    } catch (error: any) {
      return res.status(500).json({ success: false, error: error.message || "Lưu API Key thất bại" });
    }
  });

  app.post("/api/settings/test-gemini-key", authMiddleware, async (req, res) => {
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
    } catch (error: any) {
      console.error("[Gemini test]", error);
      return res.status(400).json({ success: false, error: "API Key không hợp lệ" });
    }
  });

  async function checkShopConnectionStatus(shop: any): Promise<{ online: boolean; message: string }> {
    if (!shop?.connected) {
      return { online: false, message: "Đồng bộ đang tắt" };
    }

    if (shop.platform === "shopee") {
      try {
        if (!isShopeeConfigValid()) {
          return { online: false, message: "Shopee Partner ID/Key chưa cấu hình" };
        }
        const configuredId = normalizeShopIdKey(String(shop.shopId || ""));
        const oauthShopIds = listShopeeOAuthShopIds();
        const tokens = loadShopeeTokens();
        const record = configuredId ? getShopeeTokenRecord(tokens, configuredId) : null;
        const token = configuredId ? await getValidShopeeAccessToken(configuredId) : null;

        if (token && record) {
          const apiShopId = resolveShopeeApiShopId(record, configuredId);
          const ping = await verifyShopeeShopToken(apiShopId, token);
          if (ping.ok) {
            return { online: true, message: `OAuth token hợp lệ (Shopee API OK, shop_id=${apiShopId})` };
          }
          return {
            online: false,
            message: `Có token trong file nhưng Shopee từ chối shop_id=${apiShopId}: ${ping.error || "invalid_token"}. Cần OAuth lại đúng shop ${configuredId}.`,
          };
        }

        const lastOAuth = loadLastOAuthAudit();
        if (
          lastOAuth?.expected_shop_id === configuredId &&
          lastOAuth?.shop_mismatch &&
          lastOAuth?.callback_shop_id
        ) {
          return {
            online: false,
            message: `OAuth gần nhất: Shopee trả shop ${lastOAuth.callback_shop_id}, không phải ${configuredId}. Đăng xuất Shopee Seller, đăng nhập shop ${configuredId}, bấm OAuth lại.`,
          };
        }

        if (oauthShopIds.length > 0) {
          return {
            online: false,
            message: `Shop ID cấu hình "${shop.shopId || "(trống)"}" chưa có token. OAuth đã lưu: [${oauthShopIds.join(", ")}] — kiểm tra Shop ID có đúng trên Shopee Seller Center không.`,
          };
        }
        return { online: false, message: "Chưa OAuth hoặc token hết hạn" };
      } catch (error: any) {
        console.error("[Shop connection] Shopee check failed:", shop?.shopId, error);
        return { online: false, message: error?.message || "Lỗi kiểm tra kết nối Shopee" };
      }
    }

    if (shop.platform === "woocommerce") {
      const base = String(shop.wooUrl || "").replace(/\/$/, "");
      const key = String(shop.shopId || "").trim();
      const secret = String(shop.apiSecret || shop.apiKey || "").trim();
      if (!base || !key) {
        return { online: false, message: "Thiếu URL hoặc Consumer Key" };
      }
      try {
        const auth = Buffer.from(`${key}:${secret}`).toString("base64");
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        const res = await fetch(`${base}/wp-json/wc/v3/system_status`, {
          headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (res.ok) {
          return { online: true, message: "WooCommerce REST API phản hồi OK" };
        }
        return { online: false, message: `WooCommerce trả HTTP ${res.status}` };
      } catch (error: any) {
        return { online: false, message: error?.message || "Không kết nối được WooCommerce" };
      }
    }

    if (shop.platform === "tiktok") {
      if (shop.shopId && shop.apiKey) {
        return { online: true, message: "Credentials TikTok Shop đã cấu hình" };
      }
      return { online: false, message: "Thiếu Seller ID hoặc API Key" };
    }

    return { online: false, message: "Nền tảng không hỗ trợ" };
  }

  app.get("/api/shopee/oauth-shops", authMiddleware, async (_req, res) => {
    const tokens = loadShopeeTokens();
    const shopIds = listShopeeOAuthShopIds();
    const details = shopIds.map((id) => ({
      shop_id: id,
      obtained_at: tokens[id]?.obtained_at ?? null,
      expire_in: tokens[id]?.expire_in ?? null,
      oauth_shop_id: tokens[id]?.oauth_shop_id ?? null,
      shop_id_list: tokens[id]?.shop_id_list ?? [],
    }));
    let lastOAuth: any = loadLastOAuthAudit();
    return res.json({
      success: true,
      shopIds,
      details,
      tokensPath: SHOPEE_TOKENS_PATH,
      appRoot: APP_ROOT,
      lastOAuth,
      count: shopIds.length,
    });
  });

  app.get("/api/shopee/auth-url", authMiddleware, async (req, res) => {
    if (!isShopeeConfigValid()) {
      return res.status(500).json({
        success: false,
        error: "invalid_partner_config",
        message: "SHOPEE_PARTNER_ID / SHOPEE_PARTNER_KEY chưa cấu hình trên backend cPanel.",
      });
    }
    const shopId = normalizeShopIdKey(String(req.query.shop_id || ""));
    if (!shopId) {
      return res.status(400).json({
        success: false,
        error: "shop_id_required",
        message: "Cần shop_id (VD: 241215004) để tạo link ủy quyền OAuth.",
      });
    }
    return res.json({
      success: true,
      shop_id: shopId,
      url: buildShopeeAuthPartnerUrl(shopId),
      callback: SHOPEE_CALLBACK_URL,
    });
  });

  app.post("/api/settings/shop-connection-status", authMiddleware, async (req, res) => {
    try {
      const shops = Array.isArray(req.body?.shops) ? req.body.shops : [];
      const statuses: Record<string, { online: boolean; message: string }> = {};
      for (const shop of shops) {
        if (!shop?.id) continue;
        try {
          statuses[shop.id] = await Promise.race([
            checkShopConnectionStatus(shop),
            new Promise<{ online: boolean; message: string }>((_, reject) => {
              setTimeout(() => reject(new Error("Timeout kiểm tra kết nối (15s)")), 15_000);
            }),
          ]);
        } catch (shopErr: any) {
          console.error("[Shop connection-status] shop failed:", shop?.id, shopErr);
          statuses[shop.id] = {
            online: false,
            message: shopErr?.message || "Lỗi kiểm tra kết nối gian hàng",
          };
        }
      }
      return res.json({ success: true, statuses });
    } catch (error: any) {
      console.error("[Shop connection-status] fatal:", error);
      return res.status(500).json({
        success: false,
        error: error?.message || "Kiểm tra kết nối thất bại",
        message: error?.message || "Kiểm tra kết nối thất bại",
      });
    }
  });

  // API endpoint for Gemini optimization (Protected)
  app.post("/api/gemini/optimize", authMiddleware, async (req, res) => {
    try {
      const { action, text, context } = req.body;
      const apiKey = process.env.GEMINI_API_KEY;

      if (!apiKey) {
        return res.status(503).json({
          error: "Ch\u01B0a c\u1EA5u h\xECnh API Key c\u1EE7a Gemini AI. Vui l\xF2ng c\xE0i \u0111\u1EB7t trong m\u1EE5c Settings ho\u1EB7c Secrets.",
        });
      }

      if (!ai) {
        ai = new GoogleGenAI({
          apiKey,
          httpOptions: {
            headers: {
              "User-Agent": "aistudio-build",
            },
          },
        });
      }

      let prompt = "";
      if (action === "optimize-title") {
        prompt = `B\u1EA1n l\xE0 m\u1ED9t chuy\xEAn gia t\u1ED1i \u01B0u h\xF3a SEO tr\xEAn Shopee v\xE0 TikTok Shop t\u1EA1i Vi\u1EC7t Nam.
H\xE3y vi\u1EBFt l\u1EA1i ti\xEAu \u0111\u1EC1 s\u1EA3n ph\u1EA9m sau \u0111\xE2y \u0111\u1EC3 thu h\xFAt kh\xE1ch h\xE0ng, k\xEDch th\xEDch click, t\u0103ng t\u1EF7 l\u1EC7 chuy\u1EC3n \u0111\u1ED5i v\xE0 ch\u1EE9a c\xE1c t\u1EEB kh\xF3a t\xECm ki\u1EBFm ph\u1ED5 bi\u1EBFn (SEO).
Ti\xEAu \u0111\u1EC1 g\u1ED1c: "${text}"
${context ? `Y\xEAu c\u1EA7u th\xEAm: ${context}` : ""}

Quy t\u1EAFc vi\u1EBFt ti\xEAu \u0111\u1EC1:
- \u0110\u1ED9 d\xE0i t\u1EEB 50-120 k\xFD t\u1EF1.
- Vi\u1EBFt hoa ch\u1EEF c\xE1i \u0111\u1EA7u c\u1EE7a m\u1ED7i t\u1EEB quan tr\u1ECDng (nh\u01B0 t\xEAn th\u01B0\u01A1ng hi\u1EC7u, t\xEDnh n\u0103ng ch\xEDnh).
- Ch\u1EE9a th\u01B0\u01A1ng hi\u1EC7u, ch\u1EA5t li\u1EC7u, dung t\xEDch/k\xEDch th\u01B0\u1EDBc, c\xF4ng d\u1EE5ng n\u1ED5i b\u1EADt.
- KH\xD4NG d\xF9ng k\xFD t\u1EF1 \u0111\u1EB7c bi\u1EC7t g\xE2y l\u1ED7i t\xECm ki\u1EBFm.
- Ch\u1EC9 tr\u1EA3 v\u1EC1 danh s\xE1ch 3 ph\u01B0\u01A1ng \xE1n ti\xEAu \u0111\u1EC1 t\u1ED1i \u01B0u nh\u1EA5t d\u01B0\u1EDBi d\u1EA1ng danh s\xE1ch, m\u1ED7i ph\u01B0\u01A1ng \xE1n tr\xEAn 1 d\xF2ng. Kh\xF4ng gi\u1EA3i th\xEDch th\xEAm.`;
      } else if (action === "generate-description") {
        prompt = `B\u1EA1n l\xE0 m\u1ED9t chuy\xEAn gia Copywriter vi\u1EBFt b\xE0i m\xF4 t\u1EA3 s\u1EA3n ph\u1EA9m b\xE1n h\xE0ng (Product Description) \u0111\u1EC9nh cao tr\xEAn s\xE0n th\u01B0\u01A1ng m\u1EA1i \u0111i\u1EC7n t\u1EED Shopee v\xE0 TikTok Shop Vi\u1EC7t Nam.
H\xE3y vi\u1EBFt m\u1ED9t b\xE0i m\xF4 t\u1EA3 s\u1EA3n ph\u1EA9m chi ti\u1EBFt, chuy\xEAn nghi\u1EC7p, thu h\xFAt ng\u01B0\u1EDDi mua d\u1EF1a tr\xEAn th\xF4ng tin s\u1EA3n ph\u1EA9m sau \u0111\xE2y.
T\xEAn s\u1EA3n ph\u1EA9m: "${text}"
${context ? `Th\xF4ng tin b\u1ED5 sung / Gi\xE1 c\u1EA3 / T\xEDnh n\u0103ng: ${context}` : ""}

C\u1EA5u tr\xFAc b\xE0i vi\u1EBFt m\xF4 t\u1EA3 s\u1EA3n ph\u1EA9m c\u1EA7n c\xF3:
1. Slogan thu h\xFAt & Gi\u1EDBi thi\u1EC7u ng\u1EAFn v\u1EC1 s\u1EA3n ph\u1EA9m.
2. C\xE1c \u0111\u1EB7c \u0111i\u1EC3m n\u1ED5i b\u1EADt nh\u1EA5t (g\u1EA1ch \u0111\u1EA7u d\xF2ng d\u1EC5 \u0111\u1ECDc).
3. Th\xF4ng s\u1ED1 k\u1EF9 thu\u1EADt / H\u01B0\u1EDBng d\u1EABn s\u1EED d\u1EE5ng chi ti\u1EBFt.
4. Cam k\u1EBFt c\u1EE7a Shop (H\xE0ng ch\xEDnh h\xE3ng, b\u1EA3o h\xE0nh, \u0111\u1ED5i tr\u1EA3 1-1 trong 7 ng\xE0y).
5. Hashtag li\xEAn quan chu\u1EA9n SEO (8-12 hashtags \u1EDF cu\u1ED1i b\xE0i, v\xED d\u1EE5: #noichien #giadung).

Phong c\xE1ch vi\u1EBFt: Th\xE2n thi\u1EC7n, thuy\u1EBFt ph\u1EE5c, \u0111\xE1ng tin c\u1EADy. \u0110\u1ECBnh d\u1EA1ng Markdown \u0111\u1EB9p m\u1EAFt, ph\xE2n c\u1EA5p r\xF5 r\xE0ng. H\xE3y ch\u1EC9 tr\u1EA3 v\u1EC1 b\xE0i vi\u1EBFt m\xF4 t\u1EA3 b\u1EB1ng Markdown. Kh\xF4ng ch\xE0o h\u1ECFi hay gi\u1EA3i th\xEDch th\xEAm.`;
      } else if (action === "suggest-prices") {
        const importP = typeof context === "object" ? context.importPrice : 0;
        const sellP = typeof context === "object" ? context.sellingPrice : 0;
        prompt = `B\u1EA1n l\xE0 chuy\xEAn gia c\u1ED1 v\u1EA5n t\xE0i ch\xEDnh v\xE0 \u0111\u1ECBnh gi\xE1 s\u1EA3n ph\u1EA9m E-commerce tr\xEAn Shopee & TikTok Shop.
D\u1EF1a tr\xEAn th\xF4ng tin s\u1EA3n ph\u1EA9m n\xE0y:
T\xEAn s\u1EA3n ph\u1EA9m: "${text}"
Gi\xE1 nh\u1EADp g\u1ED1c: ${importP.toLocaleString("vi-VN")} VN\u0110.
Gi\xE1 b\xE1n d\u1EF1 ki\u1EBFn hi\u1EC7n t\u1EA1i: ${sellP.toLocaleString("vi-VN")} VN\u0110.

H\xE3y t\xEDnh to\xE1n v\xE0 ph\xE2n t\xEDch chi ti\u1EBFt b\u1EB1ng ti\u1EBFng Vi\u1EC7t:
1. T\u1EF7 su\u1EA5t l\u1EE3i nhu\u1EADn g\u1ED9p (Gross Profit Margin %) c\u1EE7a gi\xE1 b\xE1n d\u1EF1 ki\u1EBFn hi\u1EC7n t\u1EA1i.
2. \u0110\u1EC1 xu\u1EA5t 3 m\u1EE9c gi\xE1 b\xE1n t\u1ED1i \u01B0u (Gi\xE1 th\xE2m nh\u1EADp th\u1ECB tr\u01B0\u1EDDng, Gi\xE1 t\u1ED1i \u0111a h\xF3a l\u1EE3i nhu\u1EADn, Gi\xE1 khuy\u1EBFn m\xE3i Flash Sale) k\xE8m ph\xE2n t\xEDch l\u1EE3i nhu\u1EADn th\u1EF1c t\u1EBF (\u0111\xE3 tr\u1EEB kho\u1EA3ng 10-12% ph\xED s\xE0n Shopee/TikTok th\xF4ng th\u01B0\u1EDDng bao g\u1ED3m ph\xED thanh to\xE1n, ph\xED c\u1ED1 \u0111\u1ECBnh, ph\xED Freeship Xtra).
3. Ph\xE2n t\xEDch t\xEDnh c\u1EA1nh tranh c\u1EE7a gi\xE1 nh\u1EADp v\xE0 \u0111\u1EC1 xu\u1EA5t chi\u1EBFn l\u01B0\u1EE3c t\u1ED1i \u01B0u chi ph\xED hi\u1EC7u qu\u1EA3.

H\xE3y tr\u1EA3 v\u1EC1 k\u1EBFt qu\u1EA3 chi ti\u1EBFt b\u1EB1ng ti\u1EBFng Vi\u1EC7t, vi\u1EBFt ng\u1EAFn g\u1ECDn d\u01B0\u1EDBi d\u1EA1ng Markdown, s\u1EED d\u1EE5ng b\u1EA3ng \u0111\u1EC3 so s\xE1nh r\xF5 r\xE0ng c\xE1c m\u1EE9c gi\xE1 \u0111\u1EC1 xu\u1EA5t v\xE0 l\u1EE3i nhu\u1EADn th\u1EF1c nh\u1EADn.`;
      } else if (action === "bulk-tag") {
        prompt = `B\u1EA1n l\xE0 chuy\xEAn gia t\u1EEB kh\xF3a SEO cho Shopee v\xE0 TikTok Shop t\u1EA1i Vi\u1EC7t Nam.
H\xE3y g\u1EE3i \xFD m\u1ED9t danh s\xE1ch g\u1ED3m 10-15 hashtags b\xE1n ch\u1EA1y nh\u1EA5t li\xEAn quan \u0111\u1EBFn s\u1EA3n ph\u1EA9m: "${text}".
C\xE1c t\u1EEB kh\xF3a ph\u1EA3i ph\xF9 h\u1EE3p v\u1EDBi xu h\u01B0\u1EDBng t\xECm ki\u1EBFm h\xE0ng \u0111\u1EA7u c\u1EE7a ng\u01B0\u1EDDi Vi\u1EC7t.
Tr\u1EA3 v\u1EC1 k\u1EBFt qu\u1EA3 d\u01B0\u1EDBi d\u1EA1ng: c\xE1c hashtags c\xE1ch nhau b\u1EB1ng d\u1EA5u c\xE1ch, k\xE8m theo 3 g\u1EE3i \xFD c\u1EE5m t\u1EEB kh\xF3a t\xECm ki\u1EBFm ch\xEDnh (search volume cao) \u0111\u1EC3 ch\xE8n v\xE0o ph\u1EA7n \u0111\u1EA7u ti\xEAu \u0111\u1EC1 ho\u1EB7c m\xF4 t\u1EA3. Tr\u1EA3 v\u1EC1 d\u01B0\u1EDBi d\u1EA1ng v\u0103n b\u1EA3n Markdown ng\u1EAFn g\u1ECDn.`;
      } else if (action === "avoid-duplication-title") {
        prompt = `B\u1EA1n l\xE0 chuy\xEAn gia t\u01B0 v\u1EA5n SEO v\xE0 b\xE1n h\xE0ng th\u01B0\u01A1ng m\u1EA1i \u0111i\u1EC7n t\u1EED chuy\xEAn nghi\u1EC7p t\u1EA1i Vi\u1EC7t Nam.
Nhi\u1EC7m v\u1EE5 c\u1EE7a b\u1EA1n l\xE0 vi\u1EBFt l\u1EA1i t\xEAn s\u1EA3n ph\u1EA9m g\u1ED1c th\xE0nh 3 ph\u01B0\u01A1ng \xE1n ti\xEAu \u0111\u1EC1 kh\xE1c nhau ho\xE0n to\xE0n v\u1EC1 m\u1EB7t c\u1EA5u tr\xFAc ch\u1EEF vi\u1EBFt v\xE0 c\u1EE5m t\u1EEB b\u1ED5 tr\u1EE3, nh\u01B0ng v\u1EABn gi\u1EEF nguy\xEAn b\u1EA3n ch\u1EA5t s\u1EA3n ph\u1EA9m \u0111\u1EC3 \u0111\u0103ng l\xEAn nhi\u1EC1u gian h\xE0ng kh\xE1c nhau (Shopee, TikTok, Lazada) m\xE0 KH\xD4NG b\u1ECB qu\xE9t tr\xF9ng l\u1EB7p n\u1ED9i dung (tr\xE1nh thu\u1EADt to\xE1n spam/duplicate listings).

Ti\xEAu \u0111\u1EC1 g\u1ED1c: "${text}"
${context ? `T\u1EEB kh\xF3a/Y\xEAu c\u1EA7u th\xEAm: ${context}` : ""}

Quy t\u1EAFc t\u1ED1i \u01B0u h\xF3a ch\u1ED1ng tr\xF9ng l\u1EB7p:
- Ph\u01B0\u01A1ng \xE1n 1 (S\u1EED d\u1EE5ng c\u1EE5m t\u1EEB gi\u1EADt t\xEDt \u0111\u1EA7u trang, c\u1EA5u tr\xFAc k\u1EF9 thu\u1EADt): V\xED d\u1EE5: "[Ch\xEDnh H\xE3ng] + T\xEAn s\u1EA3n ph\u1EA9m + Th\xF4ng s\u1ED1 k\u1EF9 thu\u1EADt n\u1ED5i b\u1EADt + C\xF4ng d\u1EE5ng ch\xEDnh".
- Ph\u01B0\u01A1ng \xE1n 2 (\u0110\xE1nh v\xE0o gi\xE1 tr\u1ECB/m\xF4 t\u1EA3 c\u1EA3m x\xFAc ng\u01B0\u1EDDi mua, qu\xE0 t\u1EB7ng k\xE8m): V\xED d\u1EE5: "T\xEAn s\u1EA3n ph\u1EA9m + [T\u1EB7ng K\xE8m Qu\xE0 / Freeship Xtra] + Ph\xE2n lo\u1EA1i/M\xE0u s\u1EAFc hot + B\u1EA3o h\xE0nh 12T".
- Ph\u01B0\u01A1ng \xE1n 3 (T\u1EADp trung t\u1EEB kh\xF3a SEO ng\xE1ch, ph\xE2n kh\xFAc \u0111\u1ED1i t\u01B0\u1EE3ng): V\xED d\u1EE5: "T\xEAn s\u1EA3n ph\u1EA9m + Gi\u1EA3i ph\xE1p cho... + Ch\u1EA5t li\u1EC7u + [\u1EA2nh Th\u1EADt T\u1EF1 Ch\u1EE5p]".
- \u0110\u1EA3m b\u1EA3o \u0111\u1ED9 d\xE0i m\u1ED7i ti\xEAu \u0111\u1EC1 t\u1EEB 75 \u0111\u1EBFn 115 k\xFD t\u1EF1.
- Ch\u1EE9a c\xE1c t\u1EEB kh\xF3a \u0111\u1ED3ng ngh\u0129a phong ph\xFA \u0111\u1EC3 c\xF4ng c\u1EE5 t\xECm ki\u1EBFm kh\xF4ng nh\u1EADn d\u1EA1ng tr\xF9ng l\u1EB7p.
- Ch\u1EC9 tr\u1EA3 v\u1EC1 danh s\xE1ch \u0111\xFAng 3 d\xF2ng ti\xEAu \u0111\u1EC1 \u0111\xE3 ch\u1EC9nh s\u1EEDa, m\u1ED7i d\xF2ng m\u1ED9t ph\u01B0\u01A1ng \xE1n, kh\xF4ng c\xF3 s\u1ED1 th\u1EE9 t\u1EF1 \u1EDF \u0111\u1EA7u d\xF2ng, kh\xF4ng gi\u1EA3i th\xEDch th\xEAm b\u1EA5t k\u1EF3 \u0111i\u1EC1u g\xEC.`;
      } else {
        return res.status(400).json({ error: "H\xE0nh \u0111\u1ED9ng kh\xF4ng h\u1EE3p l\u1EC7." });
      }

      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: prompt,
      });

      return res.json({ result: response.text });
    } catch (error: any) {
      console.error("Gemini API Error:", error);
      return res.status(500).json({ error: error.message || "L\u1ED7i x\u1EED l\xFD AI t\u1EEB server" });
    }
  });

  const LISTINGS_DB_PATH = path.join(APP_ROOT, "data", "multi_channel_listings.json");

  const readListingsDb = (): any[] => {
    try {
      if (!fs.existsSync(LISTINGS_DB_PATH)) return [];
      const raw = fs.readFileSync(LISTINGS_DB_PATH, "utf-8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };

  const writeListingsDb = (listings: any[]) => {
    const dir = path.dirname(LISTINGS_DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(LISTINGS_DB_PATH, JSON.stringify(listings, null, 2), "utf-8");
  };

  const markdownToHtml = (text: string): string => {
    if (!text) return "";
    if (/<[a-z][\s\S]*>/i.test(text)) return text;
    const lines = text.split("\n");
    const parts: string[] = [];
    let inList = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        if (inList) { parts.push("</ul>"); inList = false; }
        continue;
      }
      if (trimmed.startsWith("### ")) {
        if (inList) { parts.push("</ul>"); inList = false; }
        parts.push(`<h3>${trimmed.slice(4)}</h3>`);
      } else if (trimmed.startsWith("## ")) {
        if (inList) { parts.push("</ul>"); inList = false; }
        parts.push(`<h2>${trimmed.slice(3)}</h2>`);
      } else if (trimmed.startsWith("# ")) {
        if (inList) { parts.push("</ul>"); inList = false; }
        parts.push(`<h1>${trimmed.slice(2)}</h1>`);
      } else if (/^[-*]\s+/.test(trimmed)) {
        if (!inList) { parts.push("<ul>"); inList = true; }
        parts.push(`<li>${trimmed.replace(/^[-*]\s+/, "")}</li>`);
      } else {
        if (inList) { parts.push("</ul>"); inList = false; }
        parts.push(`<p>${trimmed}</p>`);
      }
    }
    if (inList) parts.push("</ul>");
    return parts.join("");
  };

  app.post("/api/ai/parse-address", authMiddleware, async (req, res) => {
    try {
      const { address } = req.body || {};
      const apiKey = process.env.GEMINI_API_KEY;

      if (!apiKey) {
        return res.status(503).json({
          error: "Chưa cấu hình API Key của Gemini AI.",
        });
      }

      if (!address?.trim()) {
        return res.status(400).json({ error: "Thiếu chuỗi địa chỉ cần phân tích." });
      }

      if (!ai) {
        ai = new GoogleGenAI({
          apiKey,
          httpOptions: { headers: { "User-Agent": "aistudio-build" } },
        });
      }

      const prompt = `Bạn là chuyên gia phân tích địa chỉ giao hàng Việt Nam.
Phân tích chuỗi địa chỉ sau và trả về JSON thuần (KHÔNG markdown, KHÔNG giải thích):
{"province":"...","district":"...","ward":"...","street":"..."}

Yêu cầu:
- province: tên Tỉnh/Thành phố chuẩn (VD: "Thành phố Hồ Chí Minh", "Hà Nội")
- district: tên Quận/Huyện/Thị xã chuẩn (VD: "Quận 1", "Huyện Đông Anh")
- ward: tên Phường/Xã/Thị trấn chuẩn
- street: phần địa chỉ chi tiết còn lại (số nhà, tên đường, ngõ ngách)
- Chuẩn hóa viết tắt: HCM/TPHCM -> Thành phố Hồ Chí Minh, Q1 -> Quận 1, P. -> Phường

Địa chỉ cần phân tích: "${String(address).trim()}"`;

      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: prompt,
      });

      const raw = (response.text || "").trim();
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return res.status(422).json({ error: "AI không trả về JSON hợp lệ." });
      }

      const parsed = JSON.parse(jsonMatch[0]);
      return res.json({
        success: true,
        parsed: {
          province: String(parsed.province || "").trim(),
          district: String(parsed.district || "").trim(),
          ward: String(parsed.ward || "").trim(),
          street: String(parsed.street || "").trim(),
        },
      });
    } catch (error: any) {
      console.error("[AI parse-address]", error);
      const msg = String(error?.message || "");
      const lower = msg.toLowerCase();
      if (
        lower.includes("api key") ||
        lower.includes("api_key") ||
        lower.includes("invalid api") ||
        (lower.includes("invalid") && lower.includes("key"))
      ) {
        return res.status(401).json({
          error: "Gemini API Key không hợp lệ. Vào Cài đặt → Cấu hình AI để cập nhật key.",
        });
      }
      if (msg.startsWith("{") || msg.includes("GoogleGenerativeAI")) {
        return res.status(502).json({
          error: "AI tạm thời không phản hồi. Vui lòng nhập địa chỉ thủ công hoặc thử lại sau.",
        });
      }
      return res.status(500).json({ error: msg || "Lỗi phân tích địa chỉ AI" });
    }
  });

  app.post("/api/ai/generate-description", authMiddleware, async (req, res) => {
    try {
      const { title, keywords, context } = req.body || {};
      const apiKey = process.env.GEMINI_API_KEY;

      if (!apiKey) {
        return res.status(503).json({
          error: "Ch\u01B0a c\u1EA5u h\xECnh API Key c\u1EE7a Gemini AI.",
        });
      }

      if (!ai) {
        ai = new GoogleGenAI({
          apiKey,
          httpOptions: { headers: { "User-Agent": "aistudio-build" } },
        });
      }

      const prompt = `B\u1EA1n l\xE0 chuy\xEAn gia Copywriter vi\u1EBFt m\xF4 t\u1EA3 s\u1EA3n ph\u1EA9m b\xE1n h\xE0ng tr\xEAn Shopee, Lazada v\xE0 TikTok Shop Vi\u1EC7t Nam.
H\xE3y vi\u1EBFt m\xF4 t\u1EA3 s\u1EA3n ph\u1EA9m d\u1EA1ng HTML (d\xF9ng th\u1EBB h2, h3, p, ul, li, strong) \u2014 KH\xD4NG d\xF9ng markdown, KH\xD4NG bọc trong \`\`\`html.
T\xEAn s\u1EA3n ph\u1EA9m: "${title || ""}"
T\u1EEB kh\xF3a / T\xEDnh n\u0103ng: "${keywords || ""}"
${context ? `Th\xF4ng tin th\xEAm: ${context}` : ""}

C\u1EA5u tr\xFAc: slogan ng\u1EAFn, \u0111\u1EB7c \u0111i\u1EC3m n\u1ED5i b\u1EADt (ul/li), th\xF4ng s\u1ED1, cam k\u1EBFt shop, hashtags cu\u1ED1i b\xE0i. Ch\u1EC9 tr\u1EA3 v\u1EC1 HTML thu\u1EA7n.`;

      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: prompt,
      });

      const raw = (response.text || "").trim();
      const html = markdownToHtml(raw.replace(/^```html\s*/i, "").replace(/```\s*$/i, ""));
      return res.json({ success: true, html });
    } catch (error: any) {
      console.error("[AI generate-description]", error);
      return res.status(500).json({ error: error.message || "L\u1ED7i t\u1EA1o m\xF4 t\u1EA3 AI" });
    }
  });

  app.get("/api/multi-channel/listing", authMiddleware, async (_req, res) => {
    return res.json({ success: true, listings: readListingsDb() });
  });

  app.post("/api/multi-channel/listing", authMiddleware, async (req, res) => {
    try {
      const payload = req.body || {};
      const listings = readListingsDb();
      const entry = {
        id: `listing-${Date.now()}`,
        ...payload,
        savedAt: new Date().toISOString(),
      };
      listings.unshift(entry);
      writeListingsDb(listings.slice(0, 200));
      return res.json({ success: true, id: entry.id, message: "L\u01B0u nh\xE1p \u0111\u0103ng b\xE1n \u0111a s\xE0n th\xE0nh c\xF4ng" });
    } catch (error: any) {
      return res.status(500).json({ success: false, error: error.message || "L\u01B0u th\u1EA5t b\u1EA1i" });
    }
  });

  const PRODUCT_LISTINGS_DB_PATH = path.join(APP_ROOT, "data", "product_listings.json");

  // mapping-products / channel-listings đã đăng ký sớm sau /api/health (tránh SPA HTML).

  const readProductListingsDb = (): any[] => {
    try {
      if (!fs.existsSync(PRODUCT_LISTINGS_DB_PATH)) return [];
      const raw = fs.readFileSync(PRODUCT_LISTINGS_DB_PATH, "utf-8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };

  const writeProductListingsDb = (rows: any[]) => {
    const dir = path.dirname(PRODUCT_LISTINGS_DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PRODUCT_LISTINGS_DB_PATH, JSON.stringify(rows, null, 2), "utf-8");
  };

  const computeOverallListingStatus = (statuses: string[]): string => {
    if (!statuses.length) return "pending";
    const hasSuccess = statuses.includes("success");
    const hasFailed = statuses.includes("failed");
    const hasPending = statuses.includes("pending");
    if (hasPending && !hasSuccess && !hasFailed) return "pending";
    if (hasSuccess && hasFailed) return "partial";
    if (hasSuccess) return "success";
    if (hasFailed) return "failed";
    return "pending";
  };

  app.get("/api/product-listings", authMiddleware, async (_req, res) => {
    try {
      const rows = readProductListingsDb();
      const products = await loadProducts();
      const byProduct = new Map<string, any[]>();

      for (const row of rows) {
        const pid = row.product_id || "unknown";
        if (!byProduct.has(pid)) byProduct.set(pid, []);
        byProduct.get(pid)!.push(row);
      }

      const groups = Array.from(byProduct.entries()).map(([productId, children]) => {
        const sorted = [...children].sort(
          (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
        );
        const product = products.find((p: any) => p.id === productId);
        const statuses = sorted.map((c) => c.status);
        const created = sorted.reduce((min, c) => (c.created_at < min ? c.created_at : min), sorted[0].created_at);
        const updated = sorted.reduce((max, c) => (c.updated_at > max ? c.updated_at : max), sorted[0].updated_at);
        const platforms = Array.from(new Set(sorted.map((c) => c.platform)));

        return {
          product_id: productId,
          product_title: product?.title || sorted[0]?.listing_title || "Sản phẩm không xác định",
          product_image: product?.imageUrl || product?.avatarUrl || sorted[0]?.product_image,
          product_sku: product?.sku,
          created_at: created,
          updated_at: updated,
          overall_status: computeOverallListingStatus(statuses),
          platform_labels: platforms,
          children: sorted,
        };
      });

      groups.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

      return res.json({ success: true, groups });
    } catch (error: any) {
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/product-listings/clear-all", authMiddleware, async (_req, res) => {
    writeProductListingsDb([]);
    return res.json({ success: true, cleared: true, groups: [] });
  });

  app.post("/api/catalog/wipe-all", authMiddleware, async (_req, res) => {
    await saveProducts([]);
    saveImports([]);
    writeListingsDb([]);
    writeProductListingsDb([]);
    console.log("[Catalog] Đã xóa sạch products, imports, multi_channel_listings, product_listings.");
    return res.json({
      success: true,
      cleared: true,
      products: [],
      imports: [],
      listings: [],
      productListings: [],
    });
  });

  app.post("/api/multi-channel/publish", authMiddleware, async (req, res) => {
    try {
      const payload = req.body || {};
      const {
        warehouseProductId,
        title,
        images = [],
        shops = [],
        selectedShops = [],
      } = payload;

      const productId = warehouseProductId || payload.product_id || "unknown";
      const product = (await loadProducts()).find((p: any) => p.id === productId);
      const batchId = `batch-${Date.now()}`;
      const now = new Date().toISOString();
      const allRows = readProductListingsDb();
      const newRows: any[] = [];

      const shopList = Array.isArray(shops) && shops.length
        ? shops
        : (selectedShops as string[]).map((id: string) => ({ id, name: id, platform: "shopee" }));

      for (let i = 0; i < shopList.length; i++) {
        const shop = shopList[i];
        const platform = String(shop.platform || "shopee").toLowerCase();
        if (!["shopee", "lazada", "tiktok"].includes(platform)) continue;

        const existingIdx = allRows.findIndex(
          (r) => r.product_id === productId && r.shop_id === shop.id && r.platform === platform
        );

        const simulateFail = platform === "lazada" && i % 3 === 2;
        const status = simulateFail ? "failed" : "success";
        const platformProductId = status === "success"
          ? `${platform}-${productId}-${Date.now().toString(36)}`
          : undefined;

        const row = {
          id: existingIdx >= 0 ? allRows[existingIdx].id : `pl-${Date.now()}-${i}`,
          product_id: productId,
          publish_batch_id: batchId,
          platform,
          shop_id: shop.id,
          shop_name: shop.name || shop.shopName || shop.id,
          status,
          platform_product_id: platformProductId,
          error_message: status === "failed" ? "Lỗi xác thực danh mục hoặc từ khóa bị cấm trên sàn" : undefined,
          listing_title: (payload.shopTitles && payload.shopTitles[shop.id]) || title || product?.title,
          product_image: images[0] || product?.imageUrl || product?.avatarUrl,
          created_at: existingIdx >= 0 ? allRows[existingIdx].created_at : now,
          updated_at: now,
        };

        if (existingIdx >= 0) {
          allRows[existingIdx] = row;
        } else {
          allRows.unshift(row);
        }
        newRows.push(row);
      }

      writeProductListingsDb(allRows.slice(0, 2000));

      const draftListings = readListingsDb();
      draftListings.unshift({
        id: `listing-${Date.now()}`,
        ...payload,
        publish_batch_id: batchId,
        savedAt: now,
        published: true,
      });
      writeListingsDb(draftListings.slice(0, 200));

      return res.json({
        success: true,
        batchId,
        listings: newRows,
        message: `Đã ghi nhận đăng bán lên ${newRows.length} gian hàng`,
      });
    } catch (error: any) {
      return res.status(500).json({ success: false, error: error.message || "Đăng bán thất bại" });
    }
  });

  const PUBLISH_EDIT_DB_PATH = path.join(APP_ROOT, "data", "publish_edit.json");
  const FRAMED_IMAGES_DIR = path.join(APP_ROOT, "data", "framed_images");

  const readPublishEditDb = (): { config: any; meta: Record<string, any> } => {
    try {
      if (!fs.existsSync(PUBLISH_EDIT_DB_PATH)) return { config: {}, meta: {} };
      const raw = fs.readFileSync(PUBLISH_EDIT_DB_PATH, "utf-8");
      const parsed = JSON.parse(raw);
      return { config: parsed.config || {}, meta: parsed.meta || {} };
    } catch {
      return { config: {}, meta: {} };
    }
  };

  const writePublishEditDb = (data: { config: any; meta: Record<string, any> }) => {
    const dir = path.dirname(PUBLISH_EDIT_DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PUBLISH_EDIT_DB_PATH, JSON.stringify(data, null, 2), "utf-8");
  };

  app.get("/api/publish-edit", authMiddleware, async (_req, res) => {
    const db = readPublishEditDb();
    return res.json({ success: true, config: db.config, meta: db.meta });
  });

  app.post("/api/publish-edit/config", authMiddleware, async (req, res) => {
    try {
      const db = readPublishEditDb();
      db.config = { ...db.config, ...req.body, updated_at: new Date().toISOString() };
      writePublishEditDb(db);
      return res.json({ success: true, config: db.config });
    } catch (error: any) {
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/publish-edit/batch-titles", authMiddleware, async (req, res) => {
    try {
      const { assignments = [] } = req.body || {};
      const db = readPublishEditDb();
      for (const item of assignments) {
        if (!item.productId) continue;
        db.meta[item.productId] = {
          ...(db.meta[item.productId] || {}),
          shopTitles: item.shopTitles || {},
          aiTitles: item.aiTitles || [],
          titlesAppliedAt: new Date().toISOString(),
        };
      }
      writePublishEditDb(db);
      return res.json({ success: true, meta: db.meta });
    } catch (error: any) {
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/publish-edit/save-framed-image", authMiddleware, async (req, res) => {
    try {
      const { productId, imageDataUrl, framedHash } = req.body || {};
      if (!productId || !imageDataUrl) {
        return res.status(400).json({ success: false, error: "Thiếu productId hoặc ảnh" });
      }

      if (!fs.existsSync(FRAMED_IMAGES_DIR)) fs.mkdirSync(FRAMED_IMAGES_DIR, { recursive: true });

      const base64 = String(imageDataUrl).replace(/^data:image\/\w+;base64,/, "");
      const buf = Buffer.from(base64, "base64");
      const filename = `${productId}.jpg`;
      fs.writeFileSync(path.join(FRAMED_IMAGES_DIR, filename), buf);

      const imageUrl = `/api/framed-images/${productId}`;
      const products = await loadProducts();
      const idx = products.findIndex((p: any) => p.id === productId);
      if (idx >= 0) {
        products[idx] = { ...products[idx], imageUrl };
        await saveProducts(products);
      }

      const db = readPublishEditDb();
      db.meta[productId] = {
        ...(db.meta[productId] || {}),
        framedImageUrl: imageUrl,
        framedHash: framedHash || `hash-${buf.length}`,
        frameAppliedAt: new Date().toISOString(),
      };
      writePublishEditDb(db);

      return res.json({ success: true, imageUrl, framedHash: db.meta[productId].framedHash });
    } catch (error: any) {
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get("/api/framed-images/:productId", (req, res) => {
    const filePath = path.join(FRAMED_IMAGES_DIR, `${req.params.productId}.jpg`);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Không tìm thấy ảnh" });
    }
    res.setHeader("Content-Type", "image/jpeg");
    return res.send(fs.readFileSync(filePath));
  });

  app.use("/api", (req, res) => {
    res.status(404).json({
      success: false,
      message: `API không tồn tại: ${req.method} ${req.originalUrl}`,
      details: "not_found",
    });
  });

  app.use((err: unknown, req: any, res: any, _next: any) => {
    if (err instanceof SyntaxError && err && typeof err === "object" && "body" in err) {
      return res.status(400).json({
        success: false,
        message: "JSON body không hợp lệ",
        details: err.message,
      });
    }
    console.error("[Express] Unhandled error:", req.method, req.originalUrl, err);
    return sendApiErrorJson(res, err, 500);
  });

  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    vite.watcher.on("error", (err: Error) => {
      console.warn("[Vite] Watcher error (bỏ qua, server vẫn chạy):", err.message);
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(APP_ROOT, "dist");
    app.use(express.static(distPath, {
      setHeaders(res, filePath) {
        if (filePath.endsWith("index.html")) {
          res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
          res.setHeader("Pragma", "no-cache");
          res.setHeader("Expires", "0");
        } else if (/\.(js|css)$/.test(filePath)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
    }));
    app.get("*", (req, res) => {
      const pathName = String(req.path || req.originalUrl || "").split("?")[0];
      if (pathName.startsWith("/api/") || pathName === "/api") {
        return res.status(404).json({
          success: false,
          message: `API không tồn tại: ${req.method} ${pathName}`,
          details: "not_found",
        });
      }
      if (pathName.startsWith("/labels/")) {
        return res.status(404).type("text/plain").send("Không tìm thấy file vận đơn.");
      }
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.sendFile(path.join(distPath, "index.html"));
    });
  }

  /**
   * Kết nối MongoDB NGẦM — không block app.listen / Passenger boot.
   */
  async function connectDB(): Promise<void> {
    try {
      const ok = await initMongo(APP_ROOT);
      if (ok && isMongoReady()) {
        await hydrateChannelListingsOnBoot();
      }
      console.log(`[MongoDB] connectDB xong — ready=${isMongoReady()} uri=${getMongoUriMasked()}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("LỖI MONGODB STARTUP:", msg);
      writeCpanelCrashLog("Rejection", err);
    }
  }

  /**
   * cPanel / Phusion Passenger: BẮT BUỘC listen NGAY — không await DB trước listen.
   */
  function startListening(): void {
    console.log("[Orders Sync] Auto-sync định kỳ đã tắt — chỉ đồng bộ khi user bấm nút.");

    const onReady = () => {
      console.log(
        process.env.PORT
          ? `Server optimized for cPanel Phusion Passenger: listening on ${PORT}`
          : `Server running locally on port ${PORT}`
      );
      console.log(`[Config] APP_BASE_URL=${APP_BASE_URL}`);
      console.log(`[Config] NODE_ENV=${process.env.NODE_ENV || "unset"}`);
      console.log(`[Shopee] Callback=${SHOPEE_CALLBACK_URL}`);
      if (!process.env.PORT) {
        console.log("[Dashboard] API route ready: GET /api/dashboard?date_range=...");
      }
      console.log(`[MongoDB] listen OK — connecting DB in background (ready=${isMongoReady()})`);
      // DB non-blocking: fire-and-forget sau khi port đã mở
      void connectDB();
    };

    if (process.env.PORT) {
      app.listen(PORT, onReady);
    } else {
      app.listen(Number(PORT), "0.0.0.0", onReady);
    }
  }

  startListening();
}

startServer().catch((err) => {
  writeCpanelCrashLog("Exception", err);
  console.error("[Boot] startServer failed:", err);
});
