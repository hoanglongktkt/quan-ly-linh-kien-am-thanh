/**
 * MongoDB Change Stream → xóa cache counter/list ở MỌI process.
 *
 * Passenger (cPanel) chạy NHIỀU process cho cùng 1 app; cache `/counter` và list
 * nằm trong RAM từng process. Webhook ghi ở process A thì process B (đang phục vụ
 * short polling của trình duyệt) vẫn giữ cache cũ — change stream chạy trong mọi
 * process nên process nào cũng xóa cache ngay khi collection `orders` đổi.
 *
 * Không dùng `fullDocument: updateLookup` — mỗi event sẽ tốn thêm 1 lượt đọc,
 * bulkWrite 20 đơn sẽ thành 20 query thừa trên Atlas Free. `documentKey._id`
 * đã đủ suy ra order_sn (`_id` = `shopee-<order_sn>`).
 */
import mongoose from "mongoose";
import { emitNewOrder, emitOrderUpdated } from "./orderRealtime.js";

/** Đơn mới phải hiện ngay — gom 300ms rồi bắn 1 lần. */
const NEW_ORDER_FLUSH_MS = 300;
/** Update chỉ cần refetch ngầm — gom 3s để sync lớn không spam SSE. */
const UPDATED_FLUSH_MS = 3_000;
/** Đổi trạng thái (UNPAID → READY_TO_SHIP...) làm đơn nhảy tab — bắn nhanh như đơn mới. */
const STATUS_FLUSH_MS = 300;
/** Mongo không ghi field $set trùng giá trị vào updatedFields → có key = trạng thái thật sự đổi. */
const STATUS_FIELDS = new Set([
  "status",
  "shopee_order_status",
  "data.status",
  "data.shopee_order_status",
]);
/**
 * Cron heal bulkWrite hàng trăm đơn → hàng trăm event update liên tiếp. Nếu giữ
 * nguyên cửa sổ 3s thì mỗi client phải refetch 20 lần/phút suốt phiên heal. Khi
 * event dồn dập thì nới cửa sổ gấp đôi mỗi lần, tối đa 30s; im ắng thì về lại 3s.
 */
const UPDATED_FLUSH_MAX_MS = 30_000;
const UPDATED_BURST_RESET_MS = 30_000;
/** Buffer đầy thì bắn sớm, không chờ hết cửa sổ gom. */
const MAX_BUFFERED_SNS = 500;
/** Trần reconnect — hết thì dừng hẳn, tránh vòng lặp vô tận đốt CPU cPanel. */
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_MS = 2_000;
/** Chạy ổn định quá ngưỡng này thì reset bộ đếm reconnect. */
const HEALTHY_RUN_MS = 60_000;

let deps = {
  /** @type {() => void} */
  invalidateTabCountCache: () => {},
  /** @type {() => void} */
  invalidateOrdersRefreshCache: () => {},
};

let stream = null;
let started = false;
let stopped = false;
let unsupported = false;
let reconnectAttempts = 0;
let reconnectTimer = null;
let healthyTimer = null;
let resumeToken = null;
let lastEventAt = 0;
let totalNew = 0;
let totalUpdated = 0;

/** @type {Set<string>} */
const pendingNew = new Set();
/** @type {Set<string>} */
const pendingUpdated = new Set();
/** @type {Set<string>} */
const pendingStatus = new Set();
let newFlushTimer = null;
let statusFlushTimer = null;
let updatedFlushTimer = null;
let updatedFlushWindowMs = UPDATED_FLUSH_MS;
let lastUpdatedFlushAt = 0;

export function initOrderChangeStream(partial) {
  deps = { ...deps, ...partial };
}

/** `_id` trong collection orders là `shopee-<order_sn>` — bóc lấy order_sn. */
function orderSnFromDocumentKey(documentKey) {
  const raw = String(documentKey?._id ?? "").trim();
  if (!raw) return "";
  return raw.replace(/^shopee-/i, "").trim();
}

function invalidateLocalCaches() {
  try {
    deps.invalidateTabCountCache?.();
  } catch {
    /* ignore */
  }
  try {
    deps.invalidateOrdersRefreshCache?.();
  } catch {
    /* ignore */
  }
}

function flushNew() {
  newFlushTimer = null;
  if (pendingNew.size === 0) return;
  const orderSns = [...pendingNew];
  pendingNew.clear();
  totalNew += orderSns.length;
  invalidateLocalCaches();
  // Không gửi shopId: change stream không đọc fullDocument. Frontend chỉ lọc theo
  // shop khi event CÓ shopId, nên bỏ trống = luôn refetch (không bao giờ sót đơn).
  emitNewOrder({ orderSns, count: orderSns.length });
  console.log(
    `[OrderChangeStream] pid=${process.pid} new_order n=${orderSns.length}` +
      ` sns=${orderSns.slice(0, 5).join(",")}`,
  );
}

