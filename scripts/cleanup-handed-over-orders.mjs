#!/usr/bin/env node
/**
 * Xóa sạch đơn kẹt tab "ĐÃ GIAO CHO ĐVVC" (cờ HANDED_OVER / is_handed_over_to_carrier).
 * Chạy: node scripts/cleanup-handed-over-orders.mjs
 */
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import mongoose from "mongoose";

const ROOT = process.cwd();
dotenv.config({ path: path.join(ROOT, ".env") });

const ORDERS_PATH = path.join(ROOT, "data", "orders.json");
const MARKER_PATH = path.join(ROOT, "data", ".cleanup-handed-over-v1");
const URI = String(process.env.MONGODB_URI || process.env.MONGO_URL || "").trim();

function isHandedOverGarbage(order) {
  if (!order || typeof order !== "object") return false;
  const local = String(order.local_status || order.localStatus || "").toUpperCase();
  return (
    local === "HANDED_OVER" ||
    order.isHandedOverToCarrier === true ||
    order.is_handed_over_to_carrier === true
  );
}

function cleanupJson() {
  if (!fs.existsSync(ORDERS_PATH)) {
    console.log("⏭  Không có data/orders.json");
    return { removed: 0, sns: [], kept: 0 };
  }
  const raw = fs.readFileSync(ORDERS_PATH, "utf8");
  const orders = raw.trim() ? JSON.parse(raw) : [];
  if (!Array.isArray(orders)) throw new Error("orders.json không phải mảng");
  const garbage = orders.filter(isHandedOverGarbage);
  const kept = orders.filter((o) => !isHandedOverGarbage(o));
  const sns = garbage.map((o) => String(o.orderSn || o.id || "")).filter(Boolean);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  if (garbage.length > 0) {
    fs.copyFileSync(ORDERS_PATH, `${ORDERS_PATH}.bak-handed-${stamp}`);
  }
  fs.writeFileSync(ORDERS_PATH, JSON.stringify(kept), "utf8");
  console.log(`✅ JSON: xóa ${garbage.length} đơn, còn ${kept.length}. SN: ${sns.join(", ") || "(none)"}`);
  return { removed: garbage.length, sns, kept: kept.length, garbage };
}

async function cleanupMongo(garbage) {
  if (!URI) {
    console.log("⏭  Bỏ qua MongoDB (thiếu MONGODB_URI)");
    return 0;
  }
  if (!garbage.length) {
    // Vẫn xóa theo filter cờ trên Mongo (production có thể chỉ có Mongo).
  }
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 20000 });
  const col = mongoose.connection.db.collection("orders");
  const filter = {
    $or: [
      { "data.local_status": "HANDED_OVER" },
      { "data.localStatus": "HANDED_OVER" },
      { "data.isHandedOverToCarrier": true },
      { "data.is_handed_over_to_carrier": true },
      { local_status: "HANDED_OVER" },
      { is_handed_over_to_carrier: true },
    ],
  };
  const before = await col.countDocuments(filter);
  const result = await col.deleteMany(filter);
  await mongoose.disconnect();
  console.log(`✅ Mongo: matched=${before} deleted=${result.deletedCount || 0}`);
  return Number(result.deletedCount || 0);
}

console.log("=== CLEANUP ĐÃ GIAO CHO ĐVVC (HANDED_OVER) ===");
const jsonResult = cleanupJson();
const mongoDeleted = await cleanupMongo(jsonResult.garbage || []);
fs.mkdirSync(path.dirname(MARKER_PATH), { recursive: true });
fs.writeFileSync(
  MARKER_PATH,
  JSON.stringify(
    {
      at: new Date().toISOString(),
      jsonRemoved: jsonResult.removed,
      mongoDeleted,
      sns: jsonResult.sns,
    },
    null,
    2,
  ),
  "utf8",
);
console.log(`🗒  Marker: ${MARKER_PATH}`);
console.log("=== XONG ===");
