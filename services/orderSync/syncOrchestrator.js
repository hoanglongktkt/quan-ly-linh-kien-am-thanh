import { safeError } from "../../utils/safeProductionLog.js";
/**
 * Mongo-backed coordinator for Shopee order synchronization.
 *
 * Passenger can run more than one Node process. An in-memory boolean is not
 * enough to prevent two processes from pulling the same shops concurrently,
 * therefore the lease is stored in MongoDB. Watermarks are intentionally kept
 * separately per shop so a future per-shop pull can use the exact cursor.
 */
import crypto from "crypto";
import mongoose from "mongoose";
import os from "node:os";

/** Chỉ phục hồi khi hệ điều hành xác nhận process trên cùng máy đã chết. */
export function isOwnerProcessDead(lock) {
  if (lock?.hostname !== os.hostname() || !Number.isInteger(lock?.pid) || lock.pid <= 0) return false;
  try { process.kill(lock.pid, 0); return false; }
  catch (error) { return error?.code === "ESRCH"; }
}

const LOCK_ID = "shopee_orders_global";
const LOCK_COLLECTION = "sync_orchestrator_locks";
const WATERMARK_COLLECTION = "sync_orchestrator_watermarks";
const DEFAULT_LEASE_MS = 12 * 60 * 1000;
const DEFAULT_OVERLAP_SEC = 5 * 60;
const DEFAULT_BOOTSTRAP_LOOKBACK_SEC = 2 * 60 * 60;

function numberInRange(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function leaseMs() {
  return numberInRange(
    process.env.SHOPEE_SYNC_ORCHESTRATOR_LEASE_MS,
    DEFAULT_LEASE_MS,
    2 * 60 * 1000,
    30 * 60 * 1000,
  );
}

function overlapSec() {
  return numberInRange(
    process.env.SHOPEE_SYNC_WATERMARK_OVERLAP_SEC,
    DEFAULT_OVERLAP_SEC,
    60,
    30 * 60,
  );
}

function database() {
  if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) return null;
  return mongoose.connection.db;
}

async function ensureIndexes() {
  const db = database();
  if (!db) return false;
  await Promise.all([
    db.collection(LOCK_COLLECTION).createIndex({ expiresAt: 1 }),
    db.collection(WATERMARK_COLLECTION).createIndex({ updatedAt: -1 }),
  ]);
  return true;
}

/** Acquire one cross-process lease. Never steals an unexpired lease. */
export async function acquireShopeeSyncLease(trigger = "unknown") {
  const db = database();
  if (!db) return { acquired: false, reason: "mongodb_not_ready" };
  const now = new Date();
  const owner = `${process.pid}:${crypto.randomUUID()}`;
  const expiresAt = new Date(now.getTime() + leaseMs());
  try {
    await ensureIndexes();
    const previous = await db.collection(LOCK_COLLECTION).findOne({ _id: LOCK_ID });
    if (previous?.owner && isOwnerProcessDead(previous)) {
      // CAS theo owner cũ: không nhả nhầm khóa của process vừa nhận việc.
      await db.collection(LOCK_COLLECTION).updateOne(
        { _id: LOCK_ID, owner: previous.owner },
        { $set: { owner: null, expiresAt: new Date(0), recoveredAt: now } },
      );
      console.warn("[SyncOrchestrator] recovered_dead_process_lock");
    }
    const result = await db.collection(LOCK_COLLECTION).findOneAndUpdate(
      {
        _id: LOCK_ID,
        // Khóa còn owner không bị cướp khi tác vụ kéo dài hoặc DB mất kết nối.
        $or: [{ owner: null }, { owner: { $exists: false } }, { expiresAt: new Date(0) }],
      },
      {
        $set: { owner, hostname: os.hostname(), pid: process.pid, trigger: String(trigger), acquiredAt: now, expiresAt, heartbeatAt: now },
      },
      { upsert: false, returnDocument: "after" },
    );
    const claimed = result?.value ?? result;
    if (claimed?.owner === owner) return { acquired: true, owner, expiresAt };

    // First ever lease has no document yet. Unique _id makes the insert race safe.
    try {
      await db.collection(LOCK_COLLECTION).insertOne({
        _id: LOCK_ID,
        owner,
        hostname: os.hostname(),
        pid: process.pid,
        trigger: String(trigger),
        acquiredAt: now,
        expiresAt,
        heartbeatAt: now,
      });
      return { acquired: true, owner, expiresAt };
    } catch (insertErr) {
      if (insertErr?.code === 11000) return { acquired: false, reason: "lease_held" };
      throw insertErr;
    }
  } catch (err) {
    console.error("[SyncOrchestrator] acquire lease failed:", safeError(err));
    return { acquired: false, reason: "lease_error" };
  }
}

