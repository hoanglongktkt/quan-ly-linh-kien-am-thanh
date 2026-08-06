/**
 * POST /api/orders/scan-bulk-update
 * Phase 3 — tách nguyên khối từ server.ts (không đổi logic).
 */

/** Deps từ server.ts (order helpers / mongoStore chưa tách hết). */
let deps = {
  findOrderByScanCodeInStore: async () => null,
  findOrdersByScanCodesInStore: async () => new Map(),
  resolveOrderFromShopeeByScanCode: async () => null,
  isValidOrder: () => false,
  mirrorTrackingFieldsForRead: (o) => o,
  resolveOrderLocalStatus: () => "",
  existsDonHoanHuy: async () => false,
  existsDonHoanHuyMany: async () => new Set(),
  isShopeeCancelOrReturnLikeOrder: () => false,
  isOrderAlreadyScanProcessed: () => false,
  getScanProcessedReason: () => "",
  handOverOrderToCarrierByIndex: async () => ({ ok: false, error: "not_initialized" }),
  clearHandedOverLocalForCancelReturn: () => {},
  setOrderLocalStatus: () => {},
  ORDER_LOCAL_STATUS: { HANDED_OVER: "HANDED_OVER" },
  isEligibleForHandOverShared: () => false,
  isMongoReady: () => false,
  upsertDonHoanHuyBatch: async () => ({ ok: 0, failed: 0, errors: ["not_initialized"] }),
  markOrdersScanFlagsBatch: async () => 0,
  describeMongoWriteError: (err) => String(err?.message || err || ""),
  isMongoConnectionError: () => false,
  persistChangedOrdersPatch: async () => 0,
  markOrderHandedOverInStore: async () => false,
  markOrderLocalStatusInStore: async () => false,
  restoreLocalStockOnCancelReturnScan: async () => ({ restored: false }),
  loadProductsForOrders: async () => [],
  enrichOrdersFromCatalog: (orders) => orders,
  invalidateOrdersRefreshCache: () => {},
};

export function initScanBulkController(partial) {
  deps = { ...deps, ...partial };
}

