import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { setTimeout as delay } from 'node:timers/promises';
import { createLogisticsJobQueue } from '../services/logisticsJobQueue.js';
import { createWorkGate, createKeyedBatchWork } from '../utils/workGate.js';
import { resolveProxyTimeoutMs } from '../_lib/cpanelProxy.js';

function memoryDb() {
  const tables = new Map();
  const match = (doc, query) => Object.entries(query).every(([key, value]) =>
    value && typeof value === 'object' && '$in' in value ? value.$in.includes(doc[key])
    : value && typeof value === 'object' && '$lte' in value ? doc[key] <= value.$lte
    : doc[key] === value);
  return { collection(name) {
    if (tables.has(name)) return tables.get(name);
    const rows = new Map();
    const apply = (doc, update, insert = false) => {
      Object.assign(doc, structuredClone(update.$set || {}), insert ? structuredClone(update.$setOnInsert || {}) : {});
      for (const [k, n] of Object.entries(update.$inc || {})) doc[k] = (doc[k] || 0) + n;
      return doc;
    };
    const table = { rows, createIndex: async () => {},
      findOne: async (q) => structuredClone([...rows.values()].find((d) => match(d, q)) || null),
      countDocuments: async (q) => [...rows.values()].filter((d) => match(d, q)).length,
      insertOne: async (d) => { if (rows.has(d._id)) throw Object.assign(new Error('duplicate'), { code: 11000 }); rows.set(d._id, structuredClone(d)); },
      updateOne: async (q, u, options = {}) => {
        let doc = [...rows.values()].find((d) => match(d, q));
        if (!doc && options.upsert) { doc = apply({ _id: q._id }, u, true); rows.set(doc._id, doc); }
        else if (doc) apply(doc, u);
        return { matchedCount: doc ? 1 : 0 };
      },
      findOneAndUpdate: async (q, u) => {
        const doc = [...rows.values()].find((d) => match(d, q));
        return doc ? structuredClone(apply(doc, u)) : null;
      },
      deleteOne: async (q) => { for (const [id, doc] of rows) if (match(doc, q)) rows.delete(id); },
    };
    tables.set(name, table); return table;
  } };
}
async function until(check) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await delay(5); }
  assert.fail('condition did not settle');
}
function extract(file, name) {
  const src = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  let fn;
  const walk = (n) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) fn = n.getText(src);
    if (ts.isVariableDeclaration(n) && n.name?.getText(src) === name) fn = `const ${n.getText(src)}; globalThis.extracted = ${name};`;
    ts.forEachChild(n, walk);
  };
  walk(src); assert.ok(fn, name);
  return ts.transpileModule(fn, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}

test('lost acceptance response is idempotent across two queue instances', async () => {
  const db = memoryDb();
  const a = createLogisticsJobQueue(() => db, () => false);
  const b = createLogisticsJobQueue(() => db, () => false);
  let calls = 0;
  const worker = async () => { calls++; await delay(10); return { status: 'done' }; };
  a.register('confirm', worker); b.register('confirm', worker);
  const first = await a.submit('confirm', { orderSns: ['A'] }, { status: 'pending' }, 'same-request');
  const second = await b.submit('confirm', { orderSns: ['A'] }, { status: 'pending' }, 'same-request');
  assert.equal(first.id, second.id);
  await until(async () => (await a.get(first.id))?.status === 'done');
  assert.equal(calls, 1);
  await assert.rejects(b.submit('confirm', { orderSns: ['B'] }, {}, 'same-request'), /request_id_conflict/);
});

test('dead process resumes saved results, while a live process keeps ownership', async () => {
  const db = memoryDb();
  await db.collection('logistics_worker_locks').insertOne({ _id: 'confirm', owner: 'old', pid: 123, hostname: 'host' });
  await db.collection('logistics_jobs').insertOne({ _id: 'confirm-A', lane: 'confirm', state: 'running', input: {},
    data: { status: 'running', results: [{ orderSn: 'A', success: true }], confirmedPatches: [{ orderSn: 'A' }] }, nextAttemptAt: 0, attempts: 1 });
  let calls = 0;
  const live = createLogisticsJobQueue(() => db, () => false);
  live.register('confirm', () => { calls++; });
  await live.tick('confirm'); assert.equal(calls, 0);
  const replacement = createLogisticsJobQueue(() => db, () => true);
  replacement.register('confirm', async (_input, job) => {
    calls++; assert.equal(job.recovering, true); assert.equal(job.results[0].orderSn, 'A');
    return { ...job, status: 'done' };
  });
  await replacement.tick('confirm');
  assert.equal((await replacement.get('confirm-A')).status, 'done');
  assert.equal((await replacement.get('confirm-A')).confirmedPatches, undefined);
  assert.equal(calls, 1);
});

