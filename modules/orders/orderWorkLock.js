// Module miền nghiệp vụ; giữ nguyên hành vi và trạng thái dùng chung.
import crypto from "node:crypto";
import mongoose from "mongoose";
import os from "node:os";
import { isOwnerProcessDead } from "../shopee-sync/syncOrchestrator.js";
const completedOwners = new Map();

/** _id duy nhất theo shop + đơn; không tự hết hạn khi worker còn chạy. */
export async function withOrderWorkLock(shopId, orderSn, work) {
  if (!/^\d+$/.test(String(shopId)) || !/^[a-zA-Z0-9-]+$/.test(String(orderSn))) {
    throw new Error("webhook_order_key_invalid");
  }
  const db = mongoose.connection.db;
  if (mongoose.connection.readyState !== 1 || !db) throw new Error("mongodb_not_ready");
  const locks = db.collection("shopee_order_work_locks");
  const key = `${shopId}:${orderSn}`;
  const owner = crypto.randomUUID();
  if (completedOwners.has(key)) {
    // Chỉ thử nhả khóa mà process này biết chắc Promise đã kết thúc.
    await locks.deleteOne({ _id: key, owner: completedOwners.get(key) });
    completedOwners.delete(key);
  }
  const previous = await locks.findOne({ _id: key });
  if (previous && isOwnerProcessDead(previous)) {
    // Chỉ xóa khóa tồn dư khi worker cũ đã chết, không dựa trên tuổi khóa.
    await locks.deleteOne({ _id: key, owner: previous.owner });
  }
  try {
    await locks.insertOne({ _id: key, owner, pid: process.pid, hostname: os.hostname(), acquiredAt: new Date(), heartbeatAt: new Date() });
  } catch (error) {
    if (error?.code === 11000) throw new Error("order_work_locked");
    throw error;
  }
  // Heartbeat phục vụ giám sát; khóa chỉ nhả trong finally, không bị cướp theo TTL.
  const heartbeat = setInterval(() => {
    void locks.updateOne({ _id: key, owner }, { $set: { heartbeatAt: new Date() } })
      .catch(() => console.warn("[OrderWorkLock] heartbeat_failed"));
  }, 30_000);
  heartbeat.unref?.();
  try {
    // Khóa bao trùm toàn bộ fetch, shallow, detail và cập nhật hoàn/hủy.
    return await work();
  } finally {
    clearInterval(heartbeat);
    try { await locks.deleteOne({ _id: key, owner }); }
    catch (error) { completedOwners.set(key, owner); throw error; }
  }
}
