import fs from "fs";
import path from "path";
import { resolveAppRoot } from "../utils/appPaths.js";

const APP_ROOT = resolveAppRoot();
const IMPORTS_DB_PATH = path.join(APP_ROOT, "data", "imports.json");

/** Deps từ server.ts (Mongo product helpers chưa tách hết). */
let deps = {
  loadProductById: async () => null,
  loadProducts: async () => [],
  applyImportStockAndPriceToMainWarehouse: async () => {
    throw new Error("applyImportStockAndPriceToMainWarehouse_not_initialized");
  },
};

export function initImportsController(partial) {
  deps = { ...deps, ...partial };
}

export function loadImports() {
  try {
    if (!fs.existsSync(IMPORTS_DB_PATH)) return [];
    const raw = fs.readFileSync(IMPORTS_DB_PATH, "utf-8");
    const parsed = raw.trim() ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error("[Imports DB] Failed to read imports.json:", error);
    return [];
  }
}

export function saveImports(imports) {
  try {
    fs.mkdirSync(path.dirname(IMPORTS_DB_PATH), { recursive: true });
    fs.writeFileSync(IMPORTS_DB_PATH, JSON.stringify(imports, null, 2), "utf-8");
  } catch (error) {
    console.error("[Imports DB] Failed to write imports.json:", error);
  }
}

/** GET /api/imports */
export async function listImports(_req, res) {
  return res.json(loadImports());
}

/** GET /api/imports/history/:productId */
export async function getImportHistory(req, res) {
  try {
    const productId = String(req.params.productId || "").trim();
    if (!productId) return res.status(400).json({ success: false, error: "missing_product_id" });
    const product = await deps.loadProductById(productId);
    const sku = String(product?.sku || "").trim();
    const imports = loadImports();
    const history = imports
      .filter(
        (imp) =>
          String(imp.productId) === productId || (sku && String(imp.productSku || "") === sku),
      )
      .sort((a, b) => {
        const tb = new Date(b.date || b.createdAt || 0).getTime();
        const ta = new Date(a.date || a.createdAt || 0).getTime();
        if (tb !== ta) return tb - ta;
        return String(b.id || "").localeCompare(String(a.id || ""));
      });
    return res.json({
      success: true,
      productId,
      productSku: sku || null,
      history,
      total: history.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ success: false, error: message });
  }
}

/** GET /api/imports/product-context/:productId */
export async function getImportProductContext(req, res) {
  const productId = String(req.params.productId);
  const product =
    (await deps.loadProductById(productId)) ||
    (await deps.loadProducts()).find((p) => p.id === productId);
  if (!product) {
    return res.status(404).json({ error: "product_not_found" });
  }

  const imports = loadImports();
  const sku = String(product.sku || "");
  const history = imports.filter(
    (imp) => imp.productId === productId || (sku && imp.productSku === sku),
  );
  const latest =
    history.length > 0
      ? [...history].sort((a, b) => {
          const tb = new Date(b.date || 0).getTime();
          const ta = new Date(a.date || 0).getTime();
          if (tb !== ta) return tb - ta;
          return String(b.id || "").localeCompare(String(a.id || ""));
        })[0]
      : null;

  const stock = Math.max(0, Math.round(Number(product.stock) || 0));
  const oldPrice = Math.max(0, Math.round(Number(product.importPrice) || 0));
  console.log("[Imports] product-context:", { productId, sku, stock, oldPrice, title: product.title });

  return res.json({
    productId,
    stock,
    importPrice: oldPrice,
    oldPrice,
    sku,
    title: product.title || "",
    lastSupplierName: latest?.supplierName || null,
    lastSupplierId: latest?.supplierId || null,
    lastImportDate: latest?.date || null,
  });
}

/** POST /api/imports */
export async function createImport(req, res) {
  const body = req.body || {};
  if (!body.supplierId || !body.productId || !body.quantity || body.newImportPrice == null) {
    return res.status(400).json({ success: false, error: "import_fields_required" });
  }

  const productId = String(body.productId).trim();
  const productSku = String(body.productSku || body.sku || "").trim();
  const qty = Math.max(1, Math.round(Number(body.quantity)));
  const unitPrice = Math.max(0, Math.round(Number(body.newImportPrice)));
  const importCost = Math.max(0, Math.round(Number(body.importCost) || 0));
  const computedTotal = qty * unitPrice + importCost;
  const warehouseId = "KhoGoc";

  try {
    const applied = await deps.applyImportStockAndPriceToMainWarehouse(productId, qty, unitPrice, {
      skuHint: productSku,
    });
    const updatedProduct = applied.product;
    const oldImportPrice =
      Math.max(0, Math.round(Number(body.oldImportPrice) || 0)) || applied.oldImportPrice;

    const imports = loadImports();
    const entry = {
      id: body.id || `imp-${Date.now()}`,
      supplierId: String(body.supplierId),
      supplierName: String(body.supplierName || ""),
      date: body.date || new Date().toISOString().split("T")[0],
      createdAt: new Date().toISOString(),
      productId: String(updatedProduct?.id || productId),
      productTitle: String(body.productTitle || updatedProduct?.title || ""),
      productSku: String(productSku || updatedProduct?.sku || ""),
      quantity: qty,
      oldImportPrice,
      newImportPrice: unitPrice,
      importCost,
      totalAmount: Math.max(0, Math.round(Number(body.totalAmount) || computedTotal)),
      paidAmount: Math.max(0, Math.round(Number(body.paidAmount) || 0)),
      status: body.status || "unpaid",
      notes: body.notes || undefined,
      warehouseId,
      priceChangePercent:
        oldImportPrice > 0
          ? Math.round(((unitPrice - oldImportPrice) / oldImportPrice) * 1000) / 10
          : null,
    };

    try {
      imports.unshift(entry);
      saveImports(imports);
    } catch (logErr) {
      console.error("[Imports] Ghi log thất bại — rollback tồn/giá Kho Gốc:", logErr);
      await deps
        .applyImportStockAndPriceToMainWarehouse(productId, -qty, applied.oldImportPrice, {
          skuHint: productSku,
        })
        .catch((rb) => console.error("[Imports] Rollback Kho Gốc failed:", rb));
      throw logErr;
    }

    console.log("[Imports] PO submitted → KhoGoc", {
      productId: entry.productId,
      sku: entry.productSku,
      qty,
      oldStock: applied.oldStock,
      newStock: applied.newStock,
      oldImportPrice,
      newImportPrice: unitPrice,
      target: applied.target,
    });

    return res.status(201).json({
      success: true,
      import: entry,
      imports,
      product: updatedProduct,
      warehouseId,
      warehouse: "KhoGoc",
      collection: "products",
      stockBefore: applied.oldStock,
      stockAfter: applied.newStock,
      importPriceBefore: oldImportPrice,
      importPriceAfter: unitPrice,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Imports] POST /api/imports failed:", err);
    return res.status(500).json({ success: false, error: message || "import_failed" });
  }
}

/** POST /api/imports/clear-all */
export async function clearAllImports(_req, res) {
  saveImports([]);
  console.log("[Imports] Đã xóa sạch toàn bộ lịch sử nhập hàng.");
  return res.json({ success: true, cleared: true, imports: [] });
}