test('failed persistence retries saved successes without repeating shipment work', async () => {
  const db = memoryDb(); const queue = createLogisticsJobQueue(() => db);
  let shipCalls = 0, attempts = 0;
  queue.register('confirm', async (_input, job, checkpoint) => {
    attempts++;
    if (!job.results?.length) { shipCalls++; job.results = [{ orderSn: 'A', success: true }]; }
    job.phase = 'persisting'; await checkpoint(job);
    if (attempts === 1) throw new Error('database unavailable');
    return { ...job, status: 'done', persistencePending: false };
  });
  const job = await queue.submit('confirm', {}, { status: 'pending', results: [] }, 'persist');
  await until(async () => (await queue.get(job.id))?.persistencePending);
  assert.equal((await queue.get(job.id)).status, 'pending');
  await until(async () => !db.collection('logistics_worker_locks').rows.has('confirm'));
  db.collection('logistics_jobs').rows.get(job.id).nextAttemptAt = 0;
  await queue.tick('confirm');
  assert.equal((await queue.get(job.id)).status, 'done'); assert.equal(shipCalls, 1);
});

test('cached ready labels survive failure of the uncached part', async () => {
  const context = vm.createContext({ AbortSignal, Date, Set, Map,
    uniquePreserveOrder: (keys) => [...new Set(keys)], WAYBILL_BATCH_DEADLINE_MS: 2000,
    readCachedOrderWaybillPdf: async (sn) => sn === 'READY' ? Buffer.from('%PDF-ready') : null,
    sharedLabelWork: createKeyedBatchWork(createWorkGate(1)),
    fetchBatchPdfDocumentsByShopUnshared: async () => { throw new Error('batch_deadline:slow'); },
    sortBatchPdfResultByRequestedOrder: (_sns, documents, failedOrders) => ({ documents, failedOrders }),
  });
  vm.runInContext(extract('server.ts', 'fetchBatchPdfDocumentsByShop'), context);
  const result = await context.fetchBatchPdfDocumentsByShop([], ['READY', 'SLOW'], Date.now() + 1000, 'test');
  assert.equal(result.documents[0].orderSns[0], 'READY'); assert.equal(result.failedOrders[0].orderSn, 'SLOW');
});

test('a short prefetch reader cannot shorten shared print generation', async () => {
  let release; const held = new Promise((r) => { release = r; });
  let generationBudget;
  const context = vm.createContext({ AbortSignal, Date, Set, Map,
    uniquePreserveOrder: (keys) => [...new Set(keys)], WAYBILL_BATCH_DEADLINE_MS: 2000,
    readCachedOrderWaybillPdf: async () => null,
    sharedLabelWork: createKeyedBatchWork(createWorkGate(1)),
    fetchBatchPdfDocumentsByShopUnshared: async (_orders, keys, deadline) => {
      generationBudget = deadline - Date.now(); await held;
      return { documents: keys.map((sn) => ({ orderSns: [sn], buffer: Buffer.from('%PDF-ready') })), failedOrders: [] };
    },
    sortBatchPdfResultByRequestedOrder: (_sns, documents, failedOrders) => ({ documents, failedOrders }),
  });
  vm.runInContext(extract('server.ts', 'fetchBatchPdfDocumentsByShop'), context);
  const short = context.fetchBatchPdfDocumentsByShop([], ['A'], Date.now() + 15, 'prefetch');
  await delay(2);
  const print = context.fetchBatchPdfDocumentsByShop([], ['A'], Date.now() + 1000, 'print');
  await delay(25); assert.ok(generationBudget > 1500);
  assert.equal((await short).failedOrders.length, 1);
  release(); assert.equal((await print).documents.length, 1);
});

