import dotenv from "dotenv";
import mongoose from "mongoose";

// Nạp .env sớm (local/cPanel). Trên Vercel dùng Environment Variables của platform.
try {
  dotenv.config();
} catch {
  /* ignore */
}

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
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      maxPoolSize: 10,
    });
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