export async function renewShopeeSyncLease(owner) {
  const db = database();
  if (!db || !owner) return false;
  const now = new Date();
  const result = await db.collection(LOCK_COLLECTION).updateOne(
    { _id: LOCK_ID, owner },
    { $set: { heartbeatAt: now, expiresAt: new Date(now.getTime() + leaseMs()) } },
  );
  return result.modifiedCount === 1;
}

export async function releaseShopeeSyncLease(owner) {
  const db = database();
  if (!db || !owner) return;
  await db.collection(LOCK_COLLECTION).updateOne(
    { _id: LOCK_ID, owner },
    { $set: { owner: null, expiresAt: new Date(0), releasedAt: new Date() } },
  );
}

/**
 * Uses the oldest requested shop watermark so every selected shop is covered.
 * The overlap protects against delayed Shopee indexing and duplicate events.
 */
export async function resolveIncrementalLookbackSec(shopIds, fallbackSec) {
  const db = database();
  const fallback = numberInRange(fallbackSec, DEFAULT_BOOTSTRAP_LOOKBACK_SEC, 60, 30 * 24 * 3600);
  const ids = [...new Set((shopIds || []).map((id) => String(id || "").trim()).filter(Boolean))];
  if (!db || ids.length === 0) return fallback;
  try {
    const rows = await db.collection(WATERMARK_COLLECTION)
      .find({ _id: { $in: ids } }, { projection: { lastSuccessfulAt: 1 } })
      .toArray();
    if (rows.length !== ids.length) return fallback;
    const oldest = Math.min(...rows.map((row) => new Date(row.lastSuccessfulAt).getTime()));
    if (!Number.isFinite(oldest)) return fallback;
    const elapsed = Math.floor((Date.now() - oldest) / 1000) + overlapSec();
    return numberInRange(elapsed, fallback, overlapSec(), 30 * 24 * 3600);
  } catch (err) {
    console.warn("[SyncOrchestrator] read watermark failed:", safeError(err));
    return fallback;
  }
}

/** Advance only shops that completed without an error/deadline. */
export async function markSuccessfulShopWatermarks(perShop) {
  const db = database();
  if (!db || !Array.isArray(perShop)) return;
  const now = new Date();
  const ops = perShop
    .filter((item) => String(item?.shopId || "").trim() && item?.status === "DONE" && !item?.error)
    .map((item) => ({
      updateOne: {
        filter: { _id: String(item.shopId).trim() },
        update: {
          $set: {
            lastSuccessfulAt: now,
            updatedAt: now,
            lastPulled: Number(item.pulled) || 0,
            lastAdded: Number(item.added) || 0,
            lastUpdated: Number(item.updated) || 0,
          },
          $setOnInsert: { createdAt: now },
        },
        upsert: true,
      },
    }));
  if (ops.length) await db.collection(WATERMARK_COLLECTION).bulkWrite(ops, { ordered: false });
}

export async function getShopeeSyncOrchestratorStatus() {
  const db = database();
  if (!db) return { ready: false, reason: "mongodb_not_ready" };
  const lock = await db.collection(LOCK_COLLECTION).findOne({ _id: LOCK_ID });
  return {
    ready: true,
    locked: Boolean(lock?.owner),
    // Khóa tồn dư sau crash phải được kiểm tra worker đã dừng trước khi phục hồi.
    needsInspection: Boolean(lock?.owner && new Date(lock.expiresAt).getTime() <= Date.now()),
    expiresAt: lock?.expiresAt || null,
    trigger: lock?.trigger || null,
  };
}
