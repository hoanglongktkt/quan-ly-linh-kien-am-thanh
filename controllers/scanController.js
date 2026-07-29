import DonHoanHuy from "../models/DonHoanHuy.js";
import { isDBReady } from "../config/db.js";

function normalizeOrderSn(raw) {
  return String(raw || "")
    .replace(/^shopee-/i, "")
    .trim();
}

function describeDbError(err) {
  const msg = String(err?.message || err || "");
  if (/quota|space|storage|over.?space/i.test(msg)) {
    return "Quota MongoDB đầy (Atlas Over space quota). Hãy dọn dữ liệu hoặc nâng gói.";
  }
  if (/ECONNREFUSED|ENOTFOUND|ETIMEOUT|serverSelection|connect ETIMEDOUT|MongoNetwork/i.test(msg)) {
    return "Lỗi kết nối MongoDB / mạng. Kiểm tra Atlas và biến MONGODB_URI.";
  }
  if (/duplicate key|E11000/i.test(msg)) {
    return "Trùng mã đơn trong don_hoan_huy (đã lưu trước đó).";
  }
  return msg || "Lỗi Database không xác định.";
}

/**
 * POST /api/scan/save
 * Body: { codes: string[] } | { orderSns: string[] } | { items: [...] }
 */
export async function saveScanOrders(req, res) {
  try {
    if (!isDBReady()) {
      return res.status(500).json({
        success: false,
        message: "MongoDB chưa sẵn sàng — kiểm tra kết nối Atlas.",
      });
    }

    const body = req.body || {};
    const codes = [];

    const pushCode = (v, status, note) => {
      const sn = normalizeOrderSn(v);
      if (!sn) return;
      codes.push({
        orderSn: sn,
        status: status || "scanned",
        note: note || "",
      });
    };

    if (Array.isArray(body.codes)) {
      for (const c of body.codes) {
        if (c && typeof c === "object") {
          pushCode(c.orderSn || c.code || c.orderId, c.status, c.note);
        } else {
          pushCode(c, body.status, body.note);
        }
      }
    }
    if (Array.isArray(body.orderSns)) {
      for (const c of body.orderSns) pushCode(c, body.status, body.note);
    }
    if (Array.isArray(body.items)) {
      for (const it of body.items) {
        const t = String(it?.type || it?.status || body.status || "").toLowerCase();
        const status =
          t === "return" || t === "return_received" || t === "da_nhan_hoan"
            ? "return_received"
            : t === "cancelled" || t === "cancel" || t === "don_huy"
              ? "cancelled"
              : it?.status || "scanned";
        pushCode(it?.orderSn || it?.code || it?.orderId, status, it?.note);
      }
    }
    if (Array.isArray(body.donHuyCodes)) {
      for (const c of body.donHuyCodes) pushCode(c, "cancelled", "don_huy");
    }
    if (Array.isArray(body.daNhanHoanCodes)) {
      for (const c of body.daNhanHoanCodes) pushCode(c, "return_received", "da_nhan_hoan");
    }
    if (typeof body.code === "string" || typeof body.orderSn === "string") {
      pushCode(body.orderSn || body.code, body.status, body.note);
    }

    // Deduplicate by orderSn (last wins)
    const bySn = new Map();
    for (const row of codes) bySn.set(row.orderSn, row);
    const unique = [...bySn.values()];

    if (!unique.length) {
      return res.status(400).json({
        success: false,
        message: "Thiếu mảng mã đơn (codes / orderSns / items).",
      });
    }

    const now = new Date();
    const ops = unique.map((row) => ({
      updateOne: {
        filter: { orderSn: row.orderSn },
        update: {
          $set: {
            orderSn: row.orderSn,
            status: row.status,
            scannedAt: now,
            note: row.note || "",
            local_status:
              row.status === "return_received" ? "RETURN_RECEIVED" : "CANCELLED_STORED",
            type: row.status === "return_received" ? "return" : "cancelled",
            source: "api_scan_save",
          },
          $setOnInsert: {
            createdAt: now,
          },
        },
        upsert: true,
      },
    }));

    const result = await DonHoanHuy.bulkWrite(ops, { ordered: false });

    return res.json({
      success: true,
      message: `Đã lưu ${unique.length} đơn vào don_hoan_huy.`,
      saved: unique.length,
      upserted: result.upsertedCount || 0,
      modified: result.modifiedCount || 0,
      matched: result.matchedCount || 0,
      donHoanHuy: {
        ok: unique.length,
        failed: 0,
        already: 0,
        ensured: unique.length,
        errors: [],
      },
      orderSns: unique.map((r) => r.orderSn),
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
 * Truy vấn collection don_hoan_huy, sort scannedAt desc.
 */
export async function listDonHoanHuy(req, res) {
  try {
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

    const docs = await DonHoanHuy.find({})
      .sort({ scannedAt: -1 })
      .limit(limit)
      .maxTimeMS(5000)
      .lean();

    const data = (docs || []).map((doc) => {
      const sn = normalizeOrderSn(doc.orderSn);
      const status = String(doc.status || "scanned");
      const local =
        doc.local_status ||
        (status === "return_received" ? "RETURN_RECEIVED" : "CANCELLED_STORED");
      return {
        id: doc._id || `dhh-${sn}`,
        orderSn: sn,
        status,
        note: doc.note || "",
        scannedAt: doc.scannedAt || null,
        local_status: local,
        localStatus: local,
        internal_status: local,
        don_hoan_huy: true,
        type: doc.type || (status === "return_received" ? "return" : "cancelled"),
        shopId: doc.shopId || null,
        shopName: doc.shopName || null,
        tracking_no: doc.tracking_no || null,
        channel: "shopee",
        ...(doc.data && typeof doc.data === "object" ? doc.data : {}),
      };
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
