import DonHoanHuy from "../models/DonHoanHuy.js";
import { connectDB, isDBReady, getMongoUri } from "../config/db.js";
import {
  loadDonHoanHuyAsOrders,
  upsertDonHoanHuyBatch,
} from "../src/db/mongoStore.ts";

/** Deps từ server.ts — resolve đơn thật (orderSn + items) trước khi ghi don_hoan_huy. */
let deps = {
  findOrderByScanCodeInStore: async () => null,
  findOrdersByScanCodesInStore: async () => new Map(),
  resolveOrderFromShopeeByScanCode: async () => null,
  isValidOrder: () => false,
  mirrorTrackingFieldsForRead: (o) => o,
};

export function initScanController(partial) {
  deps = { ...deps, ...partial };
}

function normalizeOrderSn(raw) {
  return String(raw || "")
    .replace(/^shopee-/i, "")
    .trim();
}

/** Mã vận đơn carrier — tuyệt đối không dùng làm orderSn. */
function isCarrierTrackingCode(code) {
  const c = String(code || "").trim();
  if (!c) return false;
  return /^(SPX(VN)?|GHN|GYA|GHTK|JNT|JT|NINJA|VTP|VNPOST|BEST|LEX|SHOPEE\s*X)/i.test(c);
}

function describeDbError(err) {
  const msg = String(err?.message || err || "");
  if (/quota|space|storage|over.?space/i.test(msg)) {
    return "Quota MongoDB đầy (Atlas Over space quota). Hãy dọn dữ liệu hoặc nâng gói.";
  }
  if (
    /ECONNREFUSED|ENOTFOUND|ETIMEOUT|ETIMEDOUT|serverSelection|connect ETIMEDOUT|MongoNetwork|Thiếu MONGODB|timed out|timeout|27017|connection \d+ to /i.test(
      msg,
    )
  ) {
    return "Lỗi kết nối MongoDB / mạng (timeout tới DB). Kiểm tra IP whitelist, firewall và biến MONGODB_URI.";
  }
  if (/duplicate key|E11000/i.test(msg)) {
    return "Trùng mã đơn trong don_hoan_huy (đã lưu trước đó).";
  }
  return msg || "Lỗi Database không xác định.";
}

async function ensureDbConnected() {
  if (isDBReady()) return true;
  if (!getMongoUri()) {
    throw new Error("Thiếu MONGODB_URI / MONGO_URL trong biến môi trường.");
  }
  await connectDB();
  return isDBReady();
}

function orderHasItems(order) {
  return Array.isArray(order?.items) && order.items.length > 0;
}

/**
 * Local Mongo exact match only. Không gọi Shopee trên luồng quét.
 */
async function resolveFullOrderForScan(rawCode) {
  const code = String(rawCode || "").trim().toUpperCase();
  if (!code) return null;

  let found = null;
  try {
    found = await deps.findOrderByScanCodeInStore(code);
    if (found && !deps.isValidOrder(found)) found = null;
    if (found) found = deps.mirrorTrackingFieldsForRead(found);
  } catch (err) {
    console.warn(`[Scan Save] local lookup fail code=${code}:`, err?.message || err);
  }

  if (!found) return null;
  const sn = normalizeOrderSn(found.orderSn);
  if (!sn || isCarrierTrackingCode(sn)) return null;
  return found;
}

/**
 * POST /api/scan/save
 * Body: { codes: string[] } | { orderSns: string[] } | { items: [...] }
 * Mỗi mã phải resolve ra đơn Shopee thật (orderSn + items) — không tạo đơn giả từ mã VĐ.
 */
