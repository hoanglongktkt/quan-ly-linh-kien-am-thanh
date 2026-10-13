// Index tra cứu đơn chỉ có một bản, dùng chung qua ordersService.
let orderLookupIndex = null;
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
