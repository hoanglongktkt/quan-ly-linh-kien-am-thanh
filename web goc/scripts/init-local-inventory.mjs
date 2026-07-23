/**
 * Kiểm tra kết nối MongoDB Atlas (products + channel_listings).
 * Chạy: node scripts/init-local-inventory.mjs
 */
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(APP_ROOT, ".env") });

const URI = String(process.env.MONGODB_URI || process.env.MONGO_URL || "").trim();

if (!URI) {
  console.error("[init] Thiếu MONGODB_URI trong .env");
  process.exit(1);
}

await mongoose.connect(URI, { serverSelectionTimeoutMS: 15000 });
const db = mongoose.connection.db;
const products = await db.collection("products").countDocuments();
const listings = await db.collection("channel_listings").countDocuments();
console.log(`[init] MongoDB OK — products=${products}, listings=${listings}`);
await mongoose.disconnect();
