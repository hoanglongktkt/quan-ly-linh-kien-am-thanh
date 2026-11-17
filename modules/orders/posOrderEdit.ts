export type PosItem = { productId?: string; quantity?: number };
export type Quantities = Record<string, number>;
export type PosStockProduct = {
  id?: string;
  _id?: string;
  stock?: number;
  status?: string;
  children?: PosStockProduct[];
  children_models?: PosStockProduct[];
  [key: string]: unknown;
};
export type PosPreviousOrder = {
  items?: PosItem[];
  pos_stock_allocations?: Quantities;
  stock_deducted?: boolean;
};
export type PosStockPlan = {
  allocations: Quantities;
  deltas: Array<{ id: string; delta: number }>;
};

export function posQuantities(items: PosItem[] = []): Quantities {
  const sums: Quantities = Object.create(null);
  for (const item of items) {
    const id = String(item.productId || "").trim();
    if (id) sums[id] = (sums[id] || 0) + Math.max(0, Math.round(Number(item.quantity) || 0));
  }
  return sums;
}

export function planPosStockEdit(previous: PosPreviousOrder, items: PosItem[]): PosStockPlan {
  const before = posQuantities(previous.items);
  const after = posQuantities(items);
  const allocations = previous.pos_stock_allocations || (previous.stock_deducted ? before : {});
  const deltas = Object.entries({ ...before, ...after }).flatMap(([id]) => {
    const change = (after[id] || 0) - (before[id] || 0);
    const delta = change < 0 ? -Math.max(0, (allocations[id] || 0) - (after[id] || 0)) : change;
    return delta === 0 ? [] : [{ id, delta }];
  });
  return { allocations, deltas };
}

export function applyPosStockEdit(products: PosStockProduct[], plan: PosStockPlan) {
  const allocations = new Map(Object.entries(plan.allocations));
  const deltas = new Map(plan.deltas.map(({ id, delta }) => [id, delta]));
  const stocks: Quantities = Object.create(null);
  const changed = new Map<string, PosStockProduct>();
  const stockOf = (product: PosStockProduct) => Math.max(0, Math.round(Number(product.stock) || 0));
  const updateStock = (product: PosStockProduct, stock: number): PosStockProduct => ({
    ...product,
    stock,
    status: product.status === "draft" ? "draft" : stock ? "active" : "out_of_stock",
    lastSynced: new Date().toISOString(),
  });
  const adjust = (row: PosStockProduct): PosStockProduct => {
    const id = String(row.id || row._id || "").trim();
    const delta = deltas.get(id);
    if (delta === undefined) return row;
    deltas.delete(id);
    const stock = stockOf(row);
    const applied = Math.min(stock, delta);
    allocations.set(id, (allocations.get(id) || 0) + applied);
    stocks[id] = stock - applied;
    return applied === 0 ? row : updateStock(row, stocks[id]);
  };
  for (const product of products) {
    const next = adjust(product);
    if (next !== product) changed.set(String(product.id || product._id), next);
  }
  for (const product of products) {
    if (deltas.size === 0) break;
    const id = String(product.id || product._id || "");
    const parent = changed.get(id) || product;
    const childKey = parent.children?.length ? "children" : "children_models";
    const children = parent[childKey];
    if (!Array.isArray(children)) continue;
    const nextChildren = children.map(adjust);
    if (nextChildren.every((row, index) => row === children[index])) continue;
    const stock = nextChildren.reduce((sum, row) => sum + stockOf(row), 0);
    stocks[id] = stock;
    changed.set(id, { ...updateStock(parent, stock), [childKey]: nextChildren });
  }
  for (const [id, delta] of deltas) {
    if (delta < 0) allocations.set(id, (allocations.get(id) || 0) + delta);
  }
  return {
    changed,
    stocks,
    allocations: Object.fromEntries([...allocations].filter(([, quantity]) => quantity > 0)),
  };
}