export async function saveScanOrders(req, res) {
  try {
    try {
      await ensureDbConnected();
    } catch (dbErr) {
      console.error("[POST /api/scan/save] DB connect:", dbErr);
      return res.status(500).json({
        success: false,
        message: describeDbError(dbErr),
      });
    }

    if (!isDBReady()) {
      return res.status(500).json({
        success: false,
        message: "MongoDB chưa sẵn sàng — kiểm tra kết nối Atlas.",
      });
    }

    const body = req.body || {};
    /** @type {Array<{ code: string, kind: 'cancel'|'return' }>} */
    const jobs = [];

    const pushJob = (raw, kind) => {
      const code = String(raw || "").trim().toUpperCase();
      if (!code) return;
      jobs.push({ code, kind: kind === "return" ? "return" : "cancel" });
    };

    const inferKind = (statusOrType) => {
      const t = String(statusOrType || "").toLowerCase();
      if (
        t === "return" ||
        t === "return_received" ||
        t === "da_nhan_hoan" ||
        t === "return_pending"
      ) {
        return "return";
      }
      return "cancel";
    };

    if (Array.isArray(body.codes)) {
      for (const c of body.codes) {
        if (c && typeof c === "object") {
          pushJob(
            c.orderSn || c.code || c.orderId,
            inferKind(c.status || c.type || body.status),
          );
        } else {
          pushJob(c, inferKind(body.status));
        }
      }
    }
    if (Array.isArray(body.orderSns)) {
      for (const c of body.orderSns) pushJob(c, inferKind(body.status));
    }
    if (Array.isArray(body.items)) {
      for (const it of body.items) {
        pushJob(it?.orderSn || it?.code || it?.orderId, inferKind(it?.type || it?.status || body.status));
      }
    }
    if (Array.isArray(body.donHuyCodes)) {
      for (const c of body.donHuyCodes) pushJob(c, "cancel");
    }
    if (Array.isArray(body.daNhanHoanCodes)) {
      for (const c of body.daNhanHoanCodes) pushJob(c, "return");
    }
    if (typeof body.code === "string" || typeof body.orderSn === "string") {
      pushJob(body.orderSn || body.code, inferKind(body.status));
    }

    // Deduplicate by code (last kind wins)
    const byCode = new Map();
    for (const job of jobs) byCode.set(job.code, job);
    const unique = [...byCode.values()];

    if (!unique.length) {
      return res.status(400).json({
        success: false,
        message: "Thiếu mảng mã đơn (codes / orderSns / items).",
      });
    }

    const saved = [];
    const failed = [];
    const orderSns = [];
    /** Lookup Mongo 1 lần `$in` — ghi DB 1 lần bulkWrite. Không gọi Shopee. */
    const toUpsert = [];

    const uniqueCodes = unique.map((j) => j.code);
    let foundByCode = new Map();
    try {
      if (typeof deps.findOrdersByScanCodesInStore === "function") {
        foundByCode = await deps.findOrdersByScanCodesInStore(uniqueCodes);
      }
    } catch (batchErr) {
      console.warn(
        "[Scan Save] batch lookup fail:",
        batchErr?.message || batchErr,
      );
    }

    for (const job of unique) {
      let order = foundByCode.get(job.code) || null;
      if (order && !deps.isValidOrder(order)) order = null;
      if (order) order = deps.mirrorTrackingFieldsForRead(order);
      if (!order) {
        failed.push({
          code: job.code,
          reason:
            "Không tìm thấy đơn Shopee khớp mã (thiếu order_sn/items). Không lưu đơn giả.",
        });
        continue;
      }
      if (!orderHasItems(order)) {
        failed.push({
          code: job.code,
          orderSn: order.orderSn,
          reason: `Đơn #${order.orderSn} thiếu danh sách sản phẩm — không lưu.`,
        });
        continue;
      }
      toUpsert.push({
        order,
        type: job.kind === "return" ? "return" : "cancelled",
        scanCode: job.code,
        source: "api_scan_save",
      });
    }

    if (toUpsert.length > 0) {
      const batch = await upsertDonHoanHuyBatch(toUpsert);
      if (batch.ok > 0) {
        for (const row of toUpsert) {
          const sn = normalizeOrderSn(row.order?.orderSn);
          if (sn) {
            saved.push(sn);
            orderSns.push(sn);
          }
        }
        for (const e of batch.errors || []) {
          failed.push({ code: "?", reason: e });
        }
      } else {
        for (const row of toUpsert) {
          failed.push({
            code: row.scanCode,
            orderSn: row.order?.orderSn,
            reason: batch.errors?.[0] || "Ghi don_hoan_huy thất bại",
          });
        }
      }
    }

    if (saved.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy mã trên hệ thống",
        notFound: true,
        saved: 0,
        failed: failed.length,
        errors: failed.slice(0, 20),
        donHoanHuy: { ok: 0, failed: failed.length, already: 0, ensured: 0, errors: failed.map((f) => f.reason) },
      });
    }

    return res.json({
      success: true,
      message: `Đã lưu ${saved.length} đơn vào don_hoan_huy` +
        (failed.length ? ` (${failed.length} mã lỗi)` : "") +
        ".",
      saved: saved.length,
      failed: failed.length,
      errors: failed.slice(0, 20),
      upserted: saved.length,
      modified: 0,
      matched: 0,
      donHoanHuy: {
        ok: saved.length,
        failed: failed.length,
        already: 0,
        ensured: saved.length,
        errors: failed.map((f) => f.reason).slice(0, 10),
      },
      orderSns,
    });
  } catch (err) {
    console.error("[POST /api/scan/save]", err);
    return res.status(500).json({
      success: false,
      message: describeDbError(err),
    });
  }
}

