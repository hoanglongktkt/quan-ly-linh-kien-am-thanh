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
 * socketTimeoutMS đủ dài cho pull đơn / bulkWrite; fail-fast khi chọn server.
 */
export const MONGO_CONNECT_OPTIONS = {
  serverSelectionTimeoutMS: 10_000,
  connectTimeoutMS: 10_000,
  // "connection N to host:27017 timed out" thường do socketTimeout quá ngắn khi bulkWrite.
  socketTimeoutMS: 60_000,
  maxPoolSize: 10,
  minPoolSize: 1,
  waitQueueTimeoutMS: 10_000,
  maxIdleTimeMS: 60_000,
  heartbeatFrequencyMS: 10_000,
  // Ưu tiên IPv4 — tránh treo dual-stack trên một số host cPanel.
  family: 4,
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
        /serverSelection|ENOTFOUND|ECONNREFUSED|ETIMEOUT|ETIMEDOUT|MongoNetwork|timed out|27017/i.test(
          msg,
        )
          ? "Lỗi kết nối MongoDB / mạng (timeout tới DB). Kiểm tra IP whitelist, firewall và biến MONGODB_URI."
          : msg || "Không kết nối được MongoDB.",
      );
    }
  })();

  return connectPromise;
}

/**
 * Ép reconnect khi pool chết / socket timeout (readyState vẫn có thể = 1 giả).
 * Dùng sau lỗi "connection N to host:27017 timed out".
 */
export async function reconnectDB() {
  connectPromise = null;
  try {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.close().catch(() => {});
    }
  } catch {
    /* ignore */
  }
  return connectDB();
}

export function isDBReady() {
  return mongoose.connection.readyState === 1;
}

/** Nhận diện lỗi timeout / mất kết nối Mongo (kể cả "connection N to IP:27017 timed out"). */
export function isMongoTimeoutOrNetworkError(err) {
  const msg = String(err?.message || err || "");
  const name = String(err?.name || "");
  return /serverSelection|ServerSelectionError|MongoServerSelectionError|MongoNetworkTimeoutError|MongoNetworkError|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ETIMEOUT|timed out|timeout|27017|topology was destroyed|connection.*closed|pool destroyed/i.test(
    `${msg} ${name}`,
  );
}

export default connectDB;