function flushUpdated() {
  updatedFlushTimer = null;
  if (pendingUpdated.size === 0) return;
  const orderSns = [...pendingUpdated];
  pendingUpdated.clear();
  totalUpdated += orderSns.length;

  const now = Date.now();
  if (lastUpdatedFlushAt && now - lastUpdatedFlushAt <= updatedFlushWindowMs * 2) {
    updatedFlushWindowMs = Math.min(UPDATED_FLUSH_MAX_MS, updatedFlushWindowMs * 2);
  } else {
    updatedFlushWindowMs = UPDATED_FLUSH_MS;
  }
  lastUpdatedFlushAt = now;

  invalidateLocalCaches();
  emitOrderUpdated({ orderSns, count: orderSns.length });
  console.log(
    `[OrderChangeStream] pid=${process.pid} order_updated n=${orderSns.length}` +
      ` window=${updatedFlushWindowMs}ms`,
  );
}

function flushStatus() {
  statusFlushTimer = null;
  if (pendingStatus.size === 0) return;
  const orderSns = [...pendingStatus];
  pendingStatus.clear();
  totalUpdated += orderSns.length;
  invalidateLocalCaches();
  emitOrderUpdated({ orderSns, count: orderSns.length });
  console.log(
    `[OrderChangeStream] pid=${process.pid} order_updated(status) n=${orderSns.length}` +
      ` sns=${orderSns.slice(0, 5).join(",")}`,
  );
}

function scheduleStatusFlush() {
  if (pendingStatus.size >= MAX_BUFFERED_SNS) {
    if (statusFlushTimer) {
      clearTimeout(statusFlushTimer);
      statusFlushTimer = null;
    }
    flushStatus();
    return;
  }
  if (statusFlushTimer) return;
  statusFlushTimer = setTimeout(flushStatus, STATUS_FLUSH_MS);
  if (typeof statusFlushTimer.unref === "function") statusFlushTimer.unref();
}

function hasStatusChange(change) {
  const fields = change?.updateDescription?.updatedFields;
  if (!fields || typeof fields !== "object") return false;
  for (const key of Object.keys(fields)) {
    if (STATUS_FIELDS.has(key)) return true;
  }
  return false;
}

function scheduleNewFlush() {
  if (pendingNew.size >= MAX_BUFFERED_SNS) {
    if (newFlushTimer) {
      clearTimeout(newFlushTimer);
      newFlushTimer = null;
    }
    flushNew();
    return;
  }
  // Cửa sổ cố định (không reset timer mỗi event) — luồng event liên tục vẫn
  // được bắn đúng hạn, không bị dời vô hạn.
  if (newFlushTimer) return;
  newFlushTimer = setTimeout(flushNew, NEW_ORDER_FLUSH_MS);
  if (typeof newFlushTimer.unref === "function") newFlushTimer.unref();
}

function scheduleUpdatedFlush() {
  if (pendingUpdated.size >= MAX_BUFFERED_SNS) {
    if (updatedFlushTimer) {
      clearTimeout(updatedFlushTimer);
      updatedFlushTimer = null;
    }
    flushUpdated();
    return;
  }
  if (updatedFlushTimer) return;
  if (lastUpdatedFlushAt && Date.now() - lastUpdatedFlushAt > UPDATED_BURST_RESET_MS) {
    updatedFlushWindowMs = UPDATED_FLUSH_MS;
  }
  updatedFlushTimer = setTimeout(flushUpdated, updatedFlushWindowMs);
  if (typeof updatedFlushTimer.unref === "function") updatedFlushTimer.unref();
}

function handleChange(change) {
  lastEventAt = Date.now();
  if (change?._id) resumeToken = change._id;

  const orderSn = orderSnFromDocumentKey(change?.documentKey);
  if (!orderSn) return;

  if (change.operationType === "insert") {
    pendingNew.add(orderSn);
    // Đơn vừa insert không cần bắn thêm order_updated.
    pendingUpdated.delete(orderSn);
    pendingStatus.delete(orderSn);
    scheduleNewFlush();
    return;
  }
  if (pendingNew.has(orderSn)) return;
  if (change.operationType === "update" && hasStatusChange(change)) {
    pendingStatus.add(orderSn);
    pendingUpdated.delete(orderSn);
    scheduleStatusFlush();
    return;
  }
  if (pendingStatus.has(orderSn)) return;
  pendingUpdated.add(orderSn);
  scheduleUpdatedFlush();
}

/** Mongo standalone (không replica set) không hỗ trợ change stream — tắt hẳn, không retry. */
function isUnsupportedError(err) {
  const code = Number(err?.code);
  const msg = String(err?.message || err || "").toLowerCase();
  return (
    code === 40573 ||
    code === 40574 ||
    msg.includes("only supported on replica sets") ||
    (msg.includes("changestream") && msg.includes("not supported"))
  );
}

function scheduleReconnect(reason) {
  if (stopped || unsupported) return;
  if (reconnectTimer) return;
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error(
      `[OrderChangeStream] pid=${process.pid} DỪNG sau ${MAX_RECONNECT_ATTEMPTS} lần reconnect` +
        ` (${reason}). Realtime lùi về polling counter của frontend.`,
    );
    return;
  }
  reconnectAttempts += 1;
  const delay = RECONNECT_BASE_MS * 2 ** (reconnectAttempts - 1);
  console.warn(
    `[OrderChangeStream] pid=${process.pid} reconnect #${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}` +
      ` sau ${delay}ms (${reason})`,
  );
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    openStream();
  }, delay);
  if (typeof reconnectTimer.unref === "function") reconnectTimer.unref();
}

