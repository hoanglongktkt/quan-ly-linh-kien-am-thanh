#!/usr/bin/env node
/**
 * Xóa HẾT đơn đang match tab "ĐÃ GIAO CHO ĐVVC" (deleteMany, không LIMIT).
 * Điều kiện = matchesHandedOverCarrierTab (cùng UI).
 * Chạy: node scripts/cleanup-handed-over-orders.mjs
 */
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import mongoose from "mongoose";

const ROOT = process.cwd();
dotenv.config({ path: path.join(ROOT, ".env") });

const ORDERS_PATH = path.join(ROOT, "data", "orders.json");
const MARKER_PATH = path.join(ROOT, "data", ".cleanup-handed-over-v2");
const URI = String(process.env.MONGODB_URI || process.env.MONGO_URL || "").trim();

function truthyFlag(v) {
  return v === true || v === 1 || v === "1" || String(v).toLowerCase() === "true";
}

function resolveLocalStatus(order) {
  const raw = String(order?.local_status ?? order?.localStatus ?? "").toUpperCase();
  if (raw === "HANDED_OVER" || raw === "CANCELLED_STORED" || raw === "RETURN_RECEIVED") {
    return raw;
  }
  if (truthyFlag(order?.isHandedOverToCarrier) || truthyFlag(order?.is_handed_over_to_carrier)) {
    return "HANDED_OVER";
  }
  return "NONE";
}

/** Giống matchesHandedOverCarrierTab / matchesHandedOverCarrierTabOrder trên server. */
function matchesHandedOverCarrierTab(order) {
  if (!order || typeof order !== "object") return false;
  const handed =
    resolveLocalStatus(order) === "HANDED_OVER" ||
    truthyFlag(order.isHandedOverToCarrier) ||
    truthyFlag(order.is_handed_over_to_carrier);
  if (!handed) return false;

  const raw = String(
    order.shopee_order_status || order.order_status || order.shopeeOrderStatus || "",
  ).toUpperCase();
  if (
    raw === "SHIPPED" ||
    raw === "TO_CONFIRM_RECEIVE" ||
    raw === "COMPLETED" ||
    order.status === "shipping" ||
    order.status === "completed"
  ) {
    return false;
  }
  if (
    raw === "CANCELLED" ||
    raw === "IN_CANCEL" ||
    raw === "TO_RETURN" ||
    order.status === "cancelled" ||
    order.status === "return_pending" ||
    order.status === "return_received"
  ) {
    return false;
  }
  return true;
}

/** Mongo filter bao quát mọi biến thể cờ tab ĐVVC. */
function handedOverMongoFilter() {
  return {
    $or: [
      { "data.local_status": { $regex: /^HANDED_OVER$/i } },
      { "data.localStatus": { $regex: /^HANDED_OVER$/i } },
      { "data.isHandedOverToCarrier": { $in: [true, "true", 1, "1"] } },
      { "data.is_handed_over_to_carrier": { $in: [true, "true", 1, "1"] } },
      { local_status: { $regex: /^HANDED_OVER$/i } },
      { is_handed_over_to_carrier: { $in: [true, "true", 1, "1"] } },
      { isHandedOverToCarrier: { $in: [true, "true", 1, "1"] } },
      { status: "handed_over" },
      { "data.status": "handed_over" },
    ],
  };
}

function cleanupJson() {
  if (!fs.existsSync(ORDERS_PATH)) {
    console.log("⏭  Không có data/orders.json");
    return { removed: 0, sns: [], kept: 0, ids: [] };
  }
  const raw = fs.readFileSync(ORDERS_PATH, "utf8");
  const orders = raw.trim() ? JSON.parse(raw) : [];
  if (!Array.isArray(orders)) throw new Error("orders.json không phải mảng");

  const garbage = orders.filter(matchesHandedOverCarrierTab);
  const kept = orders.filter((o) => !matchesHandedOverCarrierTab(o));
  const sns = garbage.map((o) => String(o.orderSn || o.id || "")).filter(Boolean);
  const ids = garbage.map((o) => String(o.id || "")).filter(Boolean);

  console.log(`[JSON] matched tab ĐVVC count: ${garbage.length}`);
  if (garbage.length > 0) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.copyFileSync(ORDERS_PATH, `${ORDERS_PATH}.bak-handed-v2-${stamp}`);
    fs.writeFileSync(ORDERS_PATH, JSON.stringify(kept), "utf8");
  }
  console.log(`Deleted count (JSON): ${garbage.length}`);
  console.log(`✅ JSON: xóa ${garbage.length} đơn, còn ${kept.length}. SN: ${sns.join(", ") || "(none)"}`);
  return { removed: garbage.length, sns, kept: kept.length, ids };
}

async function cleanupMongo() {
  if (!URI) {
    console.log("⏭  Bỏ qua MongoDB (thiếu MONGODB_URI)");
    return { deleted: 0, sns: [] };
  }
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 20000 });
  const col = mongoose.connection.db.collection("orders");
  const filter = handedOverMongoFilter();

  const matched = await col.find(filter).project({ _id: 1, orderSn: 1, "data.orderSn": 1 }).toArray();
  const sns = [
    ...new Set(
      matched
        .map((d) => String(d.orderSn || d.data?.orderSn || d._id || "").trim())
        .filter(Boolean),
    ),
  ];
  console.log(`[Mongo] matched tab-ĐVVC-like count: ${matched.length}`);

  // deleteMany — tuyệt đối không deleteOne / LIMIT
  const result = await col.deleteMany(filter);
  const deleted = Number(result.deletedCount || 0);
  console.log(`Deleted count (Mongo): ${deleted}`);
  console.log(`Deleted count: ${deleted}`);
  console.log(`✅ Mongo deleteMany — deleted=${deleted} sns=${sns.join(", ") || "(none)"}`);

  await mongoose.disconnect();
  return { deleted, sns };
}

console.log("=== CLEANUP v2 ĐÃ GIAO CHO ĐVVC (deleteMany + tab condition) ===");
// Xóa marker v1 để server không bị skip sai
for (const p of [
  path.join(ROOT, "data", ".cleanup-handed-over-v1"),
  MARKER_PATH,
]) {
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    /* ignore */
  }
}

const jsonResult = cleanupJson();
const mongoResult = await cleanupMongo();
const total = jsonResult.removed + mongoResult.deleted;
const allSns = [...new Set([...jsonResult.sns, ...mongoResult.sns])];

fs.mkdirSync(path.dirname(MARKER_PATH), { recursive: true });
fs.writeFileSync(
  MARKER_PATH,
  JSON.stringify(
    {
      at: new Date().toISOString(),
      jsonRemoved: jsonResult.removed,
      mongoDeleted: mongoResult.deleted,
      totalDeleted: total,
      sns: allSns,
    },
    null,
    2,
  ),
  "utf8",
);

console.log(`Deleted count (TOTAL): ${total}`);
console.log(`🗒  Marker: ${MARKER_PATH}`);
console.log("=== XONG ===");
