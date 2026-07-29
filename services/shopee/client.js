/**
 * Shopee HTTP client — fetch, retry, batch throttle, API error formatting.
 * Phase 6 — tách từ server.ts.
 */
import path from "path";
import { createRequire } from "node:module";
import { sleep } from "../../utils/concurrency.js";

export const SHOPEE_API_MAX_RETRY = 3;
export const SHOPEE_API_RETRY_BASE_MS = 1500;
/** Timeout mọi HTTP Shopee — tối đa 15s, tránh treo process vô hạn trên cPanel. */
export const SHOPEE_HTTP_TIMEOUT_MS = 15_000;
/** TLS tối thiểu cho Shopee OpenAPI (cPanel Node ≥20) — tránh ECONNRESET do handshake cũ. */
export const SHOPEE_TLS_MIN_VERSION = String(process.env.SHOPEE_TLS_MIN_VERSION || "TLSv1.2").trim();
export const SHOPEE_TLS_MAX_VERSION = String(process.env.SHOPEE_TLS_MAX_VERSION || "TLSv1.3").trim();

const SHOPEE_PRODUCT_BATCH_SIZE = 10;
const SHOPEE_PRODUCT_API_DELAY_MS = 1000;
const SHOPEE_PRODUCT_BATCH_PAUSE_MS = 2500;
const SHOPEE_SYNC_BATCH_DELAY_MS = 1000;

/** Thông báo cố định khi refresh_token Shopee hết hạn vĩnh viễn — FE hiện cho user. */
export const SHOPEE_REAUTH_REQUIRED_MESSAGE =
  "Vui lòng vào mục Cấu hình để liên kết lại gian hàng Shopee (Token đã hết hạn hoàn toàn)";

/**
 * CJS bundle (server.cjs / dist/server.cjs): import.meta.url bị esbuild xoá → undefined
 * → createRequire crash → Node chết → FE "Máy chủ bận" / sync 500.
 * ESM (tsx server.ts): dùng import.meta.url; CJS: dùng __filename.
 */
function resolveCreateRequireFilename() {
  try {
    if (typeof __filename === "string" && __filename.length > 0) {
      return __filename;
    }
  } catch {
    /* ignore */
  }
  try {
    const metaUrl = typeof import.meta !== "undefined" ? String(import.meta?.url || "") : "";
    if (metaUrl && metaUrl !== "undefined") return metaUrl;
  } catch {
    /* ignore */
  }
  return path.resolve(process.cwd(), "server.cjs");
}

let shopeeHttpDispatcher = undefined;
try {
  const nodeRequire = createRequire(resolveCreateRequireFilename());
  let undiciMod;
  try {
    undiciMod = nodeRequire("node:undici");
  } catch {
    undiciMod = nodeRequire("undici");
  }
  const ShopeeUndiciAgent = undiciMod?.Agent;
  if (typeof ShopeeUndiciAgent !== "function") {
    throw new Error("undici.Agent không khả dụng");
  }
  shopeeHttpDispatcher = new ShopeeUndiciAgent({
    connect: {
      rejectUnauthorized: true,
      minVersion: SHOPEE_TLS_MIN_VERSION,
      maxVersion: SHOPEE_TLS_MAX_VERSION,
    },
    connections: 3,
    pipelining: 0,
    keepAliveTimeout: 30_000,
  });
  console.log("[Shopee HTTP] undici Agent OK — TLS dispatcher sẵn sàng cho sync Shopee.");
} catch (undiciErr) {
  console.info(
    "[Shopee HTTP] Dùng fetch tích hợp của Node (không dùng undici dispatcher):",
    undiciErr?.message || undiciErr,
  );
  shopeeHttpDispatcher = undefined;
}

