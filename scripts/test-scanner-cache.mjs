import assert from 'node:assert/strict';
import { build } from 'esbuild';

await build({ entryPoints: ['src/utils/orderScan.ts'], bundle: true, platform: 'node', format: 'esm', outfile: 'tmp/scanner-cache-test-module.mjs' });
const scan = await import('../tmp/scanner-cache-test-module.mjs');
const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
  removeItem: (key) => storage.delete(key),
};
const token = (username) => `x.${Buffer.from(JSON.stringify({ username })).toString('base64url')}.x`;
localStorage.setItem('admin_token', token('scanner-test'));
const rows = [{ order_id: 'ORDER123', tracking_code: 'SPX123456789', return_waybill: '', status: 'processed' }];
let calls = 0;
let finish;
globalThis.fetch = async () => {
  calls++;
  await new Promise((resolve) => { finish = resolve; });
  return { ok: true, json: async () => ({ success: true, orders: rows, code_count: 1 }) };
};
const controller = new AbortController();
const first = scan.fetchScannerSyncPool('handover', { signal: controller.signal });
const second = scan.fetchScannerSyncPool('handover');
assert.equal(calls, 1, 'concurrent consumers share one HTTP request');
const aborted = assert.rejects(first, { name: 'AbortError' });
controller.abort();
finish();
await aborted;
const entry = await second;
assert.equal(entry.map.get('SPX123456789').order_id, 'ORDER123');
assert.equal(scan.loadScannerPoolCache().handover.rows.length, 1, 'rows survive component reload');
localStorage.setItem('admin_token', token('another-account'));
assert.equal(scan.loadScannerPoolCache().handover, null, 'account caches remain separate');
localStorage.setItem('admin_token', token('scanner-test'));
const key = 'scanner_pool_v1:scanner-test:handover';
const saved = JSON.parse(localStorage.getItem(key));
saved.fetchedAt = Date.now() - 10 * 60_000;
localStorage.setItem(key, JSON.stringify(saved));
const older = scan.loadScannerPoolCache().handover;
assert.ok(scan.isScannerPoolUsable(older), 'older rows can open scanner immediately');
assert.ok(scan.isScannerPoolStale(older), 'older rows require refresh');
assert.equal(scan.isScannerPoolFresh(older), false);
saved.fetchedAt = Date.now() - 25 * 60 * 60_000;
localStorage.setItem(key, JSON.stringify(saved));
assert.equal(scan.loadScannerPoolCache().handover, null, 'expired rows are ignored');
localStorage.setItem(key, '{broken');
assert.equal(scan.loadScannerPoolCache().handover, null, 'corrupt storage is ignored');
globalThis.fetch = async () => ({ ok: true, json: async () => ({ success: false, orders: [] }) });
await assert.rejects(scan.fetchScannerSyncPool('handover'), /Invalid scanner response/);
assert.equal(localStorage.getItem(key), '{broken', 'error responses do not replace cached data');
scan.clearScannerPoolCache('handover');
assert.equal(localStorage.getItem(key), null);
console.log('PASS: deduplication, independent cancellation, persistence, account isolation, stale/expired data, corrupt storage, API failures, invalidation');

