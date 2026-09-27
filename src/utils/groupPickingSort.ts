/**
 * Sort gom nhóm nhặt hàng — dùng chung cho danh sách đơn và in hàng loạt.
 * Thứ tự: đơn 1 dòng lên trước → tên sản phẩm dòng đầu (A-Z) → SKU.
 * Không có tên thì gom theo SKU. Cùng tên sản phẩm luôn nằm liền nhau.
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

function normalizeGroupText(value: unknown): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

export function groupPickingSkuKey(order: any): string {
  const item = firstLine(order);
  const sku = normalizeGroupText(
    item?.sku || item?.modelSku || item?.model_sku || item?.item_sku || item?.itemSku || "",
  );
  return sku || "\uffff";
}

export function groupPickingNameKey(order: any): string {
  const item = firstLine(order);
  return normalizeGroupText(
    item?.product_name ||
      item?.productName ||
      item?.productTitle ||
      item?.item_name ||
      item?.name ||
      item?.modelName ||
      item?.model_name ||
      "",
  );
}

/** Tên sản phẩm dòng đầu; không có tên thì dùng SKU để vẫn gom được cụm. */
export function groupPickingClusterKey(order: any): string {
  const name = groupPickingNameKey(order);
  if (name) return name;
  return groupPickingSkuKey(order);
}

const GROUP_PICKING_LOCALE = { sensitivity: "base" as const, numeric: true };

export function compareGroupPickingOrders(a: any, b: any): number {
  const aSingle = orderLines(a).length === 1;
  const bSingle = orderLines(b).length === 1;
  if (aSingle !== bSingle) return aSingle ? -1 : 1;
  const nameCmp = groupPickingClusterKey(a).localeCompare(
    groupPickingClusterKey(b),
    "vi",
    GROUP_PICKING_LOCALE,
  );
  if (nameCmp !== 0) return nameCmp;
  return groupPickingSkuKey(a).localeCompare(groupPickingSkuKey(b), "vi", GROUP_PICKING_LOCALE);
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