export async function fetchWithTimeout(url, init = {}, timeoutMs = SHOPEE_HTTP_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let hardTimer;
  try {
    const fetchInit = {
      ...init,
      signal: controller.signal,
    };
    if (shopeeHttpDispatcher) fetchInit.dispatcher = shopeeHttpDispatcher;
    const fetchPromise = fetch(url, fetchInit);
    const hardTimeoutPromise = new Promise((_, reject) => {
      hardTimer = setTimeout(
        () => reject(new Error(`Shopee API timeout sau ${timeoutMs / 1000}s`)),
        timeoutMs + 1000,
      );
    });
    return await Promise.race([fetchPromise, hardTimeoutPromise]);
  } catch (error) {
    if (error?.name === "AbortError" || /timeout/i.test(String(error?.message || ""))) {
      console.error(`[Shopee HTTP] TIMEOUT ${timeoutMs}ms — ${String(url).slice(0, 180)}`);
      throw new Error(`Shopee API timeout sau ${timeoutMs / 1000}s`);
    }
    console.error(
      `[Shopee HTTP] FETCH LỖI — ${String(url).slice(0, 120)}:`,
      error?.message || error,
    );
    throw error;
  } finally {
    clearTimeout(timer);
    if (hardTimer) clearTimeout(hardTimer);
  }
}

export function shopeeExponentialBackoffMs(attempt, baseMs = SHOPEE_API_RETRY_BASE_MS) {
  return Math.min(30_000, baseMs * Math.pow(2, attempt));
}

const shopeeRetryTelemetry = { retries: 0, rateLimits: 0, exhausted: 0 };

export function snapshotShopeeRetryTelemetry() {
  return { ...shopeeRetryTelemetry };
}

export function diffShopeeRetryTelemetry(before) {
  return {
    retries: shopeeRetryTelemetry.retries - before.retries,
    rate_limits: shopeeRetryTelemetry.rateLimits - before.rateLimits,
    exhausted_retries: shopeeRetryTelemetry.exhausted - before.exhausted,
    max_retries: SHOPEE_API_MAX_RETRY,
  };
}

export function isShopeeRetryableNetworkError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return /timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|AbortError|fetch failed|network|socket/i.test(msg);
}