function closeCurrentStream() {
  if (healthyTimer) {
    clearTimeout(healthyTimer);
    healthyTimer = null;
  }
  if (!stream) return;
  const old = stream;
  stream = null;
  try {
    // Gỡ listener TRƯỚC khi close — nếu không, event "close" của stream cũ sẽ
    // kích scheduleReconnect và mở chồng thêm 1 stream nữa.
    old.removeAllListeners();
  } catch {
    /* ignore */
  }
  try {
    void Promise.resolve(old.close()).catch(() => {});
  } catch {
    /* ignore */
  }
}

function openStream() {
  if (stopped || unsupported) return;
  const db = mongoose.connection?.db;
  if (mongoose.connection?.readyState !== 1 || !db) {
    scheduleReconnect("mongo chưa sẵn sàng");
    return;
  }

  try {
    closeCurrentStream();
    const options = { batchSize: 200, maxAwaitTimeMS: 1_000 };
    // resumeAfter: nối lại đúng chỗ đứt, không phát lại trùng và không bỏ sót.
    if (resumeToken) options.resumeAfter = resumeToken;

    stream = db.collection("orders").watch(
      [{ $match: { operationType: { $in: ["insert", "update", "replace"] } } }],
      options,
    );
    // Shop im ắng vẫn phải được coi là khỏe — không chờ có đơn mới reset backoff.
    const opened = stream;
    healthyTimer = setTimeout(() => {
      healthyTimer = null;
      if (stream === opened) reconnectAttempts = 0;
    }, HEALTHY_RUN_MS);
    if (typeof healthyTimer.unref === "function") healthyTimer.unref();

    stream.on("change", (change) => {
      try {
        handleChange(change);
      } catch (err) {
        console.warn(
          "[OrderChangeStream] handleChange lỗi:",
          err?.message || err,
        );
      }
    });

    stream.on("error", (err) => {
      if (isUnsupportedError(err)) {
        unsupported = true;
        console.error(
          "[OrderChangeStream] MongoDB không hỗ trợ change stream (cần replica set/Atlas)." +
            " Tắt bridge, realtime dựa vào emit trực tiếp + polling counter.",
        );
        closeCurrentStream();
        return;
      }
      console.error(
        `[OrderChangeStream] pid=${process.pid} stream error:`,
        err?.message || err,
      );
      // resumeToken có thể đã quá hạn oplog → bỏ để mở lại từ hiện tại.
      if (Number(err?.code) === 286) resumeToken = null;
      closeCurrentStream();
      scheduleReconnect("stream error");
    });

    stream.on("close", () => {
      if (stopped || unsupported) return;
      scheduleReconnect("stream closed");
    });

    console.log(
      `[OrderChangeStream] pid=${process.pid} ĐANG NGHE collection orders` +
        ` (resume=${resumeToken ? "yes" : "no"})`,
    );
  } catch (err) {
    if (isUnsupportedError(err)) {
      unsupported = true;
      console.error(
        "[OrderChangeStream] MongoDB không hỗ trợ change stream (cần replica set/Atlas). Tắt bridge.",
      );
      return;
    }
    console.error(
      `[OrderChangeStream] pid=${process.pid} watch() thất bại:`,
      err?.message || err,
    );
    scheduleReconnect("watch exception");
  }
}

/** Bật bridge — idempotent, gọi sau khi Mongo ready. */
export function startOrderChangeStream() {
  if (String(process.env.ORDER_CHANGE_STREAM || "1").trim() === "0") {
    console.log("[OrderChangeStream] DISABLED (ORDER_CHANGE_STREAM=0)");
    return;
  }
  if (started) {
    console.log("[OrderChangeStream] already started (idempotent).");
    return;
  }
  started = true;
  stopped = false;
  openStream();
}

export function stopOrderChangeStream() {
  stopped = true;
  started = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (newFlushTimer) {
    clearTimeout(newFlushTimer);
    newFlushTimer = null;
  }
  if (updatedFlushTimer) {
    clearTimeout(updatedFlushTimer);
    updatedFlushTimer = null;
  }
  if (statusFlushTimer) {
    clearTimeout(statusFlushTimer);
    statusFlushTimer = null;
  }
  pendingNew.clear();
  pendingUpdated.clear();
  pendingStatus.clear();
  updatedFlushWindowMs = UPDATED_FLUSH_MS;
  lastUpdatedFlushAt = 0;
  closeCurrentStream();
  console.log(`[OrderChangeStream] pid=${process.pid} stopped.`);
}

export function getOrderChangeStreamStats() {
  return {
    alive: Boolean(stream) && !stopped && !unsupported,
    unsupported,
    reconnectAttempts,
    lastEventAt: lastEventAt ? new Date(lastEventAt).toISOString() : null,
    emittedNew: totalNew,
    emittedUpdated: totalUpdated,
  };
}
