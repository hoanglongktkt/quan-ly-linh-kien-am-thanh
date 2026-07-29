import mongoose from "mongoose";

/**
 * Kết nối MongoDB Atlas.
 * serverSelectionTimeoutMS: 5000 — fail nhanh, không treo boot/request.
 */
export async function connectDB() {
  const uri = String(process.env.MONGODB_URI || process.env.MONGO_URL || "").trim();
  if (!uri) {
    throw new Error("Thiếu MONGODB_URI / MONGO_URL trong biến môi trường.");
  }

  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  mongoose.set("strictQuery", true);

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 5000,
    socketTimeoutMS: 45000,
    maxPoolSize: 10,
  });

  console.log("[DB] MongoDB Connected Successfully");
  return mongoose.connection;
}

export function isDBReady() {
  return mongoose.connection.readyState === 1;
}

export default connectDB;
