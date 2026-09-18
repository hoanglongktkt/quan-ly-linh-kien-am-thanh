import fs from "fs";
import path from "path";
import { resolveAppRoot } from "../utils/appPaths.js";
import {
  applyMaterialStockAndPrice,
  loadMaterials,
} from "./materialsController.js";

const APP_ROOT = resolveAppRoot();
const MATERIAL_IMPORTS_DB_PATH = path.join(APP_ROOT, "data", "material_imports.json");

export function loadMaterialImports() {
  try {
    if (!fs.existsSync(MATERIAL_IMPORTS_DB_PATH)) return [];
    const raw = fs.readFileSync(MATERIAL_IMPORTS_DB_PATH, "utf-8");
    const parsed = raw.trim() ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error("[MaterialImports DB] Failed to read material_imports.json:", error);
    return [];
  }
}

export function saveMaterialImports(imports) {
  try {
    fs.mkdirSync(path.dirname(MATERIAL_IMPORTS_DB_PATH), { recursive: true });
    fs.writeFileSync(MATERIAL_IMPORTS_DB_PATH, JSON.stringify(imports, null, 2), "utf-8");
  } catch (error) {
    console.error("[MaterialImports DB] Failed to write material_imports.json:", error);
    throw error;
  }
}

/** GET /api/material-imports */
export async function listMaterialImports(_req, res) {
  return res.json(loadMaterialImports());
}

/**
 * POST /api/material-imports
 * Tạo phiếu nhập vật tư — tái sử dụng supplierId từ collection Nhà cung cấp.
 * TUYỆT ĐỐI không gọi applyImportStockAndPriceToMainWarehouse / không đụng products.
 */
export async function createMaterialImport(req, res) {
  const body = req.body || {};
  const supplierId = String(body.supplierId || "").trim();
  const supplierName = String(body.supplierName || "").trim();

  if (!supplierId) {
    return res.status(400).json({ success: false, error: "supplier_required" });
  }

  // Hỗ trợ cả 1 dòng (legacy) và nhiều dòng (lines[])
  let lines = Array.isArray(body.lines) ? body.lines : null;
  if (!lines) {
    if (!body.materialName && !body.materialId) {
      return res.status(400).json({ success: false, error: "material_lines_required" });
    }
    lines = [body];
  }

  if (lines.length === 0) {
    return res.status(400).json({ success: false, error: "material_lines_required" });
  }

  // Giới hạn batch để chống vòng lặp vô tận / treo server
  const MAX_LINES = 100;
  if (lines.length > MAX_LINES) {
    return res.status(400).json({
      success: false,
      error: `too_many_lines_max_${MAX_LINES}`,
    });
  }

  const date = body.date || new Date().toISOString().split("T")[0];
  const createdAt = new Date().toISOString();
  const importCost = Math.max(0, Math.round(Number(body.importCost) || 0));
  let remainingPaid = Math.max(0, Math.round(Number(body.paidAmount) || 0));

  const createdEntries = [];
  const appliedMaterials = [];
  const rollbackStack = [];

  try {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] || {};
      const materialName = String(line.materialName || line.name || "").trim();
      const materialId = String(line.materialId || "").trim();
      const notes = String(line.notes != null ? line.notes : "").trim();

      if (!materialName && !materialId) {
        throw new Error(`line_${i}_material_name_required`);
      }
      if (!notes) {
        throw new Error(`line_${i}_notes_required`);
      }

      const qty = Math.max(1, Math.round(Number(line.quantity) || 0));
      const unitPrice = Math.max(0, Math.round(Number(line.unitPrice ?? line.newImportPrice) || 0));
      if (unitPrice <= 0) {
        throw new Error(`line_${i}_unit_price_required`);
      }

      const lineImportCost = i === 0 ? importCost : 0;
      const lineGoods = qty * unitPrice;
      const lineTotal = lineGoods + lineImportCost;
      const linePaid = Math.min(remainingPaid, lineTotal);
      remainingPaid -= linePaid;

      let status = "unpaid";
      if (linePaid === lineTotal) status = "fully_paid";
      else if (linePaid > 0) status = "partial";

      const applied = applyMaterialStockAndPrice(materialId, qty, unitPrice, {
        nameHint: materialName,
        notes,
      });
      rollbackStack.push({
        materialId: applied.material.id,
        qty,
        oldImportPrice: applied.oldImportPrice,
        nameHint: applied.material.name,
      });
      appliedMaterials.push(applied.material);

      const entry = {
        id: line.id || `mat-imp-${Date.now()}-${i}`,
        supplierId,
        supplierName,
        date,
        createdAt,
        materialId: String(applied.material.id),
        materialName: String(applied.material.name || materialName),
        quantity: qty,
        oldImportPrice: applied.oldImportPrice,
        newImportPrice: unitPrice,
        unitPrice,
        importCost: lineImportCost,
        totalAmount: Math.max(0, Math.round(Number(line.totalAmount) || lineTotal)),
        paidAmount: linePaid,
        status: line.status || status,
        notes,
        is_material: true,
      };
      createdEntries.push(entry);

      // Nghỉ nhẹ giữa các dòng khi batch lớn — chống rate/CPU spike trên cPanel
      if (i > 0 && i % 20 === 0) {
        await new Promise((r) => setTimeout(r, 10));
      }
    }

    const imports = loadMaterialImports();
    for (let i = createdEntries.length - 1; i >= 0; i--) {
      imports.unshift(createdEntries[i]);
    }
    saveMaterialImports(imports);

    console.log("[MaterialImports] PO saved (materials only, products untouched)", {
      supplierId,
      lines: createdEntries.length,
      materialIds: createdEntries.map((e) => e.materialId),
    });

    return res.status(201).json({
      success: true,
      imports: createdEntries,
      allImports: imports,
      materials: loadMaterials(),
      updatedMaterials: appliedMaterials,
    });
  } catch (err) {
    // Rollback tồn vật tư đã cộng — vẫn không đụng products
    for (let i = rollbackStack.length - 1; i >= 0; i--) {
      const rb = rollbackStack[i];
      try {
        applyMaterialStockAndPrice(rb.materialId, -rb.qty, rb.oldImportPrice, {
          nameHint: rb.nameHint,
        });
      } catch (rbErr) {
        console.error("[MaterialImports] Rollback material stock failed:", rbErr);
      }
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error("[MaterialImports] POST failed:", err);
    return res.status(500).json({ success: false, error: message || "material_import_failed" });
  }
}

/** POST /api/material-imports/clear-all */
export async function clearAllMaterialImports(_req, res) {
  saveMaterialImports([]);
  console.log("[MaterialImports] Đã xóa sạch lịch sử nhập vật tư.");
  return res.json({ success: true, cleared: true, imports: [] });
}
