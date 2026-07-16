#!/usr/bin/env node
/**
 * Xóa sạch dữ liệu ảo trên backend.
 * Products + channel_listings: MongoDB Atlas.
 * Còn lại: JSON trong data/.
 *
 *   npm run wipe:dummy-data
 */
import mongoose from "mongoose";
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

const ROOT = process.cwd();
dotenv.config({ path: path.join(ROOT, ".env") });

const DATA_DIR = path.join(ROOT, "data");
const URI = String(process.env.MONGODB_URI || process.env.MONGO_URL || "").trim();

const WIPE_FILES = [
  "orders.json",
  "imports.json",
  "multi_channel_listings.json",
  "product_listings.json",
  "suppliers.json",
  "expenses.json",
  "channel_listings.json",
  "products.json",
  "local_inventory.json",
];

const PRESERVE_FILES = new Set(["shopee_tokens.json"]);
const MARKERS_TO_REMOVE = [".expenses-cleared-v2"];
const withBackup = process.argv.includes("--backup");

async function wipeMongo() {
  if (!URI) {
    console.log("⏭  Bỏ qua MongoDB (thiếu MONGODB_URI)");
    return;
  }
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 15000 });
  const db = mongoose.connection.db;
  const prevProducts = await db.collection("products").countDocuments();
  const prevListings = await db.collection("channel_listings").countDocuments();
  await db.collection("products").deleteMany({});
  await db.collection("channel_listings").deleteMany({});
  await mongoose.disconnect();
  console.log(
    `✅ Đã xóa MongoDB products (trước: ${prevProducts}) + channel_listings (trước: ${prevListings})`
  );
}

function wipeFile(filename) {
  if (PRESERVE_FILES.has(filename)) {
    console.log(`⏭  Bỏ qua (giữ nguyên): ${filename}`);
    return;
  }
  const filePath = path.join(DATA_DIR, filename);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(filePath)) {
    console.log(`⏭  Không tồn tại: ${filename}`);
    return;
  }
  if (withBackup) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.copyFileSync(filePath, `${filePath}.bak-${stamp}`);
  }
  fs.writeFileSync(filePath, "[]\n", "utf8");
  console.log(`✅ Đã xóa: ${filename}`);
}

console.log("=== WIPE DUMMY DATA ===");
await wipeMongo();
for (const f of WIPE_FILES) wipeFile(f);
for (const marker of MARKERS_TO_REMOVE) {
  const markerPath = path.join(DATA_DIR, marker);
  if (fs.existsSync(markerPath)) {
    fs.unlinkSync(markerPath);
    console.log(`🗑  Đã xóa marker: ${marker}`);
  }
}
console.log("=== XONG ===");
