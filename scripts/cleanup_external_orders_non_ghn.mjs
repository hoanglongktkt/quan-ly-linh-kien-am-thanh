#!/usr/bin/env node
/**
 * ONE-SHOT — xóa đơn ngoại sàn KHÔNG phải GHN (dữ liệu test SPX/self/khác).
 * Giữ nguyên đơn GHN (Giao Hàng Nhanh).
 *
 * Chạy:
 *   node scripts/cleanup_external_orders_non_ghn.mjs
 *   node scripts/cleanup_external_orders_non_ghn.mjs --dry-run
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "node:path";

const ROOT = process.cwd();
dotenv.config({ path: path.join(ROOT, ".env") });

const URI = String(
  process.env.MONGODB_URI || process.env.MONGO_URL || process.env.MONGO_URI || "",
).trim();
const dryRun = process.argv.includes("--dry-run");

if (!URI) {
  console.error("[cleanup] THIẾU MONGODB_URI / MONGO_URL trong .env — dừng.");
  process.exit(1);
}

const masked = URI.replace(/:\/\/([^:]+):([^@]+)@/, "://$1:***@");

/** Đơn ngoại sàn — cùng filter tab external_orders trong app. */
const externalOrderFilter = {
  $or: [{ channel: "manual" }, { "data.channel": "manual" }],
};

/** Nhận diện GHN — khớp findOpenGhnExternalOrdersFromStore + shipping_carrier hiển thị. */
const isGhnClause = {
  $or: [
    { "data.provider": { $regex: /^ghn$/i } },
    { "data.carrier": { $regex: /^ghn$/i } },
    { "data.shipping_carrier": { $regex: /giao\s*h[àa]ng\s*nhanh|^ghn$/i } },
  ],
};

/** Xóa: ngoại sàn AND không phải GHN. */
const deleteFilter = {
  $and: [externalOrderFilter, { $nor: [isGhnClause] }],
};

console.log(`[cleanup] Kết nối MongoDB: ${masked}`);
if (dryRun) console.log("[cleanup] Chế độ --dry-run: chỉ đếm, không xóa.");

await mongoose.connect(URI, { serverSelectionTimeoutMS: 20_000 });
const col = mongoose.connection.db.collection("orders");

const totalExternal = await col.countDocuments(externalOrderFilter);
const toDelete = await col.countDocuments(deleteFilter);
const keepGhn = totalExternal - toDelete;

console.log(`[cleanup] Tổng đơn ngoại sàn (manual): ${totalExternal}`);
console.log(`[cleanup] Sẽ GIỮ (GHN): ${keepGhn}`);
console.log(`[cleanup] Sẽ XÓA (không phải GHN): ${toDelete}`);

if (toDelete > 0) {
  const samples = await col
    .find(deleteFilter, { projection: { orderSn: 1, "data.orderSn": 1, "data.provider": 1, "data.carrier": 1 } })
    .limit(8)
    .toArray();
  const snList = samples.map((d) => {
    const sn = d.orderSn || d.data?.orderSn || d._id;
    const p = d.data?.provider || d.data?.carrier || "?";
    return `${sn} (${p})`;
  });
  console.log(`[cleanup] Mẫu sẽ xóa (tối đa 8): ${snList.join(", ") || "(none)"}`);
}

if (toDelete === 0) {
  console.log("[cleanup] Không có đơn nào cần xóa. Hoàn tất.");
  await mongoose.disconnect();
  process.exit(0);
}

if (dryRun) {
  console.log("[cleanup] --dry-run: bỏ qua deleteMany.");
  await mongoose.disconnect();
  process.exit(0);
}

const result = await col.deleteMany(deleteFilter);
console.log(`[cleanup] deleteMany OK — deletedCount=${result.deletedCount}`);

const remaining = await col.countDocuments(deleteFilter);
const ghnAfter = await col.countDocuments({ $and: [externalOrderFilter, isGhnClause] });
console.log(`[cleanup] Còn đơn ngoại sàn không-GHN: ${remaining}`);
console.log(`[cleanup] Còn đơn ngoại sàn GHN: ${ghnAfter}`);
console.log("[cleanup] Hoàn tất.");

await mongoose.disconnect();
process.exit(0);
