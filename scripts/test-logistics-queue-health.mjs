import test from 'node:test';
import assert from 'node:assert/strict';
import { createLogisticsJobQueue } from '../services/logisticsJobQueue.js';

function memoryDb() {
  const tables = new Map();
  const get = (doc, key) => key.split('.').reduce((value, part) => value?.[part], doc);
  const match = (doc, query) => Object.entries(query).every(([key, value]) => {
    const actual = get(doc, key);
    if (value && typeof value === 'object' && '$in' in value) return value.$in.includes(actual);
    if (value && typeof value === 'object' && '$nin' in value) return !value.$nin.includes(actual);
    if (value && typeof value === 'object' && '$lte' in value) return actual <= value.$lte;
    if (value && typeof value === 'object' && '$lt' in value) return actual < value.$lt;
    if (value && typeof value === 'object' && '$exists' in value) return value.$exists ? actual !== undefined : actual === undefined;
    if (value && typeof value === 'object' && '$ne' in value) return actual !== value.$ne;
    return actual === value;
  });
  const setPath = (doc, key, value) => {
    const parts = key.split('.'); let target = doc;
    for (const part of parts.slice(0, -1)) target = target[part] ||= {};
    target[parts.at(-1)] = structuredClone(value);
  };
  const apply = (doc, update, insert = false) => {
    for (const [key, value] of Object.entries(update.$set || {})) setPath(doc, key, value);
    if (insert) for (const [key, value] of Object.entries(update.$setOnInsert || {})) setPath(doc, key, value);
    for (const [key, value] of Object.entries(update.$inc || {})) setPath(doc, key, (get(doc, key) || 0) + value);
    return doc;
  };
  return { collection(name) {
    if (tables.has(name)) return tables.get(name);
    const rows = new Map();
    const table = {
      rows, createIndex: async () => {},
      findOne: async (query) => structuredClone([...rows.values()].find((doc) => match(doc, query)) || null),
      countDocuments: async (query) => [...rows.values()].filter((doc) => match(doc, query)).length,
      insertOne: async (doc) => { if (rows.has(doc._id)) throw Object.assign(new Error('duplicate'), { code: 11000 }); rows.set(doc._id, structuredClone(doc)); },
      updateOne: async (query, update, options = {}) => {
        let doc = [...rows.values()].find((candidate) => match(candidate, query));
        if (!doc && options.upsert) { doc = apply({ _id: query._id }, update, true); rows.set(doc._id, doc); }
        else if (doc) apply(doc, update);
        return { matchedCount: doc ? 1 : 0 };
      },
      findOneAndUpdate: async (query, update, options = {}) => {
        const doc = [...rows.values()].filter((candidate) => match(candidate, query))
          .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))[0];
        return doc ? structuredClone(apply(doc, update)) : null;
      },
      deleteOne: async (query) => { for (const [id, doc] of rows) if (match(doc, query)) rows.delete(id); },
    };
    tables.set(name, table); return table;
  } };
}

function oldPending(id, lane = 'confirm') {
  return { _id: id, lane, state: 'pending', input: {}, data: { status: 'pending' },
    attempts: 0, createdAt: Date.now() - 41 * 60 * 1000, updatedAt: Date.now() - 41 * 60 * 1000, nextAttemptAt: 0 };
}

test('live lock is never stolen based on age or missing heartbeat', async () => {
  const db = memoryDb(); let calls = 0;
  await db.collection('logistics_worker_locks').insertOne({ _id: 'confirm', owner: 'live', pid: 12, hostname: 'other', acquiredAt: new Date(0), heartbeatAt: new Date(0) });
  await db.collection('logistics_jobs').insertOne({ ...oldPending('confirm-live'), createdAt: Date.now() });
  const queue = createLogisticsJobQueue(() => db, () => false);
  queue.register('confirm', () => { calls++; });
  await queue.tick('confirm');
  assert.equal(calls, 0);
  assert.equal((await db.collection('logistics_worker_locks').findOne({ _id: 'confirm' })).owner, 'live');
  assert.equal((await queue.get('confirm-live')).queueHealth.state, 'stalled');
});

test('heartbeat is owner-conditional and another queue cannot run the same lane concurrently', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const db = memoryDb();
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const first = createLogisticsJobQueue(() => db, () => false);
  const second = createLogisticsJobQueue(() => db, () => false);
  const worker = async () => { calls++; entered(); await held; return { status: 'done' }; };
  first.register('confirm', worker); second.register('confirm', worker);
  await db.collection('logistics_jobs').insertOne({ ...oldPending('confirm-held'), createdAt: Date.now() });
  const running = first.tick('confirm');
  await started;
  try {
    const locks = db.collection('logistics_worker_locks');
    const lock = locks.rows.get('confirm');
    assert.ok(lock.acquiredAt instanceof Date);
    assert.ok(lock.heartbeatAt instanceof Date);
    const update = locks.updateOne;
    let heartbeatCalls = 0;
    locks.updateOne = async (query, change, options) => {
      heartbeatCalls++;
      assert.equal(query.owner, lock.owner);
      assert.equal(options.maxTimeMS, 5000);
      return update(query, change, options);
    };
    t.mock.timers.tick(30_000);
    await Promise.resolve();
    assert.equal(heartbeatCalls, 1);
    await second.tick('confirm');
    assert.equal(calls, 1);
    assert.equal(locks.rows.get('confirm').owner, lock.owner);
  } finally { release(); await running; }
  assert.equal(db.collection('logistics_worker_locks').rows.has('confirm'), false);
});