function browserContext(fetch) {
  const store = new Map();
  const context = vm.createContext({ exports: {}, fetch, AbortController, Date, Promise, Math, Error, JSON,
    crypto: { randomUUID: () => 'stable-request' },
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5)), clearTimeout,
    localStorage: { getItem: (k) => store.get(k), setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) },
  });
  const source = ts.transpileModule(fs.readFileSync('src/utils/logisticsJobs.ts', 'utf8'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInContext(source, context); return context;
}
test('browser reconnects after a failed progress poll and retains accepted job id', async () => {
  let posts = 0, gets = 0;
  const context = browserContext(async (_url, init) => {
    if (init.method === 'POST') { posts++; return { ok: true, status: 202, json: async () => ({ accepted: true, jobId: 'confirm-A' }) }; }
    gets++; if (gets === 1) throw new Error('network');
    return { ok: true, status: 200, json: async () => ({ id: 'confirm-A', status: 'done', results: [{ success: true }] }) };
  });
  const states = [];
  const job = await context.exports.runLogisticsJob('confirm', { orderSns: ['A'] }, {}, (s) => states.push(s.status));
  assert.equal(job.status, 'done'); assert.equal(posts, 1); assert.equal(gets, 2);
  assert.deepEqual(states, ['reconnecting', 'done']);
  assert.equal(context.exports.readLogisticsJob('confirm', {}).jobId, 'confirm-A');
});
test('download deadline remains active while consuming response body', async () => {
  const context = browserContext(async (_url, init) => ({ ok: true, status: 200,
    arrayBuffer: () => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('body timeout')))),
  }));
  await assert.rejects(context.exports.logisticsRequest('/pdf', {}, undefined, true), /body timeout/);
});

test('actual confirmation worker persists checkpoints and does not reship on persistence retry', async () => {
  const job = { id: 'confirm-A', results: [], confirmedPatches: [] };
  const rows = [{ id: 'shopee-A', orderSn: 'A', shopId: '1' }, { id: 'shopee-B', orderSn: 'B', shopId: '1' }];
  let shipCalls = 0, persistCalls = 0;
  const context = vm.createContext({ Date, Set, Map, console: { log() {}, warn() {}, error() {} },
    shipOrderJobs: new Map([[job.id, job]]), beginLogisticsWork() {}, endLogisticsWork() {},
    loadOrdersForShipScoped: async () => structuredClone(rows),
    withOperationTimeout: async (fn) => fn(new AbortController().signal),
    CONFIRM_ASYNC_DB_TIMEOUT_MS: 15000, BATCH_CONFIRM_OPERATION_TIMEOUT_MS: 8000,
    CONFIRM_ASYNC_BATCH_SIZE: 20, CONFIRM_ASYNC_BATCH_PAUSE_MS: 0,
    resolveOrdersFromRequest: (orders) => orders.map((order, index) => ({ order, index })),
    resolveOrderShopId: (o) => o.shopId,
    arrangeShipment: async () => { shipCalls++; return { success: true }; },
    isAlreadyShippedError: () => false, forceHealPickupOrderIfHasTracking() {},
    mapByShopGroups: async (items, _resolve, worker) => Promise.all(items.map(worker)),
    buildConfirmedShipMongoPatches: (orders) => orders.map((o) => ({ orderSn: o.orderSn, isPrepared: true, status: 'processed', shopId: o.shopId })),
    buildShipConfirmSummaryPayload: (total, batch) => ({ total, successCount: batch.successCount, failCount: batch.failedCount,
      successfulOrderIds: batch.results.filter((r) => r.success).map((r) => r.orderId), failedOrderDetails: batch.failedOrders }),
    persistConfirmedShipOrdersToMongo: async (_rows, _method, opts) => {
      assert.equal(opts.strict, true); persistCalls++;
      if (persistCalls === 1) throw new Error('mock write failure'); return 2;
    },
    setImmediate() {},
  });
  vm.runInContext(extract('server.ts', 'executeConfirmOnlyBackgroundJob'), context);
  const saved = [];
  const checkpoint = async (data) => { saved.push(structuredClone(data)); };
  await assert.rejects(context.extracted(job.id, 'pickup', [], ['A', 'B'], checkpoint), /mock write failure/);
  assert.equal(job.status, 'running'); assert.equal(job.persistencePending, true);
  assert.equal(saved.at(-1).results.filter((r) => r.success).length, 2);
  await context.extracted(job.id, 'pickup', [], ['A', 'B'], checkpoint);
  assert.equal(job.status, 'done'); assert.equal(job.persistencePending, false); assert.equal(shipCalls, 2);
});

