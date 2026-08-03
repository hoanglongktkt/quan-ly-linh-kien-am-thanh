#!/usr/bin/env node
/**
 * ONE-SHOT — tối ưu index collection `orders`.
 *
 * - Drop index thừa/lặp: isPrinted_1, hasPdf_1, orderSn_1
 * - syncIndexes() theo Schema trong src/db/mongoStore.ts
 *   (orderSn_unique, hasPdf+isPrinted, last_shopee_update_at:-1, …)
 *
 * Chạy 1 lần:
 *   npx tsx scripts/optimize_indexes.js
 *
 * Biến môi trường (.env): MONGODB_URI | MONGO_URL | MONGO_URI
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import mongoose from "mongoose";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
dotenv.config({ path: path.join(ROOT, ".env") });

const URI = String(
  process.env.MONGODB_URI || process.env.MONGO_URL || process.env.MONGO_URI || "",
).trim();

const DROP_INDEX_NAMES = ["isPrinted_1", "hasPdf_1", "orderSn_1"];

function maskUri(raw) {
  return raw.replace(/:\/\/([^:]+):([^@]+)@/, "://$1:***@");
}

async function dropIndexSafe(col, name) {
  try {
    const existing = await col.indexes();
    const hit = existing.find((idx) => idx.name === name);
    if (!hit) {
      console.log(`[optimize_indexes] Skip drop — không tồn tại: ${name}`);
      return { name, status: "missing" };
    }
    console.log(`[optimize_indexes] Đang xóa index: ${name} …`);
    await col.dropIndex(name);
    console.log(`[optimize_indexes] Đã xóa index: ${name}`);
    return { name, status: "dropped" };
  } catch (err) {
    const msg = err?.message || String(err);
    if (/index not found|ns not found|can't find index/i.test(msg)) {
      console.log(`[optimize_indexes] Skip drop — không tồn tại: ${name}`);
      return { name, status: "missing" };
    }
    console.error(`[optimize_indexes] LỖI khi xóa ${name}:`, msg);
    return { name, status: "error", error: msg };
  }
}

async function main() {
  if (!URI) {
    console.error(
      "[optimize_indexes] THIẾU MONGODB_URI / MONGO_URL / MONGO_URI trong .env — dừng.",
    );
    process.exit(1);
  }

  console.log(`[optimize_indexes] Connecting: ${maskUri(URI)}`);
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 20_000 });
  console.log("[optimize_indexes] MongoDB connected.");

  const db = mongoose.connection.db;
  if (!db) {
    console.error("[optimize_indexes] connection.db = null — dừng.");
    process.exit(1);
  }

  const col = db.collection("orders");

  console.log("\n=== Bước 1: Liệt kê index hiện tại ===");
  const before = await col.indexes();
  for (const idx of before) {
    console.log(`  - ${idx.name}: ${JSON.stringify(idx.key)}`);
  }

  console.log("\n=== Bước 2: Drop index cũ không cần thiết ===");
  const dropResults = [];
  for (const name of DROP_INDEX_NAMES) {
    dropResults.push(await dropIndexSafe(col, name));
  }
  const dropErrors = dropResults.filter((r) => r.status === "error");
  if (dropErrors.length) {
    console.error(
      `[optimize_indexes] Có ${dropErrors.length} lỗi khi drop — dừng trước syncIndexes.`,
    );
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log("\n=== Bước 3: Đăng ký Schema + OrderModel.syncIndexes() ===");
  // initMongo: ensureModels + syncIndexes orders (và product nếu không disk-mode).
  const { initMongo } = await import("../src/db/mongoStore.ts");
  const ok = await initMongo(ROOT);
  if (!ok && mongoose.connection.readyState !== 1) {
    console.error("[optimize_indexes] initMongo thất bại / chưa ready — dừng.");
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  }

  const OrderModel = mongoose.models.Order;
  if (!OrderModel) {
    console.error("[optimize_indexes] Không lấy được mongoose.models.Order — dừng.");
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  }

  try {
    console.log("[optimize_indexes] Đang chạy OrderModel.syncIndexes() (lần tường minh) …");
    const synced = await OrderModel.syncIndexes();
    console.log(
      "[optimize_indexes] syncIndexes() xong.",
      Array.isArray(synced) && synced.length
        ? `indexesDroppedBySync=${JSON.stringify(synced)}`
        : "không drop thêm index nào qua sync",
    );
  } catch (err) {
    console.error("[optimize_indexes] LỖI syncIndexes():", err?.message || err);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  }

  console.log("\n=== Bước 4: Index sau khi tối ưu ===");
  const after = await col.indexes();
  for (const idx of after) {
    console.log(`  - ${idx.name}: ${JSON.stringify(idx.key)}`);
  }

  const names = new Set(after.map((i) => i.name));
  const checks = [
    { name: "orderSn_unique", ok: names.has("orderSn_unique") },
    {
      name: "compound hasPdf + isPrinted",
      ok: after.some(
        (i) =>
          i.key &&
          Object.keys(i.key).length === 2 &&
          i.key.hasPdf === 1 &&
          i.key.isPrinted === 1,
      ),
    },
    {
      name: "last_shopee_update_at: -1",
      ok: after.some((i) => i.key && i.key.last_shopee_update_at === -1),
    },
    {
      name: "đã bỏ isPrinted_1 / hasPdf_1 / orderSn_1",
      ok:
        !names.has("isPrinted_1") &&
        !names.has("hasPdf_1") &&
        !names.has("orderSn_1"),
    },
  ];

  console.log("\n=== Kiểm tra ===");
  let allOk = true;
  for (const c of checks) {
    console.log(`  ${c.ok ? "OK" : "FAIL"} — ${c.name}`);
    if (!c.ok) allOk = false;
  }

  await mongoose.disconnect().catch(() => {});
  console.log(
    allOk
      ? "\n[optimize_indexes] HOÀN TẤT — index orders đã tối ưu."
      : "\n[optimize_indexes] XONG NHƯNG có mục kiểm tra FAIL — xem log trên.",
  );
  process.exit(allOk ? 0 : 1);
}

main().catch(async (err) => {
  console.error("[optimize_indexes] FATAL:", err?.message || err);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
