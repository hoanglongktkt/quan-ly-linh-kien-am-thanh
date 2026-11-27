import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { transform } from 'esbuild';
import express from 'express';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'import-batch-test-'));
const dataDir = path.join(root, 'data');
fs.mkdirSync(dataDir);
const oldAppRoot = process.env.PASSENGER_APP_ROOT;
process.env.PASSENGER_APP_ROOT = root;
const controller = await import('../controllers/importsController.js');
const store = await import('../src/db/productsDiskStore.ts');
const client = await import('../src/utils/importBatch.ts');
controller.initImportsController({
  isProductsDiskMode: () => true,
  withProductsDiskImportBatch: store.withProductsDiskImportBatch,
});
const supplier = { id: 'test-supplier', name: 'Fixture supplier', supplierCode: 'FIX', totalOrderValue: 10000, totalPaid: 2000, totalDebt: 8000, status: 'active' };
function reset() {
  assert.equal(fs.existsSync(path.join(dataDir, '.import-batch-journal.json')), false);
  const products = Array.from({ length: 50 }, (_, i) => ({ id: `p${i}`, sku: `SKU${i}`, title: `Fixture ${i}`, stock: 10, importPrice: 50, status: 'active' }));
  products.push({ id: 'variants', sku: 'PARENT', stock: 7, children: [
    { id: 'c1', sku: 'C1', stock: 3, importPrice: 20, shopeeItemId: 'item-link', shopeeModelId: 'model-1' },
    { id: 'c2', sku: 'C2', stock: 4, importPrice: 30 },
  ] });
  products.push({ id: 'legacy-variants', stock: 2, children_models: [{ id: 'c3', sku: 'C3', stock: 2, importPrice: 40 }] });
  fs.writeFileSync(path.join(dataDir, 'products.json'), JSON.stringify(products));
  fs.writeFileSync(path.join(dataDir, 'imports.json'), '[]');
  fs.writeFileSync(path.join(dataDir, 'suppliers.json'), JSON.stringify([supplier]));
  store.setProductsDiskAppRoot(root);
}
const read = (name) => JSON.parse(fs.readFileSync(path.join(dataDir, `${name}.json`), 'utf8'));
function body(count = 15, batchId = 'imp-fixture-001') {
  return { batchId, supplierId: supplier.id, items: Array.from({ length: count }, (_, i) => ({
    productId: `p${i}`, productSku: `SKU${i}`, supplierId: supplier.id,
    quantity: 2, newImportPrice: 100 + i, importCost: i === 0 ? 500 : 0,
    paidAmount: 50, date: '2026-10-31',
  })) };
}
async function save(payload) {
  const res = { code: 200, status(n) { this.code = n; return this; }, json(value) { this.body = value; return this; } };
  await controller.createImportBatch({ body: payload }, res);
  return res;
}
function snapshot() { return ['products', 'imports', 'suppliers'].map((name) => fs.readFileSync(path.join(dataDir, `${name}.json`), 'utf8')); }

test('15/20/50 rows each commit the warehouse, history and supplier exactly once', async () => {
  for (const count of [15, 20, 50]) {
    reset();
    const writes = { products: 0, imports: 0, suppliers: 0 };
    const original = fs.writeFileSync;
    fs.writeFileSync = function(file, ...args) {
      const match = path.basename(String(file)).match(/^\.import-.*-(products|imports|suppliers)\.json\.tmp$/);
      if (match) writes[match[1]]++;
      return original.call(this, file, ...args);
    };
    let result;
    try { result = await save(body(count)); } finally { fs.writeFileSync = original; }
    assert.equal(result.code, 201);
    assert.equal(result.body.entries.length, count);
    assert.equal(result.body.imports, undefined, 'do not resend the entire history');
    assert.deepEqual(writes, { products: 1, imports: 1, suppliers: 1 });
    assert.ok(read('products').slice(0, count).every((p) => p.stock === 12));
    const total = body(count).items.reduce((sum, row) => sum + row.quantity * row.newImportPrice + row.importCost, 0);
    const updated = read('suppliers')[0];
    assert.equal(updated.totalOrderValue, supplier.totalOrderValue + total);
    assert.equal(updated.totalPaid, supplier.totalPaid + count * 50);
    assert.equal(updated.totalDebt, supplier.totalDebt + total - count * 50);
  }
});

