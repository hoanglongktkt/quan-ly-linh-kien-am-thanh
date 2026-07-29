import dotenv from "dotenv";
import mongoose from "mongoose";

// Nạp .env sớm (local/cPanel). Trên Vercel dùng Environment Variables của platform.
try {
  dotenv.config();
} catch {
  /* ignore */
}

/**
 * Options kết nối Mongo — SSOT dùng chung cho MVC (config/db) và mongoStore.initMongo.
 * Giữ nguyên bộ options đã ổn định trên cPanel (maxPoolSize 15, fail-fast 5s).
 */
export const MONGO_CONNECT_OPTIONS = {
  serverSelectionTimeoutMS: 5000,
  connectTimeoutMS: 5000,
  socketTimeoutMS: 15000,
  maxPoolSize: 15,
  minPoolSize: 1,
  waitQueueTimeoutMS: 5000,
  maxIdleTimeMS: 30000,
};

/**
 * Kết nối MongoDB Atlas.
 * serverSelectionTimeoutMS: 5000 — fail nhanh, không treo boot/request.
 */
export function getMongoUri() {
  return String(
    process.env.MONGODB_URI ||
      process.env.MONGO_URL ||
      process.env.MONGO_URI ||
      "",
  ).trim();
}

export async function connectDB() {
  const uri = getMongoUri();
  if (!uri) {
    throw new Error("Thiếu MONGODB_URI / MONGO_URL trong biến môi trường.");
  }

  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  mongoose.set("strictQuery", true);

  try {
    await mongoose.connect(uri, MONGO_CONNECT_OPTIONS);
  } catch (err) {
    const msg = err?.message || String(err);
    throw new Error(
      /serverSelection|ENOTFOUND|ECONNREFUSED|ETIMEOUT|MongoNetwork/i.test(msg)
        ? "Lỗi kết nối MongoDB / mạng. Kiểm tra Atlas và biến MONGODB_URI."
        : msg || "Không kết nối được MongoDB.",
    );
  }

  console.log("[DB] MongoDB Connected Successfully");
  return mongoose.connection;
}

export function isDBReady() {
  return mongoose.connection.readyState === 1;
}

export default connectDB;
