import crypto from 'node:crypto';
import os from 'node:os';
import mongoose from 'mongoose';
import { isOwnerProcessDead } from '../modules/shopee-sync/syncOrchestrator.js';

const DB_OPTIONS = { maxTimeMS: 5000 };
const FINISHED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PENDING_TIMEOUT_MS = 40 * 60 * 1000;
const WAIT_WARNING_MS = 2 * 60 * 1000;
const HEARTBEAT_WARNING_MS = 90 * 1000;
const HEARTBEAT_INTERVAL_MS = 30 * 1000;

// Durable state and one worker per lane across Passenger processes. Never take a
// live worker's lock just because an HTTP reader timed out.
export function createLogisticsJobQueue(getDb, ownerIsDead = isOwnerProcessDead) {
  const handlers = new Map();
  const busy = new Set();
  const completedOwners = new Map();
  let timer;
  let indexedDb;
  const collections = async () => {
    const db = getDb();
    if (!db) throw new Error('mongodb_not_ready');
    const jobs = db.collection('logistics_jobs');
    const locks = db.collection('logistics_worker_locks');
    if (indexedDb !== db) {
      // Giữ nguyên cách tạo index đang chạy; chỉ giới hạn các truy vấn mới thêm.
      await jobs.createIndex({ lane: 1, state: 1, createdAt: 1 });
      await jobs.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
      indexedDb = db;
    }
    return { jobs, locks };
  };
  const publicData = (doc, lock) => {
    if (!doc) return null;
    const { confirmedPatches, ...data } = doc.data;
    if (!['pending', 'running'].includes(doc.state)) return { ...data, id: doc._id };
    const now = Date.now();
    const waitMs = Math.max(0, now - (doc.createdAt || now));
    const heartbeatAt = lock?.heartbeatAt || lock?.acquiredAt;
    const staleHeartbeat = Boolean(lock?.owner && (!heartbeatAt || now - new Date(heartbeatAt).getTime() > HEARTBEAT_WARNING_MS));
    const prolonged = doc.state === 'pending' && waitMs >= WAIT_WARNING_MS;
    const stalled = Boolean(lock?.owner && staleHeartbeat);
    const queueHealth = {
      state: stalled ? 'stalled' : prolonged && lock?.owner ? 'blocked' : doc.state === 'pending' ? 'waiting' : 'running',
      waitMs, staleHeartbeat,
      acquiredAt: lock?.acquiredAt || null, heartbeatAt: lock?.heartbeatAt || null,
    };
    let message = data.message;
    if (prolonged) {
      message = lock?.owner
        ? 'Tác vụ vẫn đang chờ worker của lô trước nhả khóa; chưa bắt đầu lượt xử lý tiếp theo. Không tự thu hồi khóa khi process còn sống.'
        : 'Tác vụ vẫn đang chờ worker tiếp nhận; chưa bắt đầu lượt xử lý tiếp theo.';
      if (stalled) message += ' Heartbeat của worker chưa được cập nhật; cần kiểm tra worker.';
    }
    return { ...data, ...(prolonged ? { message } : {}), id: doc._id, queueHealth };
  };
  // Chỉ hết hạn tác vụ chưa từng chạy. Không đụng checkpoint hoặc phần đang lưu kết quả.
  const expirePending = (jobs, scope) => {
    const now = Date.now();
    return jobs.findOneAndUpdate({
      ...scope, state: 'pending', attempts: 0, startedAt: { $exists: false },
      createdAt: { $lt: now - PENDING_TIMEOUT_MS },
      'data.startedAt': { $exists: false }, 'data.persistencePending': { $ne: true },
      'data.phase': { $nin: ['persisting'] },
    }, { $set: {
      state: 'finished', updatedAt: now, expiresAt: new Date(now + FINISHED_TTL_MS),
      'data.status': 'failed', 'data.phase': 'expired', 'data.updatedAt': now,
      'data.error': 'queue_wait_expired',
      'data.message': 'Tác vụ chưa bắt đầu và đã chờ quá 40 phút nên đã hết hạn. Chưa xử lý đơn nào; vui lòng gửi lại tác vụ nếu vẫn cần.',
    } }, { ...DB_OPTIONS, sort: { createdAt: 1 }, returnDocument: 'after' });
  };
  const tick = async (lane) => {
    if (busy.has(lane)) return;
    busy.add(lane);
    let owner;
    let locks;
    let heartbeat;
    let heartbeatWrite;
    try {
      const cols = await collections();
      const jobs = cols.jobs;
      locks = cols.locks;
      // Hàng đợi giới hạn 10 tác vụ; mỗi tick chỉ dọn tối đa 10 bản ghi có điều kiện.
      for (let i = 0; i < 10; i++) {
        if (!await expirePending(jobs, { lane })) break;
        if (i === 9) return;
      }
      if (completedOwners.has(lane)) {
        await locks.deleteOne({ _id: lane, owner: completedOwners.get(lane) }, DB_OPTIONS);
        completedOwners.delete(lane);
      }
      const previous = await locks.findOne({ _id: lane }, DB_OPTIONS);
      if (previous?.owner) {
        if (!ownerIsDead(previous)) return;
        await locks.deleteOne({ _id: lane, owner: previous.owner }, DB_OPTIONS);
      }
      owner = crypto.randomUUID();
      try {
        const now = new Date();
        await locks.insertOne({ _id: lane, owner, pid: process.pid, hostname: os.hostname(), acquiredAt: now, heartbeatAt: now }, DB_OPTIONS);
      } catch (error) {
        if (error?.code === 11000) { owner = null; return; }
        throw error;
      }
      // Heartbeat chỉ phục vụ chẩn đoán, không phải lease cho phép cướp khóa.
      heartbeat = setInterval(() => {
        if (heartbeatWrite) return;
        heartbeatWrite = locks.updateOne({ _id: lane, owner }, { $set: { heartbeatAt: new Date() } }, DB_OPTIONS)
          .catch(() => console.warn('[Logistics jobs] heartbeat_failed'))
          .finally(() => { heartbeatWrite = null; });
      }, HEARTBEAT_INTERVAL_MS);
      heartbeat.unref?.();
      const now = Date.now();
      const doc = await jobs.findOneAndUpdate(
        { lane, state: { $in: ['pending', 'running'] }, nextAttemptAt: { $lte: now } },
        { $set: { state: 'running', updatedAt: now, startedAt: now }, $inc: { attempts: 1 } },
        { sort: { createdAt: 1 }, returnDocument: 'after', ...DB_OPTIONS },
      );
      if (!doc) return;
      let latest = doc.data;
      let writes = Promise.resolve();
      const checkpoint = async (data) => {
        latest = structuredClone(data);
        const snapshot = latest;
        writes = writes.then(() => jobs.updateOne({ _id: doc._id },
          { $set: { data: snapshot, updatedAt: Date.now() } }, DB_OPTIONS));
        await writes;
      };
      try {
        const data = await handlers.get(lane)(doc.input, { ...doc.data, id: doc._id, recovering: doc.attempts > 1 }, checkpoint);
        await writes;
        await jobs.updateOne({ _id: doc._id }, { $set: {
          data, state: 'finished', updatedAt: Date.now(),
          expiresAt: new Date(Date.now() + FINISHED_TTL_MS),
        } }, DB_OPTIONS);
      } catch (error) {
        const retry = doc.attempts < 5;
        const data = { ...latest, status: retry ? 'pending' : 'failed',
          phase: latest.phase === 'persisting' ? 'persisting' : 'recovering',
          persistencePending: latest.phase === 'persisting',
          message: retry ? 'Đang thử tiếp tục tác vụ, giữ nguyên các đơn đã xác nhận.'
            : 'Tác vụ bị gián đoạn. Các đơn đã xác nhận được giữ lại; vui lòng tải lại danh sách để đối soát.',
          error: String(error?.message || error), updatedAt: Date.now() };
        await jobs.updateOne({ _id: doc._id }, { $set: {
          data, state: retry ? 'pending' : 'finished', nextAttemptAt: Date.now() + 5000,
          updatedAt: Date.now(),
          ...(!retry ? { expiresAt: new Date(Date.now() + FINISHED_TTL_MS) } : {}),
        } }, DB_OPTIONS);
      }
    } catch (error) {
      if (getDb()) console.warn('[Logistics jobs]', error?.message || error);
    } finally {
      clearInterval(heartbeat);
      if (heartbeatWrite) await heartbeatWrite;
      if (owner && locks) {
        try { await locks.deleteOne({ _id: lane, owner }, DB_OPTIONS); }
        catch { completedOwners.set(lane, owner); console.warn('[Logistics jobs] release_failed'); }
      }
      busy.delete(lane);
    }
  };
  return {
    register(lane, handler) { handlers.set(lane, handler); },
    async submit(lane, input, data, requestId) {
      const { jobs } = await collections();
      const key = requestId ? String(requestId).slice(0, 150) : crypto.randomUUID();
      const id = `${lane}-${crypto.createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
      const fingerprint = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
      const existing = await jobs.findOne({ _id: id }, DB_OPTIONS);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new Error('request_id_conflict');
        return publicData(existing);
      }
      if (await jobs.countDocuments({ lane, state: { $in: ['pending', 'running'] } }, { limit: 10, ...DB_OPTIONS }) >= 10) {
        throw Object.assign(new Error('Hàng đợi đang đầy. Vui lòng chờ lô trước hoàn tất.'), { code: 'work_queue_full' });
      }
      await jobs.updateOne({ _id: id }, { $setOnInsert: {
        lane, input, fingerprint, data: { ...data, id }, state: 'pending',
        attempts: 0, createdAt: Date.now(), updatedAt: Date.now(), nextAttemptAt: 0,
      } }, { upsert: true, ...DB_OPTIONS }).catch((error) => { if (error?.code !== 11000) throw error; });
      const accepted = await jobs.findOne({ _id: id }, DB_OPTIONS);
      if (!accepted || accepted.fingerprint !== fingerprint) throw new Error('request_id_conflict');
      void tick(lane);
      return publicData(accepted);
    },
    async get(id) {
      const { jobs, locks } = await collections();
      let doc = await jobs.findOne({ _id: String(id) }, DB_OPTIONS);
      if (doc?.state === 'pending' && doc.attempts === 0 && doc.createdAt < Date.now() - PENDING_TIMEOUT_MS) {
        await expirePending(jobs, { _id: doc._id });
        doc = await jobs.findOne({ _id: doc._id }, DB_OPTIONS);
      }
      const lock = doc && ['pending', 'running'].includes(doc.state)
        ? await locks.findOne({ _id: doc.lane }, DB_OPTIONS) : null;
      return publicData(doc, lock);
    },
    start() {
      if (timer) return;
      timer = setInterval(() => { for (const lane of handlers.keys()) void tick(lane); }, 2000);
      timer.unref?.();
      for (const lane of handlers.keys()) void tick(lane);
    },
    stop() { clearInterval(timer); timer = null; },
    tick,
  };
}

export const logisticsJobQueue = createLogisticsJobQueue(() =>
  mongoose.connection.readyState === 1 ? mongoose.connection.db : null);