test('variants in the same parent and children_models keep stock totals and marketplace links', async () => {
  reset();
  const payload = body(3);
  payload.items.forEach((row, i) => { row.productId = `c${i + 1}`; row.productSku = `C${i + 1}`; });
  assert.equal((await save(payload)).code, 201);
  const products = read('products');
  const parent = products.find((p) => p.id === 'variants');
  assert.equal(parent.stock, 11);
  assert.deepEqual(parent.children.map((p) => p.stock), [5, 6]);
  assert.equal(parent.children[0].shopeeItemId, 'item-link');
  assert.equal(products.find((p) => p.id === 'legacy-variants').stock, 4);
});

test('replay, including concurrent retries, never increments stock or debt twice', async () => {
  reset();
  const payload = body();
  const results = await Promise.all([save(payload), save(payload), save(payload)]);
  assert.deepEqual(results.map((r) => r.code), [201, 200, 200]);
  const committed = snapshot();
  store.setProductsDiskAppRoot(root); // discard process cache: receipt is durable in history
  assert.equal((await save(payload)).body.replayed, true);
  assert.deepEqual(snapshot(), committed);
  assert.equal(read('imports').length, 15);
  assert.equal(read('products')[0].stock, 12);
});

test('different concurrent receipts for the same SKU accumulate correctly', async () => {
  reset();
  const a = body(1, 'imp-fixture-a');
  const b = body(1, 'imp-fixture-b');
  b.items[0].quantity = 3;
  assert.deepEqual((await Promise.all([save(a), save(b)])).map((r) => r.code), [201, 201]);
  assert.equal(read('products')[0].stock, 15);
  assert.equal(read('imports').length, 2);
});

test('an active worker lock returns a retry response without changing data', async () => {
  reset();
  const before = snapshot();
  const lock = path.join(dataDir, '.import-batch.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  try {
    assert.equal((await save(body())).code, 503);
    assert.deepEqual(snapshot(), before);
  } finally { fs.unlinkSync(lock); }
  assert.equal((await save(body())).code, 201);
});

test('a bad last row, duplicate SKU, invalid payment, or corrupted history writes nothing', async () => {
  for (const kind of ['missing', 'duplicate', 'payment', 'corrupt']) {
    reset();
    const payload = body();
    if (kind === 'missing') Object.assign(payload.items[14], { productId: 'missing', productSku: 'missing' });
    if (kind === 'duplicate') payload.items[14] = { ...payload.items[0] };
    if (kind === 'payment') payload.items[14].paidAmount = 999999;
    if (kind === 'corrupt') fs.writeFileSync(path.join(dataDir, 'imports.json'), '{broken');
    const before = snapshot();
    assert.ok((await save(payload)).code >= 400);
    assert.deepEqual(snapshot(), before);
  }
});

test('reusing a receipt ID with modified contents is rejected without writes', async () => {
  reset();
  const payload = body();
  await save(payload);
  const before = snapshot();
  payload.items[0].quantity++;
  assert.equal((await save(payload)).code, 409);
  assert.deepEqual(snapshot(), before);
});

test('failure before publishing the journal leaves all three original files intact', async () => {
  reset();
  const before = snapshot();
  const original = fs.writeFileSync;
  fs.writeFileSync = function(file, ...args) {
    if (/\.import-.*-suppliers\.json\.tmp$/.test(String(file))) throw new Error('fixture_stage_failure');
    return original.call(this, file, ...args);
  };
  let result;
  try { result = await save(body()); } finally { fs.writeFileSync = original; }
  assert.equal(result.code, 500);
  assert.deepEqual(snapshot(), before);
  assert.equal(fs.existsSync(path.join(dataDir, '.import-batch-journal.json')), false);
  assert.equal((await save(body())).code, 201);
});