export function isShopeeRetryableHttpStatus(status) {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

/** Xử lý danh sách tuần tự theo gói — delay giữa item và nghỉ giữa các gói. */
export async function runInShopeeBatches(items, processor, opts) {
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

export function shopeeSyncDelay(ms = SHOPEE_SYNC_BATCH_DELAY_MS) {
  return sleep(ms);
}

export function shopeeApiErrorResult(err, context, httpStatus) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[Shopee API] ${context}:`, message);
  const status =
    httpStatus ||
    (/HTTP\s*401|\b401\b|invalid_access_token|unauthorized|auth/i.test(message)
      ? 401
      : /HTTP\s*429|\b429\b|rate.?limit|too many/i.test(message)
        ? 429
        : /HTTP\s*504|\b504\b|timeout|timed out|AbortError/i.test(message)
          ? 504
          : undefined);
  return {
    error: status === 401 ? "unauthorized" : status === 429 ? "rate_limit_exceeded" : status === 504 ? "gateway_timeout" : "shopee_api_error",
    message: formatShopeeApiError({ error: "shopee_api_error", message: `${context}: ${message}` }, status),
    httpStatus: status,
  };
}

export function formatShopeeApiError(json, httpStatus) {
  const parts = [json?.message, json?.error, json?.msg]
    .map((v) => String(v ?? "").trim())
    .filter((v) => v && !/^HTTP\s+\d+$/i.test(v));
  const status =
    typeof httpStatus === "number" && httpStatus > 0
      ? httpStatus
      : typeof json?.httpStatus === "number" && json.httpStatus > 0
        ? json.httpStatus
        : undefined;

  if (status === 401) {
    return parts[0] || SHOPEE_REAUTH_REQUIRED_MESSAGE;
  }
  if (status === 429) {
    return (
      parts[0] ||
      "Shopee giới hạn tần suất (HTTP 429 Too Many Requests) — vui lòng thử lại sau 1–2 phút."
    );
  }
  if (status === 504) {
    return (
      parts[0] ||
      "Timeout khi gọi Shopee API (HTTP 504) — cửa sổ đồng bộ quá rộng hoặc Shopee phản hồi chậm. Thử lại với đồng bộ nhanh (2 giờ)."
    );
  }
  if (/timeout|timed out|AbortError/i.test(parts.join(" "))) {
    return (
      parts[0] ||
      "Timeout khi gọi Shopee API — giảm phạm vi thời gian đồng bộ và thử lại."
    );
  }
  if (parts.length > 0) return parts.join(" — ");
  if (status && status >= 400) return `Shopee API lỗi HTTP ${status}`;
  return "Lỗi Shopee API không xác định";
}

export function isShopeeRateLimited(httpStatus, json) {
  if (httpStatus === 429) return true;
  const text = `${json?.error || ""} ${json?.message || ""}`.toLowerCase();
  return /rate.?limit|too many request|api_call_limit|exceed/.test(text);
}

export async function shopeeFetchJsonWithRetry(url, context, opts) {
  const maxAttempts = opts?.maxAttempts ?? SHOPEE_API_MAX_RETRY;
  const baseDelayMs = opts?.baseDelayMs ?? SHOPEE_API_RETRY_BASE_MS;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let res;
    let rawText = "";
    try {
      res = await fetchWithTimeout(url);
      rawText = await res.text();
    } catch (err) {
      const waitMs = shopeeExponentialBackoffMs(attempt, baseDelayMs);
      if (attempt < maxAttempts - 1 && isShopeeRetryableNetworkError(err)) {
        shopeeRetryTelemetry.retries++;
        console.warn(`[Shopee API] ${context} lỗi mạng, retry ${attempt + 2}/${maxAttempts} sau ${waitMs}ms...`);
        await sleep(waitMs);
        continue;
      }
      const netMsg = err instanceof Error ? err.message : String(err);
      throw new Error(`${context}: Không kết nối được Shopee API — ${netMsg}`);
    }

    let json;
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
      shopeeRetryTelemetry.retries++;
      if (isShopeeRateLimited(res.status, json)) shopeeRetryTelemetry.rateLimits++;
      const waitMs = shopeeExponentialBackoffMs(attempt, baseDelayMs);
      console.warn(
        `[Shopee API] ${context} HTTP ${res.status}, retry ${attempt + 2}/${maxAttempts} sau ${waitMs}ms...`,
      );
      await sleep(waitMs);
      continue;
    }

    if (res.status === 401 || res.status === 429 || res.status === 504 || (res.status >= 400 && json?.error)) {
      json.message = formatShopeeApiError(json, res.status);
      json.httpStatus = res.status;
    }

    return { json, httpStatus: res.status };
  }

  shopeeRetryTelemetry.exhausted++;
  return {
    httpStatus: 429,
    json: {
      error: "rate_limit_exceeded",
      message: formatShopeeApiError({ error: "rate_limit_exceeded" }, 429),
      httpStatus: 429,
    },
  };
}

export async function shopeePostJsonWithRetry(url, body, context, opts) {
  const maxAttempts = opts?.maxAttempts ?? SHOPEE_API_MAX_RETRY;
  const baseDelayMs = opts?.baseDelayMs ?? SHOPEE_API_RETRY_BASE_MS;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let res;
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
        shopeeRetryTelemetry.retries++;
        console.warn(`[Shopee API] ${context} lỗi mạng, retry ${attempt + 2}/${maxAttempts} sau ${waitMs}ms...`);
        await sleep(waitMs);
        continue;
      }
      const netMsg = err instanceof Error ? err.message : String(err);
      throw new Error(`${context}: Không kết nối được Shopee API — ${netMsg}`);
    }

    let json;
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
      shopeeRetryTelemetry.retries++;
      if (isShopeeRateLimited(res.status, json)) shopeeRetryTelemetry.rateLimits++;
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

  shopeeRetryTelemetry.exhausted++;
  return {
    httpStatus: 429,
    json: {
      error: "rate_limit_exceeded",
      message: formatShopeeApiError({ error: "rate_limit_exceeded" }, 429),
    },
  };
}
