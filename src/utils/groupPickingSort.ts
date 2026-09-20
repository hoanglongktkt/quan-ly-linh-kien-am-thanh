/**
 * Sort gom nhóm nhặt hàng — dùng chung cho danh sách đơn và in hàng loạt.
 * Thứ tự: đơn 1 SKU → SKU dòng đầu (A-Z) → tên sản phẩm. SKU rỗng xuống cuối.
 */

export function uniquePreserveOrder(values: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const key = String(value || "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

export function normalizePrintOrderSn(value: unknown): string {
  return String(value || "")
    .replace(/^shopee-/i, "")
    .trim();
}

function orderLines(order: any): any[] {
  const data = order?.data && typeof order.data === "object" ? order.data : null;
  const items = order?.items || data?.items;
  if (Array.isArray(items) && items.length > 0) return items;
  const list = order?.item_list || data?.item_list;
  return Array.isArray(list) ? list : [];
}

function firstLine(order: any): any {
  return orderLines(order)[0] || {};
}

export function groupPickingSkuKey(order: any): string {
  const item = firstLine(order);
  const sku = String(
    item?.modelSku || item?.model_sku || item?.sku || item?.item_sku || "",
  )
    .trim()
    .toUpperCase();
  return sku || "\uffff";
}

export function groupPickingNameKey(order: any): string {
  const item = firstLine(order);
  return String(
    item?.productTitle || item?.item_name || item?.name || item?.modelName || "",
  )
    .trim()
    .toUpperCase();
}

export function compareGroupPickingOrders(a: any, b: any): number {
  const aSingle = orderLines(a).length === 1;
  const bSingle = orderLines(b).length === 1;
  if (aSingle !== bSingle) return aSingle ? -1 : 1;
  const skuCmp = groupPickingSkuKey(a).localeCompare(groupPickingSkuKey(b), "vi", {
    sensitivity: "base",
    numeric: true,
  });
  if (skuCmp !== 0) return skuCmp;
  return groupPickingNameKey(a).localeCompare(groupPickingNameKey(b), "vi", {
    sensitivity: "base",
    numeric: true,
  });
}

/** Sắp mã đơn theo đúng comparator gom nhóm; mã không tìm thấy giữ cuối, đúng thứ tự gốc. */
export function sortSnsByGroupPicking(sns: string[], orders: any[]): string[] {
  const bySn = new Map<string, any>();
  for (const order of Array.isArray(orders) ? orders : []) {
    const sn = normalizePrintOrderSn(order?.orderSn || order?.order_sn);
    if (sn && !bySn.has(sn)) bySn.set(sn, order);
  }
  const requested = uniquePreserveOrder(
    (Array.isArray(sns) ? sns : []).map(normalizePrintOrderSn).filter(Boolean),
  );
  const sortable: { sn: string; order: any }[] = [];
  const missing: string[] = [];
  for (const sn of requested) {
    const order = bySn.get(sn);
    if (order) sortable.push({ sn, order });
    else missing.push(sn);
  }
  sortable.sort((a, b) => compareGroupPickingOrders(a.order, b.order));
  return [...sortable.map((row) => row.sn), ...missing];
}
