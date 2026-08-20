/**
 * Background sync trạng thái vận đơn GHN (đơn ngoại sàn) → MongoDB.
 * Chỉ quét đơn còn mở; delay + limit + mutex để không treo cPanel / spam GHN.
 */
import { persistChangedOrdersPatch } from "./orders.js";
import {
  isMongoReady,
  findOpenGhnExternalOrdersFromStore,
  invalidateTabCountCache,
} from "../src/db/mongoStore.ts";
import {
  getGhnOrderDetail,
  mapGhnStatusToExternal,
  ghnSleep,
} from "./ghnLogistics.js";

const EXTERNAL_STATUS_MAP = {
  created: { status: "unprocessed", shopee: "EXTERNAL_CREATED" },
  shipping: { status: "shipping", shopee: "EXTERNAL_SHIPPING" },
  delivered: { status: "completed", shopee: "EXTERNAL_DELIVERED" },
  rts: { status: "cancelled", shopee: "EXTERNAL_RTS" },
  cancelled: { status: "cancelled", shopee: "EXTERNAL_CANCELLED" },
};

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 40;
const DEFAULT_DELAY_MS = 300;
const DEFAULT_MAX_MS = 90_000;
const DEFAULT_LOOKBACK_DAYS = 90;
const MAX_CONSECUTIVE_ERRORS = 5;

let ghnStatusSyncInFlight = false;

function clampInt(value, fallback, min, max) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function applyMappedStatus(order, mappedKey, extra = {}) {
  const mapped = EXTERNAL_STATUS_MAP[mappedKey] || EXTERNAL_STATUS_MAP.created;
  return {
    ...order,
    external_status: mappedKey,
    status: mapped.status,
    shopee_order_status: mapped.shopee,
    is_rts: mappedKey === "rts",
    ghn_synced_at: new Date().toISOString(),
    ...extra,
  };
}

function currentExternalKey(order) {
  const ext = String(order?.external_status || "").toLowerCase();
  if (EXTERNAL_STATUS_MAP[ext]) return ext;
  return mapGhnStatusToExternal(order?.ghn_status);
}

/**
 * Một tick cron: quét tối đa `limit` đơn GHN còn mở, gọi detail từng đơn có delay.
 */
export async function runGhnStatusSync(opts = {}) {
  const trigger = String(opts.trigger || "cron");
  if (ghnStatusSyncInFlight) {
    return {
      skipped: true,
      message: "busy",
      trigger,
      scanned: 0,
      updated: 0,
      unchanged: 0,
      errors: 0,
    };
  }
  if (!isMongoReady()) {
    return {
      skipped: true,
      message: "mongodb_not_ready",
      trigger,
      scanned: 0,
      updated: 0,
      unchanged: 0,
      errors: 0,
    };
  }

  const limit = clampInt(
    opts.limit ?? process.env.AUTO_GHN_STATUS_SYNC_LIMIT,
    DEFAULT_LIMIT,
    1,
    MAX_LIMIT,
  );
  const delayMs = clampInt(
    opts.delayMs ?? process.env.AUTO_GHN_STATUS_SYNC_DELAY_MS,
    DEFAULT_DELAY_MS,
    120,
    2_000,
  );
  const maxMs = clampInt(
    opts.maxMs ?? process.env.AUTO_GHN_STATUS_SYNC_MAX_MS,
    DEFAULT_MAX_MS,
    15_000,
    120_000,
  );
  const lookbackDays = clampInt(
    opts.lookbackDays ?? process.env.AUTO_GHN_STATUS_SYNC_LOOKBACK_DAYS,
    DEFAULT_LOOKBACK_DAYS,
    7,
    180,
  );

  ghnStatusSyncInFlight = true;
  const startedAt = Date.now();
  let scanned = 0;
  let updated = 0;
  let unchanged = 0;
  let errors = 0;
  let consecutiveErrors = 0;
  let stopped = "";

  try {
    const candidates = await findOpenGhnExternalOrdersFromStore({ limit, lookbackDays });
    const batch = Array.isArray(candidates) ? candidates.slice(0, limit) : [];
    console.log(
      `[GHN Status Sync] START trigger=${trigger} candidates=${batch.length} limit=${limit} delay=${delayMs}ms`,
    );

    for (let i = 0; i < batch.length; i += 1) {
      if (Date.now() - startedAt >= maxMs) {
        stopped = "deadline";
        break;
      }
      if (i > 0) await ghnSleep(delayMs);

      const order = batch[i];
      const trackingNo = String(order?.tracking_no || order?.trackingNumber || "").trim();
      if (!trackingNo) continue;
      scanned += 1;

      try {
        const detail = await getGhnOrderDetail(
          trackingNo,
          order.ghnShopId || order.ghn_shop_id,
        );
        consecutiveErrors = 0;
        const mappedKey = String(detail.externalStatus || mapGhnStatusToExternal(detail.status));
        const prevKey = currentExternalKey(order);
        const prevGhn = String(order.ghn_status || "").toLowerCase();
        const nextGhn = String(detail.status || "").toLowerCase();
        if (mappedKey === prevKey && nextGhn === prevGhn) {
          unchanged += 1;
          await persistChangedOrdersPatch([
            { ...order, ghn_synced_at: new Date().toISOString() },
          ]);
          continue;
        }
        const patched = applyMappedStatus(order, mappedKey, {
          ghn_status: detail.status,
          ghnShopId: detail.shopId || order.ghnShopId,
        });
        await persistChangedOrdersPatch([patched]);
        updated += 1;
        console.log(
          `[GHN Status Sync] ${order.orderSn || trackingNo} ${prevKey}/${prevGhn || "-"} → ${mappedKey}/${nextGhn}`,
        );
      } catch (err) {
        errors += 1;
        consecutiveErrors += 1;
        console.warn(
          `[GHN Status Sync] skip ${order?.orderSn || trackingNo}:`,
          err?.message || err,
        );
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          stopped = "consecutive_errors";
          break;
        }
      }
    }

    if (updated > 0) {
      try {
        invalidateTabCountCache();
      } catch {
        /* optional */
      }
    }

    const elapsed = Date.now() - startedAt;
    console.log(
      `[GHN Status Sync] DONE trigger=${trigger} scanned=${scanned} updated=${updated}` +
        ` unchanged=${unchanged} errors=${errors} stopped=${stopped || "ok"} ${elapsed}ms`,
    );
    return {
      skipped: false,
      trigger,
      scanned,
      updated,
      unchanged,
      errors,
      stopped: stopped || null,
      elapsedMs: elapsed,
      message: `scanned=${scanned} updated=${updated} unchanged=${unchanged} errors=${errors}`,
    };
  } catch (err) {
    console.error("[GHN Status Sync] FAILED:", err?.message || err);
    return {
      skipped: false,
      trigger,
      scanned,
      updated,
      unchanged,
      errors: errors + 1,
      message: err?.message || "ghn_status_sync_failed",
    };
  } finally {
    ghnStatusSyncInFlight = false;
  }
}