test('get expires only eligible pending documents and reports long waits without discarding checkpoints', async () => {
  const db = memoryDb();
  const queue = createLogisticsJobQueue(() => db, () => false);
  await db.collection('logistics_jobs').insertOne(oldPending('confirm-expire-read'));
  assert.equal((await queue.get('confirm-expire-read')).status, 'failed');
  for (const [id, fields] of [
    ['running', { state: 'running' }],
    ['attempted', { attempts: 1 }],
    ['started', { startedAt: Date.now() - 3600000 }],
    ['persisting', { data: { status: 'pending', persistencePending: true, phase: 'persisting' } }],
  ]) {
    await db.collection('logistics_jobs').insertOne({ ...oldPending(id), ...fields });
    const result = await queue.get(id);
    assert.notEqual(result.status, 'failed', id);
    assert.equal(db.collection('logistics_jobs').rows.get(id).expiresAt, undefined, id);
    if (id !== 'running') assert.match(result.message, /chờ worker/);
  }
});

test('dead lock is recovered and pending work runs once', async () => {
  const db = memoryDb(); let calls = 0;
  await db.collection('logistics_worker_locks').insertOne({ _id: 'confirm', owner: 'dead', pid: 12, hostname: 'other' });
  await db.collection('logistics_jobs').insertOne({ _id: 'confirm-dead', lane: 'confirm', state: 'pending', input: {},
    data: { status: 'pending' }, attempts: 0, createdAt: Date.now(), updatedAt: Date.now(), nextAttemptAt: 0 });
  const queue = createLogisticsJobQueue(() => db, () => true);
  queue.register('confirm', async () => { calls++; return { status: 'done' }; });
  await queue.tick('confirm');
  assert.equal(calls, 1);
  assert.equal((await queue.get('confirm-dead')).status, 'done');
});

test('expired never-started job is marked failed without executing handler', async () => {
  const db = memoryDb(); let calls = 0;
  await db.collection('logistics_jobs').insertOne(oldPending('confirm-expired'));
  const queue = createLogisticsJobQueue(() => db, () => false);
  queue.register('confirm', () => { calls++; });
  await queue.tick('confirm');
  const job = await queue.get('confirm-expired');
  assert.equal(calls, 0);
  assert.equal(job.status, 'failed');
  assert.equal(job.phase, 'expired');
  assert.match(job.message, /40 phút/);
  assert.ok(db.collection('logistics_jobs').rows.get('confirm-expired').expiresAt);
});

test('started checkpoint is retained and is not expired after a persistence failure', async () => {
  const db = memoryDb(); let calls = 0;
  await db.collection('logistics_jobs').insertOne({ _id: 'confirm-started', lane: 'confirm', state: 'pending', input: {},
    data: { status: 'pending' }, attempts: 0, createdAt: Date.now(), updatedAt: Date.now(), nextAttemptAt: 0 });
  const queue = createLogisticsJobQueue(() => db, () => false);
  queue.register('confirm', async (_input, job, checkpoint) => {
    calls++;
    if (calls === 1) {
      await checkpoint({ ...job, results: [{ orderSn: 'A', success: true }], phase: 'persisting', persistencePending: true });
      throw new Error('persistence unavailable');
    }
    assert.equal(job.recovering, true);
    assert.deepEqual(job.results, [{ orderSn: 'A', success: true }]);
    return { ...job, status: 'done', persistencePending: false };
  });
  await queue.tick('confirm');
  const paused = await queue.get('confirm-started');
  assert.equal(calls, 1);
  assert.equal(paused.status, 'pending');
  assert.equal(paused.persistencePending, true);
  assert.deepEqual(paused.results, [{ orderSn: 'A', success: true }]);
  assert.equal(paused.phase, 'persisting');
  // Tác vụ đã chạy rồi chờ thử lại quá 40 phút vẫn phải được tiếp tục, không bị hết hạn.
  const row = db.collection('logistics_jobs').rows.get('confirm-started');
  row.createdAt = Date.now() - 41 * 60 * 1000;
  row.nextAttemptAt = 0;
  await queue.tick('confirm');
  const done = await queue.get('confirm-started');
  assert.equal(calls, 2);
  assert.equal(done.status, 'done');
  assert.equal(db.collection('logistics_jobs').rows.get('confirm-started').data.phase, 'persisting');
});
