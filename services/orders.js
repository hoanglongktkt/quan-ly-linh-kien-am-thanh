/**
 * Orders core: load / persist / lookup / cleanup.
 * Phase 5 — tách từ server.ts. Luồng mongoStore giữ nguyên, chỉ đổi nơi gọi.
 */
import fs from "fs";
import path from "path";
import { resolveAppRoot } from "../utils/appPaths.js";
import {
  isMongoReady,
  loadOrdersFromStore,
  bulkUpsertOrdersToStore,
  deleteOrdersFromStore,
  deleteHandedOverOrdersFromStore,
  deleteClosedOrdersByRetention,
  mirrorTopLevelTrackingIntoData,
  purgeMongoTempCollections,
  markOrderHandedOverInStore,
  findOrderByScanCodeInStore,
} from "../src/db/mongoStore.ts";

const APP_ROOT = resolveAppRoot();
const ORDERS_DB_PATH = path.join(APP_ROOT, "data", "orders.json");
const HANDED_OVER_CLEANUP_MARKER = path.join(APP_ROOT, "data", ".cleanup-handed-over-v2");

/** Deps từ server.ts (repair / tab matchers / handover utils chưa tách hết). */
let deps = {
  repairMisassignedTracking: (o) => o,
  repairFalseProcessedReadyToShip: (o) => o,
  isValidOrder: () => true,
  matchesHandedOverCarrierTabOrder: () => false,
  matchesReceivedCancelReturnTabOrder: () => false,
  resolveLocalStatusUpdatedAt: () => 0,
  isShopeeInternalTrackingCode: () => false,
  hasLeftHandedOverCarrierTab: () => false,
  resolveOrderHandoverFlag: () => false,
  isEligibleForHandOverShared: () => false,
  matchesProcessedPickupTabShared: () => false,
  hasOrderTrackingNoShared: () => false,
  getHandOverIneligibleReasonShared: () => "",
  applyHandedOverWrite: (o) => o,
  HANDED_OVER_SOURCE: { QR_SCAN: "qr_scan", MANUAL_BUTTON: "manual_button" },
};

export function initOrdersService(partial) {
  deps = { ...deps, ...partial };
}

let orderLookupIndex = null;
let ordersJsonMirrorQueued = false;
let ordersJsonMirrorSnapshot = null;
let closedOrdersRetentionRunning = false;
let closedOrdersRetentionTimer;
let mongoTempCleanupRunning = false;
let mongoTempCleanupTimer;

