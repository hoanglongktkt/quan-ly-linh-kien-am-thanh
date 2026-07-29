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

/** Mutex singleton — tránh gọi mongoose.connect song song khi readyState=2 (connecting). */
let connectPromise = null;

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

  // Đã connected → trả connection hiện có (không tạo pool mới).
  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  // Đang connecting / lần gọi trước chưa xong → chờ cùng 1 promise.
  if (connectPromise) {
    return connectPromise;
  }

  mongoose.set("strictQuery", true);

  connectPromise = (async () => {
    try {
      // readyState 2 = connecting — mongoose.connect() sẽ await cùng handshake.
      if (mongoose.connection.readyState !== 1) {
        await mongoose.connect(uri, MONGO_CONNECT_OPTIONS);
      }
      console.log("[DB] MongoDB Connected Successfully");
      return mongoose.connection;
    } catch (err) {
      connectPromise = null; // Cho phép retry lần sau
      const msg = err?.message || String(err);
      throw new Error(
        /serverSelection|ENOTFOUND|ECONNREFUSED|ETIMEOUT|MongoNetwork/i.test(msg)
          ? "Lỗi kết nối MongoDB / mạng. Kiểm tra Atlas và biến MONGODB_URI."
          : msg || "Không kết nối được MongoDB.",
      );
    }
  })();

  return connectPromise;
}

export function isDBReady() {
  return mongoose.connection.readyState === 1;
}

export default connectDB;
