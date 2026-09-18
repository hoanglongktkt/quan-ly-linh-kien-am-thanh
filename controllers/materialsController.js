import fs from "fs";
import path from "path";
import { resolveAppRoot } from "../utils/appPaths.js";

const APP_ROOT = resolveAppRoot();
const MATERIALS_DB_PATH = path.join(APP_ROOT, "data", "materials.json");

export function loadMaterials() {
  try {
    if (!fs.existsSync(MATERIALS_DB_PATH)) return [];
    const raw = fs.readFileSync(MATERIALS_DB_PATH, "utf-8");
    const parsed = raw.trim() ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error("[Materials DB] Failed to read materials.json:", error);
    return [];
  }
}

export function saveMaterials(materials) {
  try {
    fs.mkdirSync(path.dirname(MATERIALS_DB_PATH), { recursive: true });
    fs.writeFileSync(MATERIALS_DB_PATH, JSON.stringify(materials, null, 2), "utf-8");
  } catch (error) {
    console.error("[Materials DB] Failed to write materials.json:", error);
    throw error;
  }
}

/** GET /api/materials */
export async function listMaterials(_req, res) {
  return res.json(loadMaterials());
}

/** POST /api/materials — tạo vật tư nhanh (không đụng products) */
export async function createMaterial(req, res) {
  try {
    const body = req.body || {};
    const name = String(body.name || body.title || "").trim();
    if (!name) {
      return res.status(400).json({ success: false, error: "material_name_required" });
    }

    const materials = loadMaterials();
    const now = new Date().toISOString();
    const entry = {
      id: body.id || `mat-${Date.now()}`,
      name,
      sku: String(body.sku || "").trim() || undefined,
      stock: Math.max(0, Math.round(Number(body.stock) || 0)),
      importPrice: Math.max(0, Math.round(Number(body.importPrice) || 0)),
      notes: body.notes != null ? String(body.notes) : undefined,
      createdAt: now,
      updatedAt: now,
      is_material: true,
    };
    materials.unshift(entry);
    saveMaterials(materials);
    return res.status(201).json({ success: true, material: entry, materials });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ success: false, error: message });
  }
}

/** PUT /api/materials/:id */
export async function updateMaterial(req, res) {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ success: false, error: "missing_material_id" });

    const materials = loadMaterials();
    const idx = materials.findIndex((m) => String(m.id) === id);
    if (idx < 0) return res.status(404).json({ success: false, error: "material_not_found" });

    const body = req.body || {};
    const current = materials[idx];
    const updated = {
      ...current,
      name: body.name != null ? String(body.name).trim() || current.name : current.name,
      sku: body.sku != null ? String(body.sku).trim() : current.sku,
      stock:
        body.stock != null
          ? Math.max(0, Math.round(Number(body.stock) || 0))
          : current.stock,
      importPrice:
        body.importPrice != null
          ? Math.max(0, Math.round(Number(body.importPrice) || 0))
          : current.importPrice,
      notes: body.notes != null ? String(body.notes) : current.notes,
      updatedAt: new Date().toISOString(),
      is_material: true,
    };
    materials[idx] = updated;
    saveMaterials(materials);
    return res.json({ success: true, material: updated, materials });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ success: false, error: message });
  }
}

/**
 * Cộng tồn / cập nhật giá nhập vật tư — CHỈ materials.json, tuyệt đối không đụng products.
 */
export function applyMaterialStockAndPrice(materialId, qtyDelta, unitPrice, opts = {}) {
  const materials = loadMaterials();
  const id = String(materialId || "").trim();
  let idx = id ? materials.findIndex((m) => String(m.id) === id) : -1;

  const nameHint = String(opts.nameHint || "").trim();
  if (idx < 0 && nameHint) {
    idx = materials.findIndex(
      (m) => String(m.name || "").trim().toLowerCase() === nameHint.toLowerCase(),
    );
  }

  const now = new Date().toISOString();
  const delta = Math.round(Number(qtyDelta) || 0);
  const price = Math.max(0, Math.round(Number(unitPrice) || 0));

  if (idx < 0) {
    if (!nameHint && !id) {
      throw new Error("material_identity_required");
    }
    const entry = {
      id: id || `mat-${Date.now()}`,
      name: nameHint || "Vật tư",
      stock: Math.max(0, delta),
      importPrice: price,
      notes: opts.notes != null ? String(opts.notes) : undefined,
      createdAt: now,
      updatedAt: now,
      is_material: true,
    };
    materials.unshift(entry);
    saveMaterials(materials);
    return {
      product: null,
      material: entry,
      oldStock: 0,
      newStock: entry.stock,
      oldImportPrice: 0,
      created: true,
    };
  }

  const current = materials[idx];
  const oldStock = Math.max(0, Math.round(Number(current.stock) || 0));
  const oldImportPrice = Math.max(0, Math.round(Number(current.importPrice) || 0));
  const newStock = Math.max(0, oldStock + delta);
  const updated = {
    ...current,
    name: nameHint || current.name,
    stock: newStock,
    importPrice: price > 0 ? price : oldImportPrice,
    notes: opts.notes != null ? String(opts.notes) : current.notes,
    updatedAt: now,
    is_material: true,
  };
  materials[idx] = updated;
  saveMaterials(materials);
  return {
    product: null,
    material: updated,
    oldStock,
    newStock,
    oldImportPrice,
    created: false,
  };
}
