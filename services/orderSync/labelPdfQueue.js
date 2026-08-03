/**
 * Background PDF Label Queue — đăng ký worker từ server, Sync Service chỉ enqueue.
 * Tách khỏi route handler để sync ngầm có thể đẩy PDF sau bulkWrite.
 */

/** @type {((items: any[]) => void) | null} */
let prepareLabelsFn = null;

const pendingBuffer = [];
let flushScheduled = false;

/**
 * Server đăng ký hàm firePrepareShippingLabelsForOrders.
 * @param {(items: any[]) => void} fn
 */
export function registerLabelPdfDownloader(fn) {
  prepareLabelsFn = typeof fn === "function" ? fn : null;
  console.log(
    `[LabelPdfQueue] register downloader=${prepareLabelsFn ? "OK" : "NULL"}`,
  );
  if (prepareLabelsFn && pendingBuffer.length > 0) {
    flushPending();
  }
}

/**
 * Đẩy đơn vào hàng đợi tải PDF ngầm (không chặn sync).
 * @param {any[]} orders — đơn vừa upsert (ưu tiên đơn mới / chưa hasPdf)
 */
export function enqueueLabelPdfDownload(orders) {
  const list = Array.isArray(orders) ? orders.filter(Boolean) : [];
  if (list.length === 0) return 0;

  const items = [];
  for (const o of list) {
    const sn = String(o?.orderSn || o?.order_sn || "")
      .replace(/^shopee-/i, "")
      .trim();
    if (!sn) continue;
    if (o?.hasPdf === true || o?.readyToPrint === true) {
      const hasFile = Boolean(
        String(o?.labelUrl || o?.pdfUrl || o?.pdfFilename || "").trim(),
      );
      if (hasFile) continue;
    }
    items.push({
      shopId: o.shopId || o.shop_id,
      orderSn: sn,
      packageNumber: o.packageNumber || o.package_number,
      trackingNumber: o.trackingNumber || o.tracking_no,
      order: o,
    });
  }
  if (items.length === 0) {
    console.log("[LabelPdfQueue] enqueue skip — không có đơn cần tải PDF");
    return 0;
  }

  console.log(
    `[LabelPdfQueue] Đẩy vào hàng đợi tải PDF — n=${items.length}` +
      ` sns=[${items.map((i) => i.orderSn).join(",")}]`,
  );

  if (prepareLabelsFn) {
    try {
      prepareLabelsFn(items);
    } catch (err) {
      console.error("[LabelPdfQueue] prepareLabelsFn throw:", err?.message || err);
    }
    return items.length;
  }

  pendingBuffer.push(...items);
  if (!flushScheduled) {
    flushScheduled = true;
    setTimeout(() => {
      flushScheduled = false;
      flushPending();
    }, 2000);
  }
  return items.length;
}

function flushPending() {
  if (!prepareLabelsFn || pendingBuffer.length === 0) return;
  const batch = pendingBuffer.splice(0, pendingBuffer.length);
  console.log(`[LabelPdfQueue] flush pending n=${batch.length}`);
  try {
    prepareLabelsFn(batch);
  } catch (err) {
    console.error("[LabelPdfQueue] flush failed:", err?.message || err);
  }
}
