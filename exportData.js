#!/usr/bin/env node
/**
 * Xuất 10 đơn hàng mới nhất từ MongoDB collection `orders`.
 *
 *   node exportData.js
 */
import mongoose from "mongoose";
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

const ROOT = process.cwd();
dotenv.config({ path: path.join(ROOT, ".env") });

const URI = String(process.env.MONGODB_URI || process.env.MONGO_URL || "").trim();
const OUT_FILE = path.join(ROOT, "orders-sample.json");

async function main() {
  if (!URI) {
    console.error("❌ Thiếu MONGODB_URI (hoặc MONGO_URL) trong file .env");
    process.exit(1);
  }

  console.log("🔌 Đang kết nối MongoDB...");
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 15000 });

  const db = mongoose.connection.db;
  const orders = await db
    .collection("orders")
    .find({})
    .sort({ "data.date": -1, _id: -1 })
    .limit(10)
    .toArray();

  fs.writeFileSync(OUT_FILE, JSON.stringify(orders, null, 2), "utf8");

  console.log(`✅ Đã xuất ${orders.length} bản ghi → ${OUT_FILE}`);
  if (orders.length > 0) {
    const preview = orders.map((o) => ({
      _id: o._id,
      orderSn: o.orderSn ?? o.data?.orderSn ?? null,
      status: o.status ?? o.shopee_order_status ?? null,
      date: o.data?.date ?? null,
    }));
    console.log("📋 Preview:");
    console.table(preview);
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("❌ Lỗi:", err?.message || err);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