test('actual bulk PDF downloader returns ready orders without polling the slow order again', async () => {
  const pdf = Buffer.from('%PDF-' + 'x'.repeat(100));
  let polls = 0, downloads = 0;
  const context = vm.createContext({ Date, Map, Set, Buffer, console: { log() {}, warn() {}, error() {} },
    fs: { existsSync: () => false, promises: { readFile: async () => pdf } },
    path: { join: (...p) => p.join('/') }, PDF_DIR: '/mock',
    getValidShopeeAccessToken: async () => 'mock',
    SHOPEE_SHIPPING_DOCUMENT_TYPE: 'NORMAL_AIR_WAYBILL', SHOPEE_SHIPPING_DOC_BULK_MAX: 50,
    PRINT_WAYBILL_BATCH_POLL_MAX_ATTEMPTS: 40, PRINT_WAYBILL_BATCH_POLL_INTERVAL_MS: 2500,
    PRINT_WAYBILL_DOWNLOAD_PAUSE_MS: 0, PRINT_WAYBILL_DOWNLOAD_TIMEOUT_CAP_MS: 20000,
    toShippingDocApiItems: (rows) => rows, isShopeeInternalTrackingCode: () => false,
    shopeeCreateShippingDocument: async () => ({ response: { result_list: [] } }),
    shopeeGetShippingDocumentResult: async () => { polls++; return { response: { result_list: [
      { order_sn: 'A', package_number: 'PA', status: 'READY' },
      { order_sn: 'B', package_number: 'PB', status: 'PROCESSING' },
    ] } }; },
    shippingDocRowKey: (row) => `${row.order_sn}:${row.package_number}`,
    shopeeDownloadShippingDocument: async (_shop, _token, rows) => {
      downloads++; assert.equal(rows.length, 1); assert.equal(rows[0].order_sn, 'A');
      return { filename: 'order_A.pdf', filePath: '/mock/order_A.pdf', size: pdf.length };
    },
    waybillDownloadBudgetMs: () => 20000, isPdfBuffer: () => true, putLabelMem() {},
    splitMergedWaybillPdfToOrders: async () => new Map([['A', pdf]]), cacheOrderWaybillPdf: async () => {},
  });
  vm.runInContext(extract('server.ts', 'batchDownloadShopeeWaybillPdf'), context);
  const result = await context.batchDownloadShopeeWaybillPdf('1', [
    { order_sn: 'A', package_number: 'PA' }, { order_sn: 'B', package_number: 'PB' },
  ], { deadlineAt: Date.now() + 120000 });
  assert.equal(result.success, true); assert.equal(result.readyOrderSns.join(','), 'A');
  assert.equal(result.skippedOrders[0].orderSn, 'B'); assert.equal(polls, 1); assert.equal(downloads, 1);
});

test('Vercel uses short deadlines for acknowledgments and progress, not the old 240-second wait', () => {
  assert.equal(resolveProxyTimeoutMs('orders/batch-print/async'), 10000);
  assert.equal(resolveProxyTimeoutMs('orders/batch-confirm-async'), 10000);
  assert.equal(resolveProxyTimeoutMs('orders/batch-print/job/print-1'), 8000);
  assert.equal(resolveProxyTimeoutMs('shopee/ship-order/job/confirm-1'), 8000);
  assert.equal(resolveProxyTimeoutMs('orders/batch-print/file/print-1'), 60000);
});

test('rollout falls back only when the print endpoint is explicitly absent', async () => {
  let calls = 0;
  const oldServer = browserContext(async () => {
    calls++; return { ok: false, status: 404, json: async () => ({ message: 'not found' }) };
  });
  const result = await oldServer.exports.runLogisticsJob('print', { orderSns: ['A'] }, {}, () => {});
  assert.equal(result.status, 'legacy'); assert.equal(calls, 1);
  assert.equal(oldServer.exports.readLogisticsJob('print', {}), null);
  let posts = 0;
  const accepted = browserContext(async (_url, init) => {
    if (init.method === 'POST') { posts++; return { ok: true, status: 202, json: async () => ({ accepted: true, jobId: 'print-A' }) }; }
    return { ok: false, status: 404, json: async () => ({ message: 'temporarily unavailable' }) };
  });
  await assert.rejects(accepted.exports.runLogisticsJob('print', { orderSns: ['A'] }, {}, () => {}), /Chưa đọc được kết quả cuối/);
  assert.equal(posts, 1); assert.equal(accepted.exports.readLogisticsJob('print', {}).jobId, 'print-A');
});