export function normalizeOrderIndexKey(raw) {
  return String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/[\s\-_#./\\|:;,]+/g, "");
}

export function rebuildOrderLookupIndex(orders) {
  const byId = new Map();
  const byOrderSn = new Map();
  const byTracking = new Map();
  const byReturnTracking = new Map();
  const byInternal = new Map();
  const byPackage = new Map();

  (Array.isArray(orders) ? orders : []).forEach((order, index) => {
    const put = (map, value) => {
      const key = normalizeOrderIndexKey(String(value || ""));
      if (key) map.set(key, index);
    };
    put(byId, order.id);
    put(byId, order._id);
    put(byId, String(order.id || "").replace(/^shopee-/i, ""));
    put(byId, String(order._id || "").replace(/^shopee-/i, ""));
    put(byOrderSn, order.orderSn);
    put(byOrderSn, order.order_sn);
    put(byTracking, order.trackingNumber);
    put(byTracking, order.tracking_no);
    put(byReturnTracking, order.return_tracking_no);
    put(byReturnTracking, order.returnTrackingNumber);
    put(byInternal, order.internalTrackingCode);
    put(byPackage, order.packageNumber);
  });

  return { byId, byOrderSn, byTracking, byReturnTracking, byInternal, byPackage };
}

export function getOrderLookupIndex(orders) {
  orderLookupIndex = rebuildOrderLookupIndex(orders);
  return orderLookupIndex;
}

export function loadOrders() {
  try {
    if (!fs.existsSync(ORDERS_DB_PATH)) {
      orderLookupIndex = rebuildOrderLookupIndex([]);
      return [];
    }
    const raw = fs.readFileSync(ORDERS_DB_PATH, "utf-8");
    const parsed = raw.trim() ? JSON.parse(raw) : [];
    const orders = Array.isArray(parsed)
      ? parsed.map(deps.repairMisassignedTracking)
      : [];
    orderLookupIndex = rebuildOrderLookupIndex(orders);
    return orders;
  } catch (error) {
    console.error("[Orders DB] Failed to read orders.json:", error);
    orderLookupIndex = rebuildOrderLookupIndex([]);
    return [];
  }
}

/** Mirror tracking fields for READ — không xóa/sửa mã vận đơn. */
export function mirrorTrackingFieldsForRead(order) {
  if (!order || typeof order !== "object") return order;
  if (order.tracking_no && !order.trackingNumber) order.trackingNumber = order.tracking_no;
  if (order.trackingNumber && !order.tracking_no) order.tracking_no = order.trackingNumber;
  return order;
}

/** Legacy mirror only: never block a Mongo-backed API response on orders.json. */
export function queueOrdersJsonMirror(orders) {
  ordersJsonMirrorSnapshot = Array.isArray(orders) ? orders : [];
  if (ordersJsonMirrorQueued) return;
  ordersJsonMirrorQueued = true;
  setImmediate(() => {
    const snapshot = ordersJsonMirrorSnapshot;
    ordersJsonMirrorSnapshot = null;
    ordersJsonMirrorQueued = false;
    if (!snapshot) return;
    try {
      saveOrders(snapshot);
    } catch (err) {
      console.warn("[Orders JSON Mirror] skipped:", err?.message || err);
    }
    if (ordersJsonMirrorSnapshot) queueOrdersJsonMirror(ordersJsonMirrorSnapshot);
  });
}

export function queueOrdersJsonMirrorFromMongo() {
  setImmediate(() => {
    void loadOrdersFromStore()
      .then((orders) => queueOrdersJsonMirror(orders))
      .catch((err) =>
        console.warn("[Orders JSON Mirror] Mongo snapshot skipped:", err?.message || err),
      );
  });
}

/** Mongo is the SSOT. orders.json is an asynchronous legacy mirror only. */
export async function persistOrdersToDatabase(orders, changedOrders) {
  if (!changedOrders.length) return 0;
  if (!isMongoReady()) throw new Error("mongodb_not_ready");
  try {
    const n = await bulkUpsertOrdersToStore(changedOrders);
    queueOrdersJsonMirror(orders);
    console.log(`[Orders Persist] Mongo bulkWrite OK — upsertedDocs=${n}`);
    return n;
  } catch (err) {
    console.error("[Orders Persist] Mongo bulkWrite failed:", err?.message || err);
    throw err;
  }
}

export async function loadOrdersForApi(opts) {
  const normalize = opts?.readOnly
    ? mirrorTrackingFieldsForRead
    : deps.repairMisassignedTracking;
  if (!isMongoReady()) {
    throw new Error("mongodb_not_ready");
  }
  try {
    const orders = (await loadOrdersFromStore()).filter(deps.isValidOrder).map(normalize);
    return { orders, dirty: false, handoverMongoSync: [] };
  } catch (err) {
    console.warn("[Orders] Mongo read failed:", err?.message || err);
    throw err;
  }
}

/**
 * Load CHỈ các đơn cần ship — ưu tiên Mongo $in (không find({}) / không đọc full JSON).
 */
export async function loadOrdersForShipScoped(orderIds, orderSns) {
  const idSet = new Set(
    (orderIds || []).map((s) => String(s || "").trim()).filter(Boolean),
  );
  const snSet = new Set(
    (orderSns || [])
      .map((s) => String(s || "").replace(/^shopee-/i, "").trim())
      .filter(Boolean),
  );
  for (const id of idSet) {
    const stripped = id.replace(/^shopee-/i, "").trim();
    if (stripped) snSet.add(stripped);
  }
  if (idSet.size === 0 && snSet.size === 0) return [];

  const matchKey = (o) => {
    if (!o || typeof o !== "object") return false;
    const id = String(o.id || o._id || "").trim();
    const sn = String(o.orderSn || o.order_sn || "").replace(/^shopee-/i, "").trim();
    if (id && idSet.has(id)) return true;
    if (sn && (snSet.has(sn) || idSet.has(sn) || idSet.has(`shopee-${sn}`))) return true;
    if (id && snSet.has(id.replace(/^shopee-/i, "").trim())) return true;
    return false;
  };

  const bySn = new Map();
  const byId = new Map();
  const put = (o) => {
    if (!deps.isValidOrder(o) || !matchKey(o)) return;
    deps.repairFalseProcessedReadyToShip(o);
    const sn = String(o.orderSn || "").replace(/^shopee-/i, "").trim();
    const id = String(o.id || "").trim();
    if (sn) bySn.set(sn, o);
    if (id) byId.set(id, o);
  };

  if (isMongoReady()) {
    try {
      const mongoOrders = (
        await loadOrdersFromStore({
          orderSns: [...snSet],
          ids: [...idSet],
        })
      ).map(deps.repairMisassignedTracking);
      for (const m of mongoOrders) put(m);
    } catch (err) {
      console.warn("[Orders] loadOrdersForShipScoped mongo skip:", err?.message || err);
    }
  }

  const out = [];
  const seen = new Set();
  for (const o of bySn.values()) {
    const k = String(o.orderSn || o.id || "");
    if (k && seen.has(k)) continue;
    if (k) seen.add(k);
    out.push(o);
  }
  for (const o of byId.values()) {
    const k = String(o.orderSn || o.id || "");
    if (k && seen.has(k)) continue;
    if (k) seen.add(k);
    out.push(o);
  }
  return out;
}

/** Mongo-only patch; JSON is rebuilt from Mongo asynchronously for legacy export. */
export async function persistChangedOrdersPatch(changedOrders) {
  const changed = (Array.isArray(changedOrders) ? changedOrders : []).filter(Boolean);
  if (changed.length === 0) return 0;
  if (!isMongoReady()) throw new Error("mongodb_not_ready");
  const written = await bulkUpsertOrdersToStore(changed);
  queueOrdersJsonMirrorFromMongo();
  return written;
}

/** API: ép đổ tracking Mongo → orders.json (cứu mã GHN sau sync script). */
export async function hydrateTrackingFromMongoToJson() {
  let mirrored = 0;
  try {
    mirrored = await mirrorTopLevelTrackingIntoData();
  } catch (err) {
    console.warn("[Orders] mirrorTopLevelTrackingIntoData:", err?.message || err);
  }
  const { orders, dirty, handoverMongoSync } = await loadOrdersForApi();
  if (dirty) {
    saveOrders(orders);
    try {
      const withTn = orders.filter(
        (o) => String(o.trackingNumber || o.tracking_no || "").trim(),
      );
      const toUpsert = [
        ...withTn,
        ...handoverMongoSync.filter(
          (o) => !withTn.some((t) => t.id === o.id || t.orderSn === o.orderSn),
        ),
      ];
      if (toUpsert.length) await bulkUpsertOrdersToStore(toUpsert);
    } catch (err) {
      console.warn("[Orders] hydrate bulkUpsert:", err?.message || err);
    }
  }
  const filled = orders.filter((o) =>
    String(o.trackingNumber || o.tracking_no || "").trim(),
  ).length;
  return { mirrored, filled, total: orders.length };
}

export function saveOrders(orders) {
  try {
    const sanitized = orders.map(deps.repairMisassignedTracking);
    if (isMongoReady() && sanitized.length > 0) {
      void bulkUpsertOrdersToStore(sanitized).catch((err) =>
        console.warn("[Orders JSON Mirror] Mongo sync failed:", err?.message || err),
      );
    }
    fs.mkdirSync(path.dirname(ORDERS_DB_PATH), { recursive: true });
    fs.writeFileSync(ORDERS_DB_PATH, JSON.stringify(sanitized), "utf-8");
    orderLookupIndex = rebuildOrderLookupIndex(sanitized);
    console.log(
      `[Orders DB] WRITE OK — path=${ORDERS_DB_PATH} count=${sanitized.length}`,
    );
    return true;
  } catch (error) {
    console.error(
      "LỖI SYNC SHOPEE: Failed to write orders.json:",
      error?.message || error,
      error?.stack || "",
    );
    return false;
  }
}

function isHandedOverGarbageOrder(order) {
  return deps.matchesHandedOverCarrierTabOrder(order);
}

/**
 * XÓA HẾT đơn match tab ĐÃ GIAO CHO ĐVVC (JSON bulk + Mongo deleteMany).
 */
export async function purgeHandedOverGarbageOrdersOnce(opts) {
  const force = Boolean(opts?.force);
  const orders = loadOrders();
  const garbage = orders.filter(isHandedOverGarbageOrder);

  if (!force && garbage.length === 0 && fs.existsSync(HANDED_OVER_CLEANUP_MARKER)) {
    return { removed: 0, sns: [], skipped: true };
  }

  const sns = garbage
    .map((o) => String(o.orderSn || o.id || "").trim())
    .filter(Boolean);
  const ids = garbage.map((o) => String(o.id || "").trim()).filter(Boolean);

  if (garbage.length > 0) {
    saveOrders(orders.filter((o) => !isHandedOverGarbageOrder(o)));
    console.log(`Deleted count (JSON): ${garbage.length}`);
  }

  let mongoDeleted = 0;
  let mongoSns = [];
  if (isMongoReady()) {
    try {
      if (ids.length || sns.length) {
        mongoDeleted += await deleteOrdersFromStore([...ids, ...sns]);
      }
      const byFlag = await deleteHandedOverOrdersFromStore();
      mongoDeleted += byFlag.deleted;
      mongoSns = byFlag.sns;
      console.log(`Deleted count (Mongo): ${mongoDeleted}`);
    } catch (err) {
      console.warn("[Cleanup HandedOver] Mongo delete failed:", err?.message || err);
    }
  }

  const allSns = [...new Set([...sns, ...mongoSns])];
  const removed = Math.max(garbage.length, allSns.length, mongoDeleted);
  console.log(`Deleted count: ${removed}`);

  const stillLeft = loadOrders().filter(isHandedOverGarbageOrder).length;
  if (stillLeft === 0) {
    try {
      const v1 = path.join(APP_ROOT, "data", ".cleanup-handed-over-v1");
      if (fs.existsSync(v1)) fs.unlinkSync(v1);
      fs.mkdirSync(path.dirname(HANDED_OVER_CLEANUP_MARKER), { recursive: true });
      fs.writeFileSync(
        HANDED_OVER_CLEANUP_MARKER,
        JSON.stringify(
          {
            at: new Date().toISOString(),
            removed,
            jsonRemoved: garbage.length,
            mongoDeleted,
            sns: allSns,
          },
          null,
          2,
        ),
        "utf-8",
      );
    } catch {
      /* ignore */
    }
  } else {
    console.warn(`[Cleanup HandedOver] Vẫn còn ${stillLeft} đơn ĐVVC sau purge — sẽ chạy lại.`);
  }

  console.log(
    `[Cleanup HandedOver] ĐÃ XÓA json=${garbage.length} mongo=${mongoDeleted} — ${allSns.join(", ") || "(none)"}`,
  );
  return { removed, sns: allSns, skipped: false };
}

/** Dọn tab "Đã nhận đơn hủy, đơn hoàn": gỡ cờ nội bộ sau 14 ngày — KHÔNG xóa đơn. */
export async function archiveStaleReceivedCancelReturnOrders(retentionDays = 14) {
  const orders = loadOrders();
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const changed = [];

  for (let i = 0; i < orders.length; i++) {
    const order = orders[i];
    if (!deps.matchesReceivedCancelReturnTabOrder(order)) continue;
    const updatedAt = deps.resolveLocalStatusUpdatedAt(order);
    if (!updatedAt || updatedAt >= cutoff) continue;

    const next = { ...order };
    next.local_status = null;
    next.localStatus = null;
    next.is_local_return_archived = true;
    orders[i] = next;
    changed.push(next);
  }

  if (changed.length > 0) {
    await persistOrdersToDatabase(orders, changed);
  }
  console.log(
    `[Local Return Archive] retention=${retentionDays}d scanned=${orders.length} archived=${changed.length}`,
  );
  return { scanned: orders.length, archived: changed.length };
}

/**
 * Xóa đơn đã đóng khỏi Mongo (+ mirror JSON) để giải phóng Atlas free tier.
 */
export async function purgeClosedOrdersByRetention(opts) {
  const cancelReturnDays = Math.max(1, Math.floor(opts?.cancelReturnDays ?? 14));
  const closedDays = Math.max(1, Math.floor(opts?.closedDays ?? 30));
  const dryRun = Boolean(opts?.dryRun);

  if (!isMongoReady()) {
    return {
      deleted: 0,
      jsonRemoved: 0,
      sns: [],
      scanned: 0,
      dryRun,
      cancelReturnMatched: 0,
      closedMatched: 0,
      message: "Mongo chưa sẵn sàng — bỏ qua retention cleanup.",
    };
  }

  const mongoResult = await deleteClosedOrdersByRetention({
    cancelReturnDays,
    closedDays,
    dryRun,
  });

  let jsonRemoved = 0;
  if (!dryRun && mongoResult.sns.length > 0) {
    try {
      const snSet = new Set(
        mongoResult.sns.map((s) => String(s || "").replace(/^shopee-/i, "").trim()).filter(Boolean),
      );
      const orders = loadOrders();
      const kept = orders.filter((o) => {
        const sn = String(o?.orderSn || "").replace(/^shopee-/i, "").trim();
        const id = String(o?.id || "").replace(/^shopee-/i, "").trim();
        return !snSet.has(sn) && !snSet.has(id);
      });
      jsonRemoved = orders.length - kept.length;
      if (jsonRemoved > 0) saveOrders(kept);
    } catch (err) {
      console.warn("[Orders Retention] JSON mirror cleanup:", err?.message || err);
    }
    try {
      queueOrdersJsonMirrorFromMongo();
    } catch {
      /* ignore */
    }
  }

  const message = dryRun
    ? `Dry-run: sẽ xóa ~${mongoResult.sns.length} đơn (hủy/hoàn ${mongoResult.cancelReturnMatched} @${cancelReturnDays}d, đóng ${mongoResult.closedMatched} @${closedDays}d).`
    : mongoResult.deleted > 0
      ? `Đã xóa ${mongoResult.deleted} đơn đã đóng (hủy/hoàn>${cancelReturnDays}d / hoàn tất-ĐVVC>${closedDays}d).`
      : `Không có đơn đã đóng quá hạn để xóa (${cancelReturnDays}/${closedDays} ngày).`;

  console.log(`[Orders Retention] ${message}`);
  return {
    deleted: mongoResult.deleted,
    jsonRemoved,
    sns: mongoResult.sns,
    scanned: mongoResult.scanned,
    dryRun,
    cancelReturnMatched: mongoResult.cancelReturnMatched,
    closedMatched: mongoResult.closedMatched,
    message,
  };
}

/** TẮT — không setInterval retention (process leak cPanel). Xóa thủ công qua API nếu cần. */
export function scheduleClosedOrdersRetentionCleanup() {
  if (closedOrdersRetentionTimer) {
    clearInterval(closedOrdersRetentionTimer);
    closedOrdersRetentionTimer = undefined;
  }
  console.log("[Orders Retention] Scheduler OFF — không chạy nền.");
}

/** TẮT — không setInterval mongo temp cleanup (process leak cPanel). */
export function scheduleMongoTempCollectionsCleanup() {
  if (mongoTempCleanupTimer) {
    clearInterval(mongoTempCleanupTimer);
    mongoTempCleanupTimer = undefined;
  }
  console.log("[Mongo Temp Cleanup] Scheduler OFF — không chạy nền.");
}

export function findOrderRecord(orders, idOrSn) {
  const key = String(idOrSn || "").trim();
  if (!key) return null;
  const idx = rebuildOrderLookupIndex(orders);
  const normalized = normalizeOrderIndexKey(key);
  const stripped = key.replace(/^shopee-/i, "").trim();
  let index = idx.byId.get(normalized) ?? idx.byOrderSn.get(normalized);
  if (index === undefined && stripped && stripped !== key) {
    const strippedNorm = normalizeOrderIndexKey(stripped);
    index = idx.byId.get(strippedNorm) ?? idx.byOrderSn.get(strippedNorm);
  }
  if (index === undefined && !key.toLowerCase().startsWith("shopee-")) {
    index =
      idx.byId.get(normalizeOrderIndexKey(`shopee-${key}`)) ??
      idx.byOrderSn.get(normalizeOrderIndexKey(`shopee-${key}`));
  }
  if (index === undefined) {
    const keyLower = key.toLowerCase();
    const strippedLower = stripped.toLowerCase();
    index = orders.findIndex((o) => {
      const candidates = [
        o?.id,
        o?._id,
        o?.orderSn,
        o?.order_sn,
        o?.id != null ? String(o.id).replace(/^shopee-/i, "") : "",
        o?._id != null ? String(o._id).replace(/^shopee-/i, "") : "",
      ];
      return candidates.some((c) => {
        const s = String(c || "").trim();
        if (!s) return false;
        return (
          s === key ||
          s.toLowerCase() === keyLower ||
          s === stripped ||
          s.toLowerCase() === strippedLower ||
          normalizeOrderIndexKey(s) === normalized
        );
      });
    });
    if (index < 0) index = undefined;
  }
  if (index === undefined) return null;
  return { index, order: orders[index] };
}

export function resolveOrdersFromRequest(orders, orderIds, orderSns) {
  const hits = [];
  const seen = new Set();
  const tryAdd = (idOrSn) => {
    const raw = String(idOrSn || "").trim();
    if (!raw) return;
    const hit = findOrderRecord(orders, raw);
    if (hit && !seen.has(hit.index)) {
      seen.add(hit.index);
      hits.push(hit);
    }
  };
  for (const id of orderIds || []) tryAdd(String(id));
  for (const sn of orderSns || []) tryAdd(String(sn));
  return hits;
}

export function normalizeScanLookupKey(raw) {
  return String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/[\s\-_#./\\|:;,]+/g, "");
}

export async function buildScanLookupKeys(raw) {
  const text = String(raw || "").trim();
  if (!text) return [];
  const keys = new Set();
  const add = (v) => {
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

export function flexibleScanCodeMatch(scanKey, fieldKey) {
  if (!scanKey || !fieldKey) return false;
  if (scanKey === fieldKey) return true;
  if (scanKey.length >= 10 && fieldKey.length >= 10) {
    return fieldKey.endsWith(scanKey) || scanKey.endsWith(fieldKey);
  }
  return false;
}

/** Flexible OR: orderSn OR outbound/return tracking OR packageNumber — index O(1) first, suffix fallback. */
export async function findOrderByScanLookup(orders, raw) {
  const scanKeys = await buildScanLookupKeys(raw);
  if (!scanKeys.length) return null;

  const idx = getOrderLookupIndex(orders);
  for (const sk of scanKeys) {
    for (const map of [
      idx.byTracking,
      idx.byReturnTracking,
      idx.byInternal,
      idx.byOrderSn,
      idx.byPackage,
      idx.byId,
    ]) {
      const hit = map.get(sk);
      if (hit !== undefined) return orders[hit];
    }
  }

  const trackingLike = /^SPX(VN)?|^GHN|^GHTK|^JNT|^JT|^NINJA|^VTP|^VNPOST/.test(
    normalizeScanLookupKey(raw),
  );

  if (trackingLike) {
    for (const order of orders) {
      const trackingKey = order.trackingNumber
        ? normalizeScanLookupKey(order.trackingNumber)
        : "";
      const returnTrackingKey = order.return_tracking_no || order.returnTrackingNumber
        ? normalizeScanLookupKey(order.return_tracking_no || order.returnTrackingNumber)
        : "";
      const internalKey = order.internalTrackingCode
        ? normalizeScanLookupKey(order.internalTrackingCode)
        : "";
      if (trackingKey && scanKeys.some((sk) => flexibleScanCodeMatch(sk, trackingKey)))
        return order;
      if (
        returnTrackingKey &&
        scanKeys.some((sk) => flexibleScanCodeMatch(sk, returnTrackingKey))
      )
        return order;
      if (internalKey && scanKeys.some((sk) => flexibleScanCodeMatch(sk, internalKey)))
        return order;
    }
  }

  const internalLike = /^0FG/.test(normalizeScanLookupKey(raw));
  if (internalLike) {
    for (const order of orders) {
      const internalKey = order.internalTrackingCode
        ? normalizeScanLookupKey(order.internalTrackingCode)
        : "";
      if (internalKey && scanKeys.some((sk) => flexibleScanCodeMatch(sk, internalKey)))
        return order;
    }
  }

  for (const order of orders) {
    const orderSnKey = normalizeScanLookupKey(order.orderSn);
    const trackingKey = order.trackingNumber
      ? normalizeScanLookupKey(order.trackingNumber)
      : "";
    const returnTrackingKey = order.return_tracking_no || order.returnTrackingNumber
      ? normalizeScanLookupKey(order.return_tracking_no || order.returnTrackingNumber)
      : "";
    const internalKey = order.internalTrackingCode
      ? normalizeScanLookupKey(order.internalTrackingCode)
      : "";
    const packageKey = order.packageNumber
      ? normalizeScanLookupKey(order.packageNumber)
      : "";
    const idKey = normalizeScanLookupKey(String(order.id || "").replace(/^shopee-/i, ""));

    const matched = scanKeys.some(
      (sk) =>
        flexibleScanCodeMatch(sk, orderSnKey) ||
        flexibleScanCodeMatch(sk, trackingKey) ||
        flexibleScanCodeMatch(sk, returnTrackingKey) ||
        flexibleScanCodeMatch(sk, internalKey) ||
        flexibleScanCodeMatch(sk, packageKey) ||
        flexibleScanCodeMatch(sk, idKey),
    );
    if (matched) return order;
  }
  return null;
}

/**
 * Fast path bàn giao ĐVVC — CHỈ Mongo $set is_handed_over.
 * Không load toàn bộ orders, không saveOrders JSON full, không gọi Shopee/catalog.
 */
export async function handOverOrderToCarrierFast(opts = {}) {
  const code = String(opts.code || opts.trackingHint || "").trim();
  let sn = String(opts.orderSn || "")
    .replace(/^shopee-/i, "")
    .trim();
  if (!sn && opts.orderId) {
    sn = String(opts.orderId || "")
      .replace(/^shopee-/i, "")
      .trim();
  }

  let shopId =
    opts.shopId != null && String(opts.shopId).trim()
      ? String(opts.shopId).trim()
      : undefined;
  let found = null;

  if (!sn && code) {
    if (!isMongoReady()) {
      return { ok: false, status: 503, error: "mongodb_not_ready" };
    }
    found = await findOrderByScanCodeInStore(code);
    if (!found) {
      return {
        ok: false,
        status: 404,
        error: `Không tìm thấy đơn hàng với mã "${code}".`,
      };
    }
    sn = String(found.orderSn || found.order_sn || "")
      .replace(/^shopee-/i, "")
      .trim();
    if (!shopId && found.shopId != null) shopId = String(found.shopId);
  }

  if (!sn) {
    return {
      ok: false,
      status: 400,
      error: "Thiếu orderSn / orderId / mã quét.",
    };
  }

  if (found && deps.hasLeftHandedOverCarrierTab(found)) {
    return {
      ok: false,
      status: 400,
      error: `Đơn ${sn} đã Đang giao/hoàn tất/hủy — không ghi Đã giao ĐVVC.`,
    };
  }

  if (found && deps.resolveOrderHandoverFlag(found)) {
    return { ok: true, order: found, changed: false };
  }

  const source =
    opts.source === "qr_scan"
      ? deps.HANDED_OVER_SOURCE.QR_SCAN
      : deps.HANDED_OVER_SOURCE.MANUAL_BUTTON;
  const now = new Date().toISOString();

  if (!isMongoReady()) {
    return { ok: false, status: 503, error: "mongodb_not_ready" };
  }

  const ok = await markOrderHandedOverInStore(sn, {
    source,
    handedOverAt: now,
    shopId,
  });
  if (!ok) {
    return {
      ok: false,
      status: 500,
      error: `Không ghi được cờ bàn giao ĐVVC cho đơn ${sn}.`,
    };
  }

  // Mirror JSON legacy ngầm — không block response.
  queueOrdersJsonMirrorFromMongo();

  const base = found && typeof found === "object" ? { ...found } : {
    id: `shopee-${sn}`,
    orderSn: sn,
    shopId,
  };
  if (code && !deps.isShopeeInternalTrackingCode(code)) {
    if (!base.trackingNumber) base.trackingNumber = code;
    if (!base.tracking_no) base.tracking_no = code;
  }
  const updated = deps.applyHandedOverWrite(base, now, source);
  console.log(
    `[Orders Handover Fast] đơn ${sn} → is_handed_over=true source=${source} (${ok ? "mongo_ok" : "mongo_fail"})`,
  );
  return { ok: true, order: updated, changed: true };
}

export async function handOverOrderToCarrierByIndex(orders, index, opts) {
  if (index < 0) {
    return { ok: false, status: 404, error: "Không tìm thấy đơn hàng." };
  }
  const order = orders[index];

  const hint = String(opts?.trackingHint || "").trim();
  if (hint && !deps.isShopeeInternalTrackingCode(hint)) {
    if (!order.trackingNumber) order.trackingNumber = hint;
    if (!order.tracking_no) order.tracking_no = hint;
  }

  if (deps.hasLeftHandedOverCarrierTab(order)) {
    return {
      ok: false,
      status: 400,
      error: `Đơn ${order?.orderSn || order?.id} đã Đang giao/hoàn tất/hủy — không ghi Đã giao ĐVVC.`,
    };
  }

  if (deps.resolveOrderHandoverFlag(order)) {
    return { ok: true, order, changed: false };
  }

  const eligible =
    deps.isEligibleForHandOverShared(order) ||
    (deps.matchesProcessedPickupTabShared(order) && deps.hasOrderTrackingNoShared(order));
  if (!eligible) {
    const detail =
      deps.getHandOverIneligibleReasonShared(order) ||
      `status=${order?.status}, shopee=${order?.shopee_order_status || "-"}, tn=${order?.trackingNumber || order?.tracking_no || "-"}`;
    console.warn(`[Orders Handover] REJECT ${order?.orderSn}: ${detail}`);
    return {
      ok: false,
      status: 400,
      error: `Đơn ${order?.orderSn || order?.id} không đủ điều kiện bàn giao ĐVVC: ${detail}`,
    };
  }

  const source =
    opts?.source === "qr_scan"
      ? deps.HANDED_OVER_SOURCE.QR_SCAN
      : deps.HANDED_OVER_SOURCE.MANUAL_BUTTON;
  const updated = deps.applyHandedOverWrite({ ...order }, undefined, source);
  orders[index] = updated;
  if (opts?.persist !== false) {
    saveOrders(orders);
    try {
      if (isMongoReady()) {
        await markOrderHandedOverInStore(String(updated.orderSn || ""), {
          source,
          handedOverAt: String(updated.handedOverAt || ""),
          shopId: updated.shopId != null ? String(updated.shopId) : undefined,
        });
      }
    } catch (err) {
      console.error("[Orders Handover] Mongo markOrderHandedOver failed:", err?.message || err);
    }
  }
  console.log(
    `[Orders Handover] đơn ${updated.orderSn} → is_handed_over=true source=${source} tn=${updated.trackingNumber || updated.tracking_no || "-"}`,
  );
  return { ok: true, order: updated, changed: true };
}

export function getOrdersDbPath() {
  return ORDERS_DB_PATH;
}
