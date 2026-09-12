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
  const sellingPrice = Math.max(0, Math.round(Number(product.sellingPrice) || 0));
  console.log("[Imports] product-context:", { productId, sku, stock, oldPrice, sellingPrice, title: product.title });

  return res.json({
    productId,
    stock,
    importPrice: oldPrice,
    oldPrice,
    sellingPrice,
    shopeeItemId: product.shopeeItemId || product.shopeeId || null,
    shopeeModelId: product.shopeeModelId || null,
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

/**
 * Tính khoảng thời gian [start, end] theo timeRange cho báo cáo nhập hàng theo NCC.
 * Mặc định: 'ytd' (đầu năm đến nay) — khớp yêu cầu báo cáo.
 */
function getSupplierReportDateRange(timeRange) {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);

  switch (String(timeRange || "ytd").trim()) {
    case "today": {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      return { start, end };
    }
    case "yesterday": {
      const start = new Date(now);
      start.setDate(start.getDate() - 1);
      start.setHours(0, 0, 0, 0);
      const dayEnd = new Date(start);
      dayEnd.setHours(23, 59, 59, 999);
      return { start, end: dayEnd };
    }
    case "7days":
    case "last_7_days": {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      start.setDate(start.getDate() - 6);
      return { start, end };
    }
    case "30days":
    case "last_30_days": {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      start.setDate(start.getDate() - 29);
      return { start, end };
    }
    case "thisMonth":
    case "this_month":
      return { start: new Date(y, m, 1), end };
    case "lastMonth":
    case "last_month":
      return {
        start: new Date(y, m - 1, 1),
        end: new Date(y, m, 0, 23, 59, 59, 999),
      };
    case "ytd":
    default:
      return { start: new Date(y, 0, 1), end };
  }
}

/** Parse ngày phiếu nhập (ưu tiên `date` YYYY-MM-DD, fallback `createdAt`). */
function parseImportRecordDate(imp) {
  const raw = String(imp?.date || imp?.createdAt || "").trim();
  if (!raw) return new Date(NaN);
  const datePart = raw.split("T")[0];
  const parts = datePart.split("-").map(Number);
  const yy = parts[0];
  const mm = parts[1];
  const dd = parts[2];
  if (!yy || !mm || !dd) return new Date(NaN);
  return new Date(yy, mm - 1, dd);
}

/**
 * GET /api/imports/supplier-report?timeRange=ytd|today|yesterday|7days|30days|thisMonth|lastMonth
 * Báo cáo tổng hợp nhập hàng gom nhóm theo Nhà cung cấp trong khoảng thời gian lọc.
 * Tính năng đọc/thống kê độc lập — KHÔNG chỉnh sửa dữ liệu imports.json.
 */
export async function getSupplierReport(req, res) {
  try {
    const timeRange = String(req.query?.timeRange || "ytd").trim() || "ytd";
    const { start, end } = getSupplierReportDateRange(timeRange);

    const imports = loadImports();
    const inRange = imports.filter((imp) => {
      const d = parseImportRecordDate(imp);
      if (Number.isNaN(d.getTime())) return false;
      return d >= start && d <= end;
    });

    const groups = new Map();
    for (const imp of inRange) {
      const supplierId = String(imp?.supplierId || "").trim();
      const supplierName = String(imp?.supplierName || "").trim() || "Không xác định";
      const key = supplierId || `name:${supplierName}`;

      if (!groups.has(key)) {
        groups.set(key, {
          supplierId: supplierId || null,
          supplierName,
          totalOrders: 0,
          totalQuantity: 0,
          totalPaidAmount: 0,
          totalAmount: 0,
        });
      }
      const g = groups.get(key);
      g.totalOrders += 1;
      g.totalQuantity += Math.max(0, Math.round(Number(imp?.quantity) || 0));
      g.totalPaidAmount += Math.max(0, Math.round(Number(imp?.paidAmount) || 0));
      g.totalAmount += Math.max(0, Math.round(Number(imp?.totalAmount) || 0));
    }

    const report = Array.from(groups.values()).sort(
      (a, b) => b.totalPaidAmount - a.totalPaidAmount,
    );

    return res.json({
      success: true,
      timeRange,
      startDate: start.toISOString().split("T")[0],
      endDate: end.toISOString().split("T")[0],
      totalSuppliers: report.length,
      report,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Imports] GET /api/imports/supplier-report failed:", err);
    // Fallback an toàn — luôn trả về report rỗng thay vì crash UI.
    return res.status(500).json({ success: false, error: message, report: [] });
  }
}
