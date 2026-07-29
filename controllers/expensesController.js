import fs from "fs";
import path from "path";
import { resolveAppRoot } from "../utils/appPaths.js";

const APP_ROOT = resolveAppRoot();
const EXPENSES_DB_PATH = path.join(APP_ROOT, "data", "expenses.json");
const EXPENSES_CLEAR_MARKER = path.join(APP_ROOT, "data", ".expenses-cleared-v2");

function loadExpenses() {
  try {
    if (!fs.existsSync(EXPENSES_DB_PATH)) return [];
    const raw = fs.readFileSync(EXPENSES_DB_PATH, "utf-8");
    const parsed = raw.trim() ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error("[Expenses DB] Failed to read expenses.json:", error);
    return [];
  }
}

function saveExpenses(expenses) {
  try {
    fs.mkdirSync(path.dirname(EXPENSES_DB_PATH), { recursive: true });
    fs.writeFileSync(EXPENSES_DB_PATH, JSON.stringify(expenses, null, 2), "utf-8");
  } catch (error) {
    console.error("[Expenses DB] Failed to write expenses.json:", error);
  }
}

function migrateExpensesStorageOnce() {
  if (fs.existsSync(EXPENSES_CLEAR_MARKER)) return;
  saveExpenses([]);
  try {
    fs.mkdirSync(path.dirname(EXPENSES_CLEAR_MARKER), { recursive: true });
    fs.writeFileSync(EXPENSES_CLEAR_MARKER, new Date().toISOString(), "utf-8");
    console.log("[Expenses] Đã xóa sạch dữ liệu chi phí cũ (migration một lần).");
  } catch (error) {
    console.error("[Expenses] Failed to write clear marker:", error);
  }
}

migrateExpensesStorageOnce();

/** GET /api/expenses */
export async function listExpenses(_req, res) {
  return res.json(loadExpenses());
}

/** POST /api/expenses */
export async function createExpense(req, res) {
  const body = req.body || {};
  if (!body.title?.trim() || !body.amount || !body.category || !body.date) {
    return res.status(400).json({ error: "expense_fields_required" });
  }
  const expenses = loadExpenses();
  const entry = {
    id: body.id || `exp-${Date.now()}`,
    title: String(body.title).trim(),
    amount: Math.max(0, Math.round(Number(body.amount))),
    category: String(body.category),
    date: String(body.date),
    notes: body.notes ? String(body.notes) : undefined,
  };
  expenses.unshift(entry);
  saveExpenses(expenses);
  return res.status(201).json({ expense: entry, expenses });
}

/** DELETE /api/expenses/:id */
export async function deleteExpense(req, res) {
  const expenses = loadExpenses();
  const next = expenses.filter((e) => e.id !== req.params.id);
  if (next.length === expenses.length) {
    return res.status(404).json({ error: "expense_not_found" });
  }
  saveExpenses(next);
  return res.json({ deleted: req.params.id, expenses: next });
}

/** POST /api/expenses/clear-all */
export async function clearAllExpenses(_req, res) {
  saveExpenses([]);
  console.log("[Expenses] Đã xóa sạch toàn bộ chi phí doanh nghiệp.");
  return res.json({ success: true, cleared: true, expenses: [] });
}
