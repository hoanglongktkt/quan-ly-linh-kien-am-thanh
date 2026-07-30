/**
 * Queue dò ngầm quét mã — Backend worker độc lập FE.
 * Phase 3: tách từ server.ts (normalizeScanBgKey … ackScanBgNotifications).
 */
import fs from "fs";
import path from "path";
import { resolveAppRoot } from "../utils/appPaths.js";

const APP_ROOT = resolveAppRoot();
const SCAN_BG_QUEUE_PATH = path.join(APP_ROOT, "data", "scan-bg-queue.json");

const scanBgJobs = [];
const scanBgJobKeys = new Set();
let scanBgWorkerRunning = false;
let scanBgPersistTimer = null;
let scanBgDrainKickTimer = null;

/** Deps từ server.ts (order helpers / mongoStore chưa tách hết). */
let deps = {
  findOrderByScanCodeInStore: async () => null,
  isValidOrder: () => false,
  mirrorTrackingFieldsForRead: (o) => o,
  resolveOrderFromShopeeByScanCode: async () => null,
  resolveOrderLocalStatusShared: () => "",
  existsDonHoanHuy: async () => false,
  isShopeeCancelOrReturnLikeOrder: () => false,
  ORDER_LOCAL_STATUS: { RETURN_RECEIVED: "RETURN_RECEIVED", CANCELLED_STORED: "CANCELLED_STORED" },
  clearHandedOverLocalForCancelReturn: () => {},
  setOrderLocalStatus: () => {},
  upsertDonHoanHuy: async () => ({ ok: false, error: "upsertDonHoanHuy_not_initialized" }),
  describeMongoWriteError: (err) => String(err?.message || err || ""),
  restoreLocalStockOnCancelReturnScan: async () => ({ restored: false }),
  markOrderLocalStatusInStore: async () => false,
};

export function initScanBgQueue(partial) {
  deps = { ...deps, ...partial };
  if (!scanBgJobs.some((j) => j.status === "pending")) return;
  // Chỉ kick 1 lần — tránh spawn setTimeout chồng khi init gọi lại.
  if (scanBgDrainKickTimer || scanBgWorkerRunning) return;
  scanBgDrainKickTimer = setTimeout(() => {
    scanBgDrainKickTimer = null;
    void drainScanBgQueue();
  }, 1500);
  if (typeof scanBgDrainKickTimer.unref === "function") {
    scanBgDrainKickTimer.unref();
  }
}

export function isScanBgWorkerRunning() {
  return scanBgWorkerRunning;
}