/** POST /api/orders/scan-bulk-update */
export async function scanBulkUpdate(req, res) {
  try {
    const rawCodes = Array.isArray(req.body?.codes)
      ? req.body.codes
      : Array.isArray(req.body?.scannedCodes)
        ? req.body.scannedCodes
        : Array.isArray(req.body?.scanCodes)
          ? req.body.scanCodes
          : [];
    const codes = [...new Set(rawCodes.map((c) => String(c || "").trim()).filter(Boolean))];
    if (!codes.length) {
      return res.status(400).json({
        success: false,
        error: "Thiếu danh sách mã quét (codes).",
        message: "Thiếu danh sách mã quét (codes / scannedCodes).",
      });
    }

    const toCodeSet = (arr) => {
      if (!Array.isArray(arr)) return new Set();
      return new Set(arr.map((c) => String(c || "").trim().toUpperCase()).filter(Boolean));
    };
    const forceHandOverCodes = toCodeSet(req.body?.daXuatKhoCodes);
    const forceCancelCodes = toCodeSet(req.body?.donHuyCodes);
    const forceReturnCodes = toCodeSet(req.body?.daNhanHoanCodes);

    // Lookup theo mã quét — 1 query Mongo indexed ($in), miss → Shopee on-demand.
    let foundByCode = new Map();
    try {
      foundByCode = await deps.findOrdersByScanCodesInStore(codes);
    } catch (batchLookupErr) {
      console.warn(
        "[Orders Scan Bulk] batch lookup fail — fallback per-code:",
        batchLookupErr?.message || batchLookupErr,
      );
    }

    const lookupPairs = await Promise.all(
      codes.map(async (code) => {
        let found = foundByCode.get(code) || null;
        try {
          if (!found) {
            found = await deps.findOrderByScanCodeInStore(code);
          }
          if (found && !deps.isValidOrder(found)) found = null;
          if (found) found = deps.mirrorTrackingFieldsForRead(found);
        } catch (lookupErr) {
          console.warn(
            `[Orders Scan Bulk] lookup miss code=${code}:`,
            lookupErr?.message || lookupErr,
          );
        }
        const sn = String(found?.orderSn || "").replace(/^shopee-/i, "").trim();
        const looksLikeTn = /^(SPX(VN)?|GHN|GYA|GHTK|JNT|JT|NINJA|VTP|VNPOST|BEST|LEX)/i.test(sn);
        const missingItems = !Array.isArray(found?.items) || found.items.length === 0;
        if (!found || looksLikeTn || missingItems) {
          try {
            const fromShopee = await deps.resolveOrderFromShopeeByScanCode(code);
            if (fromShopee && deps.isValidOrder(fromShopee)) {
              const mirrored = deps.mirrorTrackingFieldsForRead(fromShopee);
              if (!found) {
                found = mirrored;
              } else {
                found = {
                  ...found,
                  ...mirrored,
                  items:
                    Array.isArray(mirrored?.items) && mirrored.items.length
                      ? mirrored.items
                      : found.items,
                  orderSn: String(mirrored?.orderSn || found.orderSn || "")
                    .replace(/^shopee-/i, "")
                    .trim(),
                };
              }
            }
          } catch (shopeeErr) {
            console.warn(
              `[Orders Scan Bulk] Shopee resolve code=${code}:`,
              shopeeErr?.message || shopeeErr,
            );
          }
        }
        // Chặn đơn giả: orderSn = mã VĐ hoặc thiếu items khi ghi hủy/hoàn.
        if (found) {
          const finalSn = String(found.orderSn || "").replace(/^shopee-/i, "").trim();
          if (
            !finalSn ||
            /^(SPX(VN)?|GHN|GYA|GHTK|JNT|JT|NINJA|VTP|VNPOST|BEST|LEX)/i.test(finalSn)
          ) {
            found = null;
          }
        }
        return { code, found };
      }),
    );

    const orders = [];
    const orderIndexById = new Map();
    const putScoped = (order) => {
      if (!order?.id) return -1;
      const existing = orderIndexById.get(String(order.id));
      if (existing !== undefined) return existing;
      const idx = orders.length;
      orders.push(order);
      orderIndexById.set(String(order.id), idx);
      return idx;
    };
    for (const pair of lookupPairs) {
      if (pair.found) putScoped(pair.found);
    }

    const results = [];
    const failed_scans = [];
    const changedOrders = [];
    const updatedById = new Map();
    /** Chỉ đếm record THỰC SỰ vừa UPDATE thành công trong DB. */
    const summary = { daXuatKho: 0, donHuy: 0, daNhanHoan: 0 };
    /** Số đơn hủy/hoàn đã có sẵn trong don_hoan_huy (idempotent). */
    let donHoanHuyAlready = 0;

    const norm = (c) => String(c || "").trim().toUpperCase();

    // Prefetch exists don_hoan_huy — 1 query $in thay vì N findOne.
    const snsForExists = [
      ...new Set(
        lookupPairs
          .map((p) => String(p.found?.orderSn || "").replace(/^shopee-/i, "").trim())
          .filter(Boolean),
      ),
    ];
    let alreadyInDonHoanHuySet = new Set();
    try {
      alreadyInDonHoanHuySet = await deps.existsDonHoanHuyMany(snsForExists);
    } catch {
      alreadyInDonHoanHuySet = new Set();
    }

    for (const { code, found } of lookupPairs) {
      const codeKey = norm(code);
      if (!found) {
        results.push({ code, action: "not_found", message: `Không tìm thấy đơn với mã "${code}"` });
        failed_scans.push({ code, reason: "Không tìm thấy đơn trong hệ thống" });
        continue;
      }

      const index = putScoped(found);
      if (index < 0) {
        results.push({ code, action: "not_found", message: `Không tìm thấy đơn với mã "${code}"` });
        failed_scans.push({ code, reason: "Không tìm thấy đơn trong hệ thống" });
        continue;
      }

      const order = orders[index];
      const status = String(order.status || "");
      const rawShopee = String(order.shopee_order_status || "").toUpperCase();
      const existingLocal = deps.resolveOrderLocalStatus(order);
      const orderSnNorm = String(order.orderSn || "").replace(/^shopee-/i, "").trim();
      const alreadyInDonHoanHuy = alreadyInDonHoanHuySet.has(orderSnNorm);
      const forceHandOver =
        forceHandOverCodes.has(codeKey) ||
        forceHandOverCodes.has(norm(String(order.orderSn || ""))) ||
        forceHandOverCodes.has(norm(String(order.trackingNumber || order.tracking_no || "")));
      const forceCancel =
        forceCancelCodes.has(codeKey) ||
        forceCancelCodes.has(norm(String(order.orderSn || ""))) ||
        forceCancelCodes.has(norm(String(order.trackingNumber || order.tracking_no || ""))) ||
        forceCancelCodes.has(norm(String(order.return_tracking_no || "")));
      const forceReturn =
        forceReturnCodes.has(codeKey) ||
        forceReturnCodes.has(norm(String(order.orderSn || ""))) ||
        forceReturnCodes.has(norm(String(order.trackingNumber || order.tracking_no || ""))) ||
        forceReturnCodes.has(norm(String(order.return_tracking_no || "")));
      const isReturnLike =
        status === "return_pending" ||
        status === "return_received" ||
        rawShopee === "TO_RETURN";
      const isCancelLike =
        !isReturnLike &&
        (status === "cancelled" ||
          rawShopee === "CANCELLED" ||
          rawShopee === "IN_CANCEL" ||
          deps.isShopeeCancelOrReturnLikeOrder(order));

      // Idempotent CHỈ khi đã có bản ghi thật trong don_hoan_huy.
      // KHÔNG dùng existingLocal (status cancelled/return_received trên sàn) — gây bỏ qua ghi DB.
      if (forceCancel && alreadyInDonHoanHuy) {
        summary.donHuy += 1;
        donHoanHuyAlready += 1;
        results.push({
          code,
          action: "cancelled",
          orderId: order.id,
          orderSn: order.orderSn,
          message: `Đơn hủy #${order.orderSn} đã có trong don_hoan_huy`,
          local_status: "CANCELLED_STORED",
        });
        continue;
      }
      if (forceReturn && alreadyInDonHoanHuy) {
        summary.daNhanHoan += 1;
        donHoanHuyAlready += 1;
        results.push({
          code,
          action: "return_received",
          orderId: order.id,
          orderSn: order.orderSn,
          message: `Đơn #${order.orderSn} đã có trong don_hoan_huy`,
          local_status: "RETURN_RECEIVED",
        });
        continue;
      }
      const allowForceCancelReturnOverride =
        (forceCancel || forceReturn) &&
        (existingLocal === "HANDED_OVER" ||
          existingLocal === "CANCELLED_STORED" ||
          existingLocal === "RETURN_RECEIVED" ||
          isCancelLike ||
          isReturnLike);
      // Đã xử lý ĐVVC thuần — chặn; còn force hủy/hoàn thì vẫn ghi don_hoan_huy.
      if (
        deps.isOrderAlreadyScanProcessed(order) &&
        !allowForceCancelReturnOverride &&
        !forceCancel &&
        !forceReturn
      ) {
        const reason = deps.getScanProcessedReason(order);
        results.push({
          code,
          action: "duplicate",
          orderId: order.id,
          orderSn: order.orderSn,
          message: reason,
          local_status: existingLocal,
        });
        failed_scans.push({
          code,
          orderId: order.id,
          orderSn: order.orderSn,
          reason,
        });
        continue;
      }

      // FE phân loại xuất kho (chỉ Chờ lấy hàng đã xử lý) → WRITE HANDED_OVER.
      if (forceHandOver) {
        const result = await deps.handOverOrderToCarrierByIndex(orders, index, {
          persist: false,
          source: "qr_scan",
        });
        if (!result.ok) {
          results.push({
            code,
            action: "rejected",
            orderId: order.id,
            orderSn: order.orderSn,
            message: result.error,
            local_status: existingLocal,
          });
          failed_scans.push({
            code,
            orderId: order.id,
            orderSn: order.orderSn,
            reason: result.error,
          });
          continue;
        }
        if (result.changed) {
          changedOrders.push(result.order);
          updatedById.set(result.order.id, result.order);
          summary.daXuatKho += 1;
        }
        results.push({
          code,
          action: "handed_over",
          orderId: result.order.id,
          orderSn: result.order.orderSn,
          message: result.changed
            ? `Đã bàn giao ĐVVC — đơn #${result.order.orderSn}`
            : `Đơn #${result.order.orderSn} đã có cờ ĐVVC`,
          local_status: deps.ORDER_LOCAL_STATUS.HANDED_OVER,
        });
        continue;
      }

      // FE / raw Shopee: nhận hoàn (kể cả sau HANDED_OVER).
      if (forceReturn || isReturnLike) {
        const finalSn = String(order.orderSn || "").replace(/^shopee-/i, "").trim();
        if (
          !finalSn ||
          /^(SPX(VN)?|GHN|GYA|GHTK|JNT|JT|NINJA|VTP|VNPOST|BEST|LEX)/i.test(finalSn)
        ) {
          results.push({
            code,
            action: "not_found",
            message: `Mã "${code}" chưa resolve được order_sn Shopee — không lưu đơn giả.`,
          });
          failed_scans.push({
            code,
            reason: "Thiếu order_sn thật sau khi gọi Shopee",
          });
          continue;
        }
        if (!Array.isArray(order.items) || order.items.length === 0) {
          results.push({
            code,
            action: "rejected",
            orderId: order.id,
            orderSn: order.orderSn,
            message: `Đơn #${order.orderSn} thiếu danh sách sản phẩm — không lưu.`,
          });
          failed_scans.push({
            code,
            orderSn: order.orderSn,
            reason: "Thiếu items",
          });
          continue;
        }
        const wasHandedOver =
          existingLocal === "HANDED_OVER" ||
          order.is_handed_over === true ||
          order.isHandedOverToCarrier === true;
        const updated = { ...order };
        deps.clearHandedOverLocalForCancelReturn(updated);
        deps.setOrderLocalStatus(updated, "RETURN_RECEIVED");
        try {
          const restock = await deps.restoreLocalStockOnCancelReturnScan(updated, {
            wasHandedOver,
          });
          if (restock?.restored) {
            console.log(
              `[Orders Scan Bulk] Restock +${restock.qty || 0} order_sn=${updated.orderSn}`,
            );
          }
        } catch (restockErr) {
          console.warn(
            `[Orders Scan Bulk] Restock fail order_sn=${updated.orderSn}:`,
            restockErr?.message || restockErr,
          );
        }
        orders[index] = updated;
        changedOrders.push(updated);
        updatedById.set(updated.id, updated);
        summary.daNhanHoan += 1;
        results.push({
          code,
          action: "return_received",
          orderId: updated.id,
          orderSn: updated.orderSn,
          message: `Đã nhận hàng hoàn — đơn #${updated.orderSn}`,
          local_status: "RETURN_RECEIVED",
          stock_restored: Boolean(updated.stock_restored),
        });
        continue;
      }

      // FE / raw Shopee: đơn hủy (CANCELLED / IN_CANCEL), kể cả sau HANDED_OVER.
      if (forceCancel || isCancelLike) {
        const finalSn = String(order.orderSn || "").replace(/^shopee-/i, "").trim();
        if (
          !finalSn ||
          /^(SPX(VN)?|GHN|GYA|GHTK|JNT|JT|NINJA|VTP|VNPOST|BEST|LEX)/i.test(finalSn)
        ) {
          results.push({
            code,
            action: "not_found",
            message: `Mã "${code}" chưa resolve được order_sn Shopee — không lưu đơn giả.`,
          });
          failed_scans.push({
            code,
            reason: "Thiếu order_sn thật sau khi gọi Shopee",
          });
          continue;
        }
        if (!Array.isArray(order.items) || order.items.length === 0) {
          results.push({
            code,
            action: "rejected",
            orderId: order.id,
            orderSn: order.orderSn,
            message: `Đơn #${order.orderSn} thiếu danh sách sản phẩm — không lưu.`,
          });
          failed_scans.push({
            code,
            orderSn: order.orderSn,
            reason: "Thiếu items",
          });
          continue;
        }
        const wasHandedOver =
          existingLocal === "HANDED_OVER" ||
          order.is_handed_over === true ||
          order.isHandedOverToCarrier === true;
        const updated = { ...order };
        if (updated.status !== "cancelled") updated.status = "cancelled";
        deps.clearHandedOverLocalForCancelReturn(updated);
        deps.setOrderLocalStatus(updated, "CANCELLED_STORED");
        try {
          const restock = await deps.restoreLocalStockOnCancelReturnScan(updated, {
            wasHandedOver,
          });
          if (restock?.restored) {
            console.log(
              `[Orders Scan Bulk] Restock +${restock.qty || 0} order_sn=${updated.orderSn}`,
            );
          }
        } catch (restockErr) {
          console.warn(
            `[Orders Scan Bulk] Restock fail order_sn=${updated.orderSn}:`,
            restockErr?.message || restockErr,
          );
        }
        orders[index] = updated;
        changedOrders.push(updated);
        updatedById.set(updated.id, updated);
        summary.donHuy += 1;
        results.push({
          code,
          action: "cancelled",
          orderId: updated.id,
          orderSn: updated.orderSn,
          message: `Đơn hủy #${updated.orderSn} → CANCELLED_STORED`,
          local_status: "CANCELLED_STORED",
          stock_restored: Boolean(updated.stock_restored),
        });
        continue;
      }

      // Không có phân loại FE: chỉ bàn giao nếu đúng Chờ lấy hàng (đã xử lý).
      if (deps.isEligibleForHandOverShared(order)) {
        const result = await deps.handOverOrderToCarrierByIndex(orders, index, {
          persist: false,
          source: "qr_scan",
        });
        if (!result.ok) {
          results.push({
            code,
            action: "rejected",
            orderId: order.id,
            orderSn: order.orderSn,
            message: result.error,
            local_status: existingLocal,
          });
          failed_scans.push({
            code,
            orderId: order.id,
            orderSn: order.orderSn,
            reason: result.error,
          });
          continue;
        }
        if (result.changed) {
          changedOrders.push(result.order);
          updatedById.set(result.order.id, result.order);
          summary.daXuatKho += 1;
        }
        results.push({
          code,
          action: "handed_over",
          orderId: result.order.id,
          orderSn: result.order.orderSn,
          message: `Đã bàn giao ĐVVC — đơn #${result.order.orderSn}`,
          local_status: deps.ORDER_LOCAL_STATUS.HANDED_OVER,
        });
        continue;
      }

      results.push({
        code,
        action: "skipped",
        orderId: order.id,
        orderSn: order.orderSn,
        message: `Đơn #${order.orderSn} không thuộc Chờ lấy hàng (đã xử lý) / Đơn hủy — bỏ qua`,
      });
      failed_scans.push({
        code,
        orderId: order.id,
        orderSn: order.orderSn,
        reason: `Trạng thái "${status}" không thuộc quy tắc quét ĐVVC`,
      });
    }

    // Persist: hủy/hoàn → collection don_hoan_huy (SSOT tab);
    // xuất kho → markOrderHandedOver. Không phụ thuộc order_events.
    const scanCodeByOrderSn = new Map();
    for (const r of results) {
      const sn = String(r?.orderSn || "").replace(/^shopee-/i, "").trim();
      if (sn && r?.code) scanCodeByOrderSn.set(sn, String(r.code));
    }
    const cancelReturnRows = [];
    for (const o of changedOrders) {
      const local = String(
        o?.local_status || o?.localStatus || o?.internal_status || "",
      ).toUpperCase();
      const sn = String(o?.orderSn || "").replace(/^shopee-/i, "").trim();
      if (local === "CANCELLED_STORED") {
        cancelReturnRows.push({
          order: o,
          type: "cancelled",
          scanCode: scanCodeByOrderSn.get(sn),
        });
      } else if (local === "RETURN_RECEIVED") {
        cancelReturnRows.push({
          order: o,
          type: "return",
          scanCode: scanCodeByOrderSn.get(sn),
        });
      }
    }

    let donHoanHuyWrite = {
      ok: 0,
      failed: 0,
      errors: [],
    };
    if (cancelReturnRows.length > 0) {
      if (!deps.isMongoReady()) {
        console.error("[Orders Scan Bulk] Mongo not ready — không ghi được don_hoan_huy");
        return res.status(500).json({
          success: false,
          message: "Lỗi kết nối MongoDB",
          error: "mongodb_not_ready",
        });
      }
      try {
        donHoanHuyWrite = await deps.upsertDonHoanHuyBatch(
          cancelReturnRows.map((r) => ({
            order: r.order,
            type: r.type,
            scanCode: r.scanCode,
            source: "qr_scan",
          })),
        );
      } catch (dhhErr) {
        console.error("[Orders Scan Bulk] don_hoan_huy batch FAIL:", dhhErr);
        const detail = deps.describeMongoWriteError(dhhErr);
        return res.status(500).json({
          success: false,
          message: deps.isMongoConnectionError(dhhErr) ? "Lỗi kết nối MongoDB" : detail,
          error: "don_hoan_huy_write_failed",
        });
      }
      if (donHoanHuyWrite.failed > 0 && donHoanHuyWrite.ok === 0) {
        const detail =
          donHoanHuyWrite.errors[0] ||
          "Không ghi được đơn nào vào collection don_hoan_huy.";
        console.error("[Orders Scan Bulk] don_hoan_huy all failed:", donHoanHuyWrite.errors);
        const connFail = /Lỗi kết nối MongoDB/i.test(detail);
        return res.status(500).json({
          success: false,
          message: connFail ? "Lỗi kết nối MongoDB" : detail,
          error: "don_hoan_huy_write_failed",
          errors: donHoanHuyWrite.errors.slice(0, 10),
        });
      }
    }

    if (changedOrders.length > 0) {
      // Handed-over vẫn ghi orders; hủy/hoàn ưu tiên don_hoan_huy (cờ orders là phụ).
      const handoverOnly = changedOrders.filter((o) => {
        const local = String(
          o?.local_status || o?.localStatus || o?.internal_status || "",
        ).toUpperCase();
        return (
          local === "HANDED_OVER" ||
          o?.is_handed_over === true ||
          o?.isHandedOverToCarrier === true
        );
      });
      if (handoverOnly.length > 0) {
        try {
          await deps.persistChangedOrdersPatch(handoverOnly);
        } catch (persistErr) {
          console.warn(
            "[Orders Scan Bulk] persistChangedOrdersPatch handover:",
            deps.describeMongoWriteError(persistErr),
            persistErr,
          );
        }
      }

      let flagOk = 0;
      const flagRows = [];
      for (const o of changedOrders) {
        const sn = String(o?.orderSn || "").replace(/^shopee-/i, "").trim();
        if (!sn) continue;
        const shopId = o?.shopId != null ? String(o.shopId) : undefined;
        const local = String(
          o?.local_status || o?.localStatus || o?.internal_status || "",
        ).toUpperCase();
        if (
          local === "HANDED_OVER" ||
          o?.is_handed_over === true ||
          o?.isHandedOverToCarrier === true
        ) {
          flagRows.push({
            orderSn: sn,
            localStatus: "HANDED_OVER",
            shopId,
            source: "qr_scan",
            handedOverAt: String(o.handedOverAt || new Date().toISOString()),
          });
        } else if (local === "CANCELLED_STORED" || local === "RETURN_RECEIVED") {
          flagRows.push({
            orderSn: sn,
            localStatus: local,
            shopId,
            stockRestored: Boolean(o.stock_restored),
            stockRestoredAt: o.stock_restored_at
              ? String(o.stock_restored_at)
              : undefined,
          });
        }
      }
      if (flagRows.length > 0) {
        try {
          if (typeof deps.markOrdersScanFlagsBatch === "function") {
            flagOk = await deps.markOrdersScanFlagsBatch(flagRows);
          } else {
            // Fallback legacy: từng đơn (chậm) — chỉ khi batch chưa wire.
            for (const row of flagRows) {
              try {
                if (row.localStatus === "HANDED_OVER") {
                  const ok = await deps.markOrderHandedOverInStore(row.orderSn, {
                    source: row.source,
                    handedOverAt: row.handedOverAt,
                    shopId: row.shopId,
                  });
                  if (ok) flagOk += 1;
                } else {
                  const ok = await deps.markOrderLocalStatusInStore(
                    row.orderSn,
                    row.localStatus,
                    {
                      shopId: row.shopId,
                      clearHandedOver: true,
                      status:
                        row.localStatus === "RETURN_RECEIVED"
                          ? "return_received"
                          : "cancelled",
                      stockRestored: row.stockRestored,
                      stockRestoredAt: row.stockRestoredAt,
                    },
                  );
                  if (ok) flagOk += 1;
                }
              } catch (flagErr) {
                console.error(
                  `[Orders Scan Bulk] mark flag fail order_sn=${row.orderSn}:`,
                  deps.describeMongoWriteError(flagErr),
                  flagErr,
                );
              }
            }
          }
        } catch (flagBatchErr) {
          console.error(
            "[Orders Scan Bulk] markOrdersScanFlagsBatch FAIL:",
            deps.describeMongoWriteError(flagBatchErr),
            flagBatchErr,
          );
        }
      }
      console.log(
        `[Orders Scan Bulk] don_hoan_huy ok=${donHoanHuyWrite.ok} fail=${donHoanHuyWrite.failed}` +
          ` handoverFlags=${flagOk} changed=${changedOrders.length}`,
      );
      deps.invalidateOrdersRefreshCache();
    }

    const updatedList = [...updatedById.values()];
    const products = await deps.loadProductsForOrders(updatedList);
    const enriched = deps.enrichOrdersFromCatalog(updatedList, products);
    const processedCount = summary.daXuatKho + summary.donHuy + summary.daNhanHoan;

    console.log(
      `[Orders Scan Bulk] PERSISTED codes=${codes.length} updated=${changedOrders.length} summary=${JSON.stringify(summary)} failed=${failed_scans.length} mongo=${deps.isMongoReady()}`,
    );

    return res.json({
      success: true,
      processedCount,
      persistedCount: changedOrders.length,
      donHoanHuy: {
        ...donHoanHuyWrite,
        already: donHoanHuyAlready,
        ensured: donHoanHuyWrite.ok + donHoanHuyAlready,
      },
      summary,
      stats: {
        handedOver: summary.daXuatKho,
        cancelled: summary.donHuy,
        returnReceived: summary.daNhanHoan,
        notFound: failed_scans.filter((f) => f.reason.includes("Không tìm thấy")).length,
        skipped: results.filter((r) => r.action === "skipped").length,
        duplicates: results.filter((r) => r.action === "duplicate").length,
      },
      results,
      failed_scans,
      orders: enriched,
    });
  } catch (error) {
    console.error("[Orders Scan Bulk] Error:", error);
    const detail = deps.describeMongoWriteError(error);
    return res.status(500).json({
      success: false,
      message: deps.isMongoConnectionError(error)
        ? "Lỗi kết nối MongoDB"
        : detail || "Không thể cập nhật hàng loạt đơn đã quét.",
      error: error?.message || "scan_bulk_update_failed",
    });
  }
}
