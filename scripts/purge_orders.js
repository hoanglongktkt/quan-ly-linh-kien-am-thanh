/**
 * HARD PURGE — xóa sạch collection `orders` trên MongoDB thực tế.
 * Chạy: node scripts/purge_orders.js
 */
import "dotenv/config";
import mongoose from "mongoose";

const uri = String(process.env.MONGODB_URI || process.env.MONGO_URL || "").trim();

if (!uri) {
  console.error("[PURGE] THIẾU MONGODB_URI / MONGO_URL — dừng.");
  process.exit(1);
}

const masked = uri.replace(/:\/\/([^:]+):([^@]+)@/, "://$1:***@");
console.log(`[PURGE] Connecting: ${masked}`);

await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
const db = mongoose.connection.db;
const col = db.collection("orders");

const before = await col.countDocuments();
console.log(`[PURGE] orders trước xóa: ${before}`);

const result = await col.deleteMany({});
console.log(`[PURGE] deleteMany OK — deletedCount=${result.deletedCount}`);

const after = await col.countDocuments();
console.log(`[PURGE] orders sau xóa: ${after}`);

if (after !== 0) {
  console.error("[PURGE] THẤT BẠI — collection orders chưa về 0!");
  await mongoose.disconnect();
  process.exit(1);
}

console.log("[PURGE] XÁC NHẬN: collection orders = 0 document.");
await mongoose.disconnect();
process.exit(0);