export function normalizeScanBgKey(code) {
  return String(code || "")
    .trim()
    .toUpperCase()
    .replace(/[\s\-_#./\\|:;,]+/g, "");
}

function loadScanBgQueueFromDisk() {
  try {
    if (!fs.existsSync(SCAN_BG_QUEUE_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(SCAN_BG_QUEUE_PATH, "utf-8"));
    const list = Array.isArray(raw?.jobs) ? raw.jobs : Array.isArray(raw) ? raw : [];
    for (const j of list) {
      const code = String(j?.code || "").trim();
      const codeKey = normalizeScanBgKey(code || j?.codeKey || "");
      if (!code || !codeKey || scanBgJobKeys.has(codeKey)) continue;
      const rawStatus = String(j?.status || "pending");
      // Job đang running khi process chết → đưa lại pending.
      let status =
        rawStatus === "running" || rawStatus === "pending"
          ? "pending"
          : rawStatus === "failed"
            ? "failed"
            : rawStatus === "skipped"
              ? "skipped"
              : "done";
      if (status !== "pending") {
        // Giữ recent done/failed chưa notify.
        if (j?.notified) continue;
      }
      const job = {
        id: String(j?.id || `sbg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`),
        code,
        codeKey,
        status,
        enqueuedAt: String(j?.enqueuedAt || new Date().toISOString()),
        startedAt: j?.startedAt ? String(j.startedAt) : undefined,
        finishedAt: j?.finishedAt ? String(j.finishedAt) : undefined,
        orderId: j?.orderId ? String(j.orderId) : undefined,
        orderSn: j?.orderSn ? String(j.orderSn) : undefined,
        action: j?.action,
        local_status: j?.local_status ? String(j.local_status) : undefined,
        message: j?.message ? String(j.message) : undefined,
        notified: Boolean(j?.notified),
      };
      scanBgJobs.push(job);
      if (job.status === "pending") {
        scanBgJobKeys.add(codeKey);
      }
    }
    console.log(
      `[Scan BG] loaded disk jobs=${scanBgJobs.length} pending=${scanBgJobs.filter((j) => j.status === "pending").length}`,
    );
  } catch (err) {
    console.warn("[Scan BG] load disk failed:", err?.message || err);
  }
}

function persistScanBgQueueSoon() {
  if (scanBgPersistTimer) return;
  scanBgPersistTimer = setTimeout(() => {
    scanBgPersistTimer = null;
    try {
      fs.mkdirSync(path.dirname(SCAN_BG_QUEUE_PATH), { recursive: true });
      // Giữ pending + 80 kết quả gần nhất.
      const pending = scanBgJobs.filter((j) => j.status === "pending" || j.status === "running");
      const recent = scanBgJobs
        .filter((j) => j.status !== "pending" && j.status !== "running")
        .slice(-80);
      const jobs = [...pending, ...recent];
      fs.writeFileSync(SCAN_BG_QUEUE_PATH, JSON.stringify({ jobs }, null, 0), "utf-8");
    } catch (err) {
      console.warn("[Scan BG] persist failed:", err?.message || err);
    }
  }, 250);
  if (typeof scanBgPersistTimer.unref === "function") {
    scanBgPersistTimer.unref();
  }
}

function classifyScanBgCancelReturn(order) {
  const status = String(order?.status || "");
  const raw = String(order?.shopee_order_status || "").toUpperCase();
  const kind = String(order?.shopee_cancel_return_kind || "");
  const isReturn =
    kind === "refund_return" ||
    status === "return_pending" ||
    status === "return_received" ||
    raw === "TO_RETURN" ||
    Boolean(order?.return_sn);
  const isCancel =
    !isReturn &&
    (kind === "cancelled" ||
      kind === "failed_delivery" ||
      status === "cancelled" ||
      raw === "CANCELLED" ||
      raw === "IN_CANCEL" ||
      deps.isShopeeCancelOrReturnLikeOrder(order));
  return { isReturn, isCancel };
}

export function enqueueScanBgCodes(codes) {
  const added = [];
  for (const raw of codes) {
    const code = String(raw || "").trim();
    const codeKey = normalizeScanBgKey(code);
    if (!code || !codeKey) continue;
    if (scanBgJobKeys.has(codeKey)) continue;
    // Đã có job pending/running cùng key?
    const existing = scanBgJobs.find(
      (j) => j.codeKey === codeKey && (j.status === "pending" || j.status === "running"),
    );
    if (existing) continue;
    const job = {
      id: `sbg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      code,
      codeKey,
      status: "pending",
      enqueuedAt: new Date().toISOString(),
      notified: false,
    };
    scanBgJobs.push(job);
    scanBgJobKeys.add(codeKey);
    added.push(job);
  }
  if (added.length) {
    persistScanBgQueueSoon();
    void drainScanBgQueue();
  }
  const pending = scanBgJobs.filter((j) => j.status === "pending" || j.status === "running").length;
  return { queued: added.length, pending, jobs: added };
}

async function processOneScanBgJob(job) {
  job.status = "running";
  job.startedAt = new Date().toISOString();
  persistScanBgQueueSoon();

  try {
    let found = null;
    try {
      found = await deps.findOrderByScanCodeInStore(job.code);
      if (found && !deps.isValidOrder(found)) found = null;
      if (found) found = deps.mirrorTrackingFieldsForRead(found);
    } catch {
      found = null;
    }
    if (!found) {
      try {
        found = await deps.resolveOrderFromShopeeByScanCode(job.code);
        if (found) {
          found = deps.mirrorTrackingFieldsForRead(found);
        }
      } catch (err) {
        console.warn(`[Scan BG] Shopee resolve code=${job.code}:`, err?.message || err);
      }
    }

    if (!found) {
      job.status = "done";
      job.action = "not_found";
      job.message = `Không tìm thấy đơn khớp mã "${job.code}"`;
      job.finishedAt = new Date().toISOString();
      scanBgJobKeys.delete(job.codeKey);
      return;
    }

    job.orderId = found.id ? String(found.id) : undefined;
    job.orderSn = found.orderSn ? String(found.orderSn) : undefined;

    const existingLocal = deps.resolveOrderLocalStatusShared(found);
    let alreadyDhh = false;
    try {
      alreadyDhh = await deps.existsDonHoanHuy(String(found.orderSn || ""));
    } catch {
      alreadyDhh = false;
    }
    // Chỉ coi đã xong khi CÓ BẢN GHI thật trong don_hoan_huy (không tin status sàn).
    if (alreadyDhh) {
      job.status = "done";
      job.action = "duplicate";
      job.local_status =
        existingLocal === "RETURN_RECEIVED" ? "RETURN_RECEIVED" : "CANCELLED_STORED";
      job.message = `Đơn #${found.orderSn} đã có trong don_hoan_huy`;
      job.finishedAt = new Date().toISOString();
      scanBgJobKeys.delete(job.codeKey);
      return;
    }

    const { isReturn, isCancel } = classifyScanBgCancelReturn(found);
    if (!isReturn && !isCancel) {
      job.status = "done";
      job.action = "found_other";
      job.message = `Đơn #${found.orderSn} không phải hủy/hoàn — bỏ qua ghi cờ`;
      job.finishedAt = new Date().toISOString();
      scanBgJobKeys.delete(job.codeKey);
      return;
    }

    const target = isReturn
      ? deps.ORDER_LOCAL_STATUS.RETURN_RECEIVED
      : deps.ORDER_LOCAL_STATUS.CANCELLED_STORED;
    const wasHandedOver =
      existingLocal === "HANDED_OVER" ||
      found.is_handed_over === true ||
      found.isHandedOverToCarrier === true;
    deps.clearHandedOverLocalForCancelReturn(found);
    deps.setOrderLocalStatus(found, target);

    try {
      const restock = await deps.restoreLocalStockOnCancelReturnScan(found, { wasHandedOver });
      if (restock?.restored) {
        console.log(`[Scan BG] Restock +${restock.qty || 0} order_sn=${found.orderSn}`);
      }
    } catch (restockErr) {
      console.warn(`[Scan BG] Restock fail order_sn=${found.orderSn}:`, restockErr?.message || restockErr);
    }

    // SSOT tab hủy/hoàn: ghi collection don_hoan_huy (TTL 14 ngày) — models/DonHoanHuy.js.
    const dhh = await deps.upsertDonHoanHuy(found, {
      type: isReturn ? "return" : "cancelled",
      scanCode: job.code,
      source: "scan_bg",
    });
    if (!dhh.ok) {
      throw new Error(dhh.error || "Ghi don_hoan_huy thất bại");
    }

    try {
      await deps.markOrderLocalStatusInStore(String(found.orderSn || ""), target, {
        shopId: found.shopId != null ? String(found.shopId) : undefined,
        clearHandedOver: true,
        status: isReturn ? "return_received" : "cancelled",
        stockRestored: Boolean(found.stock_restored),
        stockRestoredAt: found.stock_restored_at ? String(found.stock_restored_at) : undefined,
      });
    } catch (flagErr) {
      console.warn(`[Scan BG] mark local_status fail order_sn=${found.orderSn}:`, flagErr?.message || flagErr);
    }

    job.status = "done";
    job.action = isReturn ? "return_received" : "cancelled";
    job.local_status = target;
    job.message = isReturn
      ? `Đã dò ngầm nhận hoàn #${found.orderSn} → don_hoan_huy`
      : `Đã dò ngầm đơn hủy #${found.orderSn} → don_hoan_huy`;
    job.finishedAt = new Date().toISOString();
    scanBgJobKeys.delete(job.codeKey);
  } catch (err) {
    job.status = "failed";
    job.action = "error";
    job.message = deps.describeMongoWriteError(err);
    job.finishedAt = new Date().toISOString();
    scanBgJobKeys.delete(job.codeKey);
    console.error(`[Scan BG] job fail code=${job.code}:`, err);
  } finally {
    persistScanBgQueueSoon();
  }
}

export async function drainScanBgQueue() {
  if (scanBgWorkerRunning) return;
  scanBgWorkerRunning = true;
  try {
    while (true) {
      const next = scanBgJobs.find((j) => j.status === "pending");
      if (!next) break;
      await processOneScanBgJob(next);
      // Nghỉ ngắn giữa các mã — tránh rate-limit Shopee.
      await new Promise((r) => setTimeout(r, 400));
    }
  } finally {
    scanBgWorkerRunning = false;
    const stillPending = scanBgJobs.some((j) => j.status === "pending");
    if (stillPending) {
      queueMicrotask(() => {
        void drainScanBgQueue();
      });
    }
  }
}

export function getScanBgStatusSnapshot() {
  const pending = scanBgJobs.filter((j) => j.status === "pending");
  const running = scanBgJobs.filter((j) => j.status === "running");
  const recent = scanBgJobs
    .filter((j) => j.status === "done" || j.status === "failed" || j.status === "skipped")
    .slice(-40);
  const unnotified = recent.filter((j) => !j.notified);
  const summary = { cancelled: 0, returnReceived: 0, notFound: 0, failed: 0 };
  for (const j of unnotified) {
    if (j.action === "cancelled") summary.cancelled += 1;
    else if (j.action === "return_received") summary.returnReceived += 1;
    else if (j.action === "not_found") summary.notFound += 1;
    else if (j.action === "error" || j.status === "failed") summary.failed += 1;
  }
  return {
    pending,
    running,
    recent,
    unnotified,
    pendingCount: pending.length + running.length,
    summary,
  };
}

export function ackScanBgNotifications(ids) {
  const idSet = Array.isArray(ids) && ids.length > 0 ? new Set(ids.map(String)) : null;
  let n = 0;
  for (const j of scanBgJobs) {
    if (j.status !== "done" && j.status !== "failed" && j.status !== "skipped") continue;
    if (j.notified) continue;
    if (idSet && !idSet.has(j.id)) continue;
    j.notified = true;
    n += 1;
  }
  if (n) persistScanBgQueueSoon();
  return n;
}

// Khởi động lại: load disk ngay; worker chỉ drain sau initScanBgQueue (có deps).
try {
  loadScanBgQueueFromDisk();
} catch {
  /* ignore boot */
}