test('interrupted commit recovers after restart/retry and applies the receipt once', async () => {
  reset();
  const original = fs.renameSync;
  fs.renameSync = function(from, to) {
    if (String(to) === path.join(dataDir, 'suppliers.json')) throw new Error('fixture_commit_failure');
    return original.call(this, from, to);
  };
  let result;
  try { result = await save(body()); } finally { fs.renameSync = original; }
  assert.equal(result.code, 503);
  assert.equal(result.body.success, false);
  assert.equal(result.body.retrySameBatch, true);
  assert.equal(fs.existsSync(path.join(dataDir, '.import-batch-journal.json')), true);
  const replay = await save(body());
  assert.equal(replay.code, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal(read('imports').length, 15);
  assert.equal(read('products')[0].stock, 12);
  assert.equal(fs.existsSync(path.join(dataDir, '.import-batch-journal.json')), false);
});

test('client sends all lines once and retains timeout through the response body', async () => {
  let calls = 0;
  const payload = body();
  const reply = (await save(payload)).body;
  const result = await client.saveImportBatchRequest(payload.items, payload.batchId, {}, async (_url, init) => {
    calls++;
    assert.equal(JSON.parse(init.body).items.length, 15);
    return Response.json(reply);
  });
  assert.equal(calls, 1);
  assert.equal(result.batchId, payload.batchId);
  await assert.rejects(client.saveImportBatchRequest(payload.items, payload.batchId, {}, async (_url, init) => {
    return new Response(new ReadableStream({ start(stream) {
      init.signal.addEventListener('abort', () => stream.error(new DOMException('aborted', 'AbortError')), { once: true });
    } }), { headers: { 'content-type': 'application/json' } });
  }, 20), (error) => error instanceof client.ImportBatchSaveError && error.uncertain);
});

test('frontend updates UI once per receipt and never sends per-row supplier updates', async () => {
  const app = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const start = app.indexOf('  const handleAddImports =');
  const code = app.slice(start, app.indexOf('  const navigateTab =', start));
  const js = (await transform(code, { loader: 'ts' })).code;
  const calls = { save: 0, imports: 0, products: 0, suppliers: 0, refresh: 0, log: 0 };
  const reply = { ...((await save(body())).body), supplier: read('suppliers')[0] };
  const env = {
    localStorage: { getItem: () => 'fixture' }, ImportBatchSaveError: client.ImportBatchSaveError,
    saveImportBatchRequest: async () => { calls.save++; return reply; }, apiAuthHeaders: () => ({}),
    setImports: (fn) => { calls.imports++; assert.equal(fn([]).length, 15); },
    setProducts: (fn) => { calls.products++; fn([]); },
    setSuppliers: (fn) => { calls.suppliers++; fn([supplier]); },
    fetchProducts: async () => { calls.refresh++; },
    handleAddLog: () => { calls.log++; },
  };
  const handler = new Function(...Object.keys(env), `${js};return handleAddImports;`)(...Object.values(env));
  await handler(body().items, body().batchId);
  assert.deepEqual(calls, { save: 1, imports: 1, products: 1, suppliers: 1, refresh: 1, log: 1 });
});

test('failed save keeps the same pending receipt; retry shows success only after acknowledgement', async () => {
  const source = fs.readFileSync(new URL('../src/components/ImportManager.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('  const submitPendingBatch =');
  const js = (await transform(source.slice(start, source.indexOf('  const historyModalEl =', start)), { loader: 'ts' })).code;
  const state = { calls: [], success: 0, cleared: 0, pending: null };
  const pendingBatchRef = { current: null };
  const env = {
    pendingBatchRef, submitGuardRef: { current: false }, setSubmitting: () => {},
    keepPendingImportBatch: (pending) => { state.pending = pending; },
    setPendingBatch: () => {},
    onAddImports: async (items, id) => {
      state.calls.push({ items: structuredClone(items), id });
      if (state.calls.length === 1) throw new client.ImportBatchSaveError('fixture timeout', true);
      if (state.calls.length === 2) throw new client.ImportBatchSaveError('fixture expired login', false);
    },
    clearPendingImportBatch: () => { state.cleared++; }, setViewMode: () => {},
    showToast: () => { state.success++; }, alert: () => {}, ImportBatchSaveError: client.ImportBatchSaveError,
    selectedSupplierId: supplier.id, suppliers: [supplier],
    selectedProducts: body().items.map((row) => ({ ...row, title: 'fixture', sku: row.productSku, unitPrice: row.newImportPrice, oldImportPrice: 0 })),
    supplierSelectRef: {}, productSearchRef: {}, paidAmount: 0, totalCost: 999999, importCost: 0,
  };
  const handler = new Function(...Object.keys(env), `${js};return handleSubmitImport;`)(...Object.values(env));
  await handler({ preventDefault() {} });
  assert.equal(state.success, 0);
  assert.ok(pendingBatchRef.current);
  await handler({ preventDefault() {} });
  assert.equal(state.success, 0);
  assert.ok(pendingBatchRef.current, 'a later 401 cannot prove the earlier timeout did not commit');
  await handler({ preventDefault() {} });
  assert.deepEqual(state.calls[0], state.calls[1]);
  assert.deepEqual(state.calls[0], state.calls[2]);
  assert.equal(state.success, 1);
  assert.equal(state.cleared, 1);
  assert.equal(pendingBatchRef.current, null);
});

test('pending receipt survives a page reload and is scoped to the signed-in user', () => {
  const previousLocal = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const previousSession = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const values = new Map();
  let username = 'fixture-one';
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: () => `fixture.${Buffer.from(JSON.stringify({ username })).toString('base64url')}.signature`,
  } });
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key),
  } });
  try {
    const pending = { batchId: body().batchId, transactions: body().items };
    client.keepPendingImportBatch(pending);
    assert.deepEqual(client.readPendingImportBatch(), pending);
    username = 'fixture-two';
    assert.equal(client.readPendingImportBatch(), null);
    username = 'fixture-one';
    client.clearPendingImportBatch();
    assert.equal(client.readPendingImportBatch(), null);
  } finally {
    if (previousLocal) Object.defineProperty(globalThis, 'localStorage', previousLocal); else delete globalThis.localStorage;
    if (previousSession) Object.defineProperty(globalThis, 'sessionStorage', previousSession); else delete globalThis.sessionStorage;
  }
});

test('real HTTP batch route saves 15 products and a repeated request is deduplicated', async () => {
  reset();
  const routes = await import('../routes/importsRoutes.js');
  const app = express();
  app.use(express.json());
  app.use('/api/imports', routes.default);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const payload = body();
  const fetcher = (url, init) => fetch(base + url, init);
  try {
    const first = await client.saveImportBatchRequest(payload.items, payload.batchId, { 'Content-Type': 'application/json' }, fetcher);
    assert.equal(first.replayed, false);
    const second = await client.saveImportBatchRequest(payload.items, payload.batchId, { 'Content-Type': 'application/json' }, fetcher);
    assert.equal(second.replayed, true);
    assert.equal(read('imports').length, 15);
    assert.equal(read('products')[0].stock, 12);
  } finally {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  }
});

after(() => {
  if (oldAppRoot === undefined) delete process.env.PASSENGER_APP_ROOT;
  else process.env.PASSENGER_APP_ROOT = oldAppRoot;
  // Only remove the test directory just created under the OS temp directory.
  const resolved = path.resolve(root);
  assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
  assert.ok(path.basename(resolved).startsWith('import-batch-test-'));
  fs.rmSync(resolved, { recursive: true, force: true });
});