/**
 * GET /api/scan/don-hoan-huy
 * Dùng cùng mapper với tab orders (orderSn thật + items từ data).
 */
export async function listDonHoanHuy(req, res) {
  try {
    try {
      await ensureDbConnected();
    } catch (dbErr) {
      console.error("[GET /api/scan/don-hoan-huy] DB connect:", dbErr);
      return res.status(500).json({
        success: false,
        message: describeDbError(dbErr),
        data: [],
      });
    }

    if (!isDBReady()) {
      return res.status(500).json({
        success: false,
        message: "MongoDB chưa sẵn sàng — kiểm tra kết nối Atlas.",
        data: [],
      });
    }

    const limitRaw = Number(req.query.limit);
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(Math.floor(limitRaw), 5000)
        : 2000;

    let data = [];
    try {
      data = await loadDonHoanHuyAsOrders(limit);
    } catch (loadErr) {
      // Fallback lean map nếu mongoStore chưa sẵn sàng trong môi trường serverless.
      console.warn("[GET /api/scan/don-hoan-huy] loadDonHoanHuyAsOrders:", loadErr?.message || loadErr);
      const docs = await DonHoanHuy.find({})
        .sort({ scannedAt: -1 })
        .limit(limit)
        .maxTimeMS(5000)
        .lean();
      data = (docs || []).map((doc) => {
        const base = doc.data && typeof doc.data === "object" ? { ...doc.data } : {};
        let sn = normalizeOrderSn(doc.orderSn);
        const dataSn = normalizeOrderSn(base.orderSn || base.order_sn);
        if (isCarrierTrackingCode(sn) && dataSn && !isCarrierTrackingCode(dataSn)) {
          sn = dataSn;
        }
        const status = String(doc.status || "scanned");
        const local =
          doc.local_status ||
          (status === "return_received" ? "RETURN_RECEIVED" : "CANCELLED_STORED");
        return {
          ...base,
          id: base.id || `shopee-${sn}`,
          orderSn: sn,
          status,
          note: doc.note || "",
          scannedAt: doc.scannedAt || null,
          local_status: local,
          localStatus: local,
          internal_status: local,
          don_hoan_huy: true,
          type: doc.type || (status === "return_received" ? "return" : "cancelled"),
          shopId: doc.shopId || base.shopId || null,
          shopName: doc.shopName || base.shopName || null,
          tracking_no: doc.tracking_no || base.tracking_no || null,
          trackingNumber: doc.tracking_no || base.trackingNumber || base.tracking_no || null,
          items: Array.isArray(base.items) ? base.items : [],
          channel: base.channel || "shopee",
        };
      });
    }

    // Lọc bỏ bản ghi giả (orderSn = mã VĐ, không có items) khỏi UI.
    data = data.filter((o) => {
      const sn = normalizeOrderSn(o?.orderSn);
      if (!sn || isCarrierTrackingCode(sn)) return false;
      return true;
    });

    return res.json({
      success: true,
      data,
      total: data.length,
    });
  } catch (err) {
    console.error("[GET /api/scan/don-hoan-huy]", err);
    return res.status(500).json({
      success: false,
      message: describeDbError(err),
      data: [],
    });
  }
}
