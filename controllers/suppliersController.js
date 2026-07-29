import fs from "fs";
import path from "path";
import { resolveAppRoot } from "../utils/appPaths.js";

const APP_ROOT = resolveAppRoot();
const SUPPLIERS_DB_PATH = path.join(APP_ROOT, "data", "suppliers.json");

function normalizeSupplier(raw) {
  const totalOrderValue = Number(raw?.totalOrderValue) || 0;
  const totalPaid = Number(raw?.totalPaid) || 0;
  return {
    id: String(raw?.id || `sup-${Date.now()}`),
    name: String(raw?.name || "").trim(),
    supplierCode: String(raw?.supplierCode || raw?.supplier_code || "")
      .trim()
      .toUpperCase(),
    totalOrderValue,
    totalPaid,
    totalDebt: Number(raw?.totalDebt ?? totalOrderValue - totalPaid) || 0,
    status: raw?.status === "inactive" ? "inactive" : "active",
  };
}

function loadSuppliers() {
  try {
    if (!fs.existsSync(SUPPLIERS_DB_PATH)) return [];
    const raw = fs.readFileSync(SUPPLIERS_DB_PATH, "utf-8");
    const parsed = raw.trim() ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.map(normalizeSupplier) : [];
  } catch (error) {
    console.error("[Suppliers DB] Failed to read suppliers.json:", error);
    return [];
  }
}

function saveSuppliers(suppliers) {
  try {
    fs.mkdirSync(path.dirname(SUPPLIERS_DB_PATH), { recursive: true });
    fs.writeFileSync(SUPPLIERS_DB_PATH, JSON.stringify(suppliers, null, 2), "utf-8");
  } catch (error) {
    console.error(
      "Lỗi chi tiết khi lưu shop/OAuth:",
      error?.response?.data || error?.message || String(error),
    );
    console.error("[Suppliers DB] Failed to write suppliers.json:", error);
  }
}

/** GET /api/suppliers */
export async function listSuppliers(_req, res) {
  return res.json(loadSuppliers());
}

/** POST /api/suppliers */
export async function createSupplier(req, res) {
  const body = req.body || {};
  if (!body.name?.trim() || !body.supplierCode?.trim()) {
    return res.status(400).json({ error: "name_and_supplierCode_required" });
  }
  const suppliers = loadSuppliers();
  const code = String(body.supplierCode).trim().toUpperCase();
  if (suppliers.some((s) => s.supplierCode === code)) {
    return res.status(400).json({ error: "supplier_code_duplicate" });
  }
  const supplier = normalizeSupplier({
    id: `sup-${Date.now()}`,
    name: body.name,
    supplierCode: code,
    totalOrderValue: 0,
    totalPaid: 0,
    totalDebt: 0,
    status: body.status || "active",
  });
  suppliers.unshift(supplier);
  saveSuppliers(suppliers);
  return res.status(201).json({ supplier, suppliers });
}

/** PUT /api/suppliers/:id */
export async function updateSupplier(req, res) {
  const suppliers = loadSuppliers();
  const index = suppliers.findIndex((s) => s.id === req.params.id);
  if (index === -1) {
    return res.status(404).json({ error: "supplier_not_found" });
  }
  const body = req.body || {};
  const code = body.supplierCode
    ? String(body.supplierCode).trim().toUpperCase()
    : suppliers[index].supplierCode;
  if (suppliers.some((s, i) => i !== index && s.supplierCode === code)) {
    return res.status(400).json({ error: "supplier_code_duplicate" });
  }
  const updated = normalizeSupplier({
    ...suppliers[index],
    ...body,
    id: suppliers[index].id,
    supplierCode: code,
  });
  suppliers[index] = updated;
  saveSuppliers(suppliers);
  return res.json({ supplier: updated, suppliers });
}

/** DELETE /api/suppliers/:id */
export async function deleteSupplier(req, res) {
  const suppliers = loadSuppliers();
  const target = suppliers.find((s) => s.id === req.params.id);
  if (!target) {
    return res.status(404).json({ error: "supplier_not_found" });
  }
  if (target.totalDebt > 0) {
    return res.status(400).json({ error: "supplier_has_debt" });
  }
  const next = suppliers.filter((s) => s.id !== req.params.id);
  saveSuppliers(next);
  return res.json({ deleted: req.params.id, suppliers: next });
}

/** POST /api/suppliers/clear-all */
export async function clearAllSuppliers(_req, res) {
  saveSuppliers([]);
  console.log("[Suppliers] Đã xóa sạch toàn bộ dữ liệu nhà cung cấp.");
  return res.json({ success: true, cleared: true, suppliers: [] });
}
