import crypto from "node:crypto";

export function importBatchError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function money(value, name, fallback) {
  const n = Number(value ?? fallback);
  if (!Number.isSafeInteger(n) || n < 0) throw importBatchError(`invalid_${name}`);
  return n;
}

export function normalizeImportBatch(body) {
  const batchId = String(body?.batchId || "").trim();
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(batchId)) throw importBatchError("invalid_import_batch_id");
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 200) {
    throw importBatchError("import_batch_requires_1_to_200_items");
  }
  const supplierId = String(body.supplierId || body.items[0]?.supplierId || "").trim();
  if (!supplierId) throw importBatchError("supplier_required");
  const items = body.items.map((row, i) => {
    if (!row || typeof row !== "object") throw importBatchError(`invalid_import_line_${i + 1}`);
    const productId = String(row.productId || "").trim();
    if (!productId || String(row.supplierId || supplierId) !== supplierId) {
      throw importBatchError(`invalid_import_line_${i + 1}`);
    }
    const quantity = money(row.quantity, "quantity");
    if (quantity === 0) throw importBatchError("invalid_quantity");
    const newImportPrice = money(row.newImportPrice, "import_price");
    const importCost = money(row.importCost, "import_cost", 0);
    const totalAmount = money(quantity * newImportPrice + importCost, "total_amount");
    const paidAmount = money(row.paidAmount, "paid_amount", 0);
    if (paidAmount > totalAmount) throw importBatchError("paid_amount_exceeds_total");
    const date = String(row.date || new Date().toISOString().slice(0, 10));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date))) {
      throw importBatchError("invalid_import_date");
    }
    return {
      productId,
      productSku: String(row.productSku || row.sku || "").trim(),
      quantity, newImportPrice, importCost, totalAmount, paidAmount, date,
      notes: String(row.notes || "").slice(0, 4000),
    };
  });
  // Include only write-affecting fields. Client titles/old prices are not authoritative.
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify({ supplierId, items })).digest("hex");
  return { batchId, supplierId, items, fingerprint };
}

function productIndex(products) {
  const ids = new Map();
  const skus = new Map();
  const add = (map, key, hit) => {
    if (!key) return;
    const list = map.get(key) || [];
    if (!list.some((x) => x.key === hit.key)) list.push(hit);
    map.set(key, list);
  };
  products.forEach((parent, parentIdx) => {
    const hit = { parentIdx, key: `${parentIdx}`, childKey: null, childIdx: -1 };
    add(ids, String(parent.id || "").trim(), hit);
    add(skus, String(parent.sku || "").trim().toLowerCase(), hit);
    const childKey = parent.children?.length ? "children" : parent.children_models?.length ? "children_models" : null;
    if (!childKey) return;
    parent[childKey].forEach((child, childIdx) => {
      const childHit = { parentIdx, childKey, childIdx, key: `${parentIdx}/${childKey}/${childIdx}` };
      for (const id of [child.id, child.shopeeModelId]) add(ids, String(id || "").trim(), childHit);
      add(skus, String(child.sku || "").trim().toLowerCase(), childHit);
    });
  });
  return { ids, skus };
}

export function prepareImportProducts(products, items) {
  const index = productIndex(products);
  const used = new Set();
  const hits = items.map((item) => {
    const matches = index.ids.get(item.productId) || index.skus.get(item.productSku.toLowerCase()) || [];
    if (matches.length !== 1) throw importBatchError(matches.length ? "ambiguous_import_product" : "import_product_not_found");
    const hit = matches[0];
    if (used.has(hit.key)) throw importBatchError("duplicate_import_product");
    used.add(hit.key);
    return hit;
  });
  for (const hit of hits) {
    if (hit.childKey && used.has(String(hit.parentIdx))) throw importBatchError("import_parent_and_child_conflict");
  }
  const next = [...products];
  const updatedParents = new Map();
  const results = hits.map((hit, i) => {
    const item = items[i];
    const parent = next[hit.parentIdx];
    const before = hit.childKey ? parent[hit.childKey][hit.childIdx] : parent;
    const oldStock = Math.max(0, Math.round(Number(before.stock) || 0));
    const oldImportPrice = Math.max(0, Math.round(Number(before.importPrice) || 0));
    const stock = oldStock + item.quantity;
    if (!Number.isSafeInteger(stock)) throw importBatchError("invalid_stock_total");
    const product = {
      ...before,
      id: String(before.id || item.productId),
      stock, importPrice: item.newImportPrice,
      status: before.status === "out_of_stock" ? "active" : before.status,
      lastSynced: new Date().toISOString(),
    };
    if (hit.childKey) {
      const children = [...parent[hit.childKey]];
      children[hit.childIdx] = product;
      next[hit.parentIdx] = {
        ...parent, [hit.childKey]: children,
        stock: children.reduce((sum, c) => sum + Math.max(0, Math.round(Number(c.stock) || 0)), 0),
        lastSynced: product.lastSynced,
      };
    } else {
      next[hit.parentIdx] = product;
    }
    updatedParents.set(hit.parentIdx, next[hit.parentIdx]);
    return { product, oldStock, oldImportPrice };
  });
  return { products: next, results, updatedProducts: [...updatedParents.values()] };
}

export function replayImportProducts(products, entries) {
  const ids = new Set(entries.map((entry) => entry.productId));
  return products.filter((p) => ids.has(p.id) ||
    [...(p.children || []), ...(p.children_models || [])].some((c) => ids.has(c.id)));
}

export function buildImportBatchEntries(batch, supplier, results) {
  const createdAt = new Date().toISOString();
  return batch.items.map((item, i) => {
    const { product, oldImportPrice } = results[i];
    return {
      ...item,
      id: `${batch.batchId}-${i}`,
      batchId: batch.batchId, batchFingerprint: batch.fingerprint,
      supplierId: supplier.id, supplierName: supplier.name,
      productId: product.id, productSku: product.sku || item.productSku,
      productTitle: product.title || product.name || "",
      oldImportPrice,
      status: item.paidAmount === item.totalAmount ? "fully_paid" : item.paidAmount > 0 ? "partial" : "unpaid",
      warehouseId: "KhoGoc", createdAt,
      priceChangePercent: oldImportPrice > 0 ? Math.round((item.newImportPrice - oldImportPrice) / oldImportPrice * 1000) / 10 : null,
    };
  });
}
