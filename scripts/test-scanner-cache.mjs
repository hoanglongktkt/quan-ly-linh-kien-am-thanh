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

// A pool may still say "processed" after the DB commit; it must not authorize a rescan.
localStorage.setItem(key, JSON.stringify({ rows, codeCount: 1, fetchedAt: Date.now() }));
let lookups = 0;
let current = { id: 'shopee-ORDER123', orderSn: 'ORDER123', status: 'processed', is_handed_over: true };
globalThis.fetch = async (url, options) => {
  lookups++;
  assert.equal(url, '/api/orders/lookup?code=SPX123456789');
  assert.equal(options.cache, 'no-store');
  return { ok: true, json: async () => current };
};
assert.equal(scan.loadScannerPoolCache().handover.rows[0].status, 'processed');
assert.equal((await scan.lookupCurrentScannerOrder('SPX123456789')).is_handed_over, true);
current = { ...current, isReturnReceived: true, local_status: 'CANCELLED_STORED' };
assert.equal((await scan.lookupCurrentScannerOrder('SPX123456789')).isReturnReceived, true);
assert.equal(lookups, 2, 'a second session must check DB again even with a fresh pool');
globalThis.fetch = async (url) => {
  // Reproduce the installed backend rejecting its projection without channel/items.
  if (url.includes('lean=scanner')) return { ok: false, status: 404 };
  return { ok: true, json: async () => ({
    id: 'shopee-NEWORDER123', orderSn: 'NEWORDER123', channel: 'shopee',
    status: 'processed', is_handed_over: false, items: [{ quantity: 1 }],
  }) };
};
const newOrder = await scan.lookupCurrentScannerOrder('SPXNEW123456');
assert.equal(newOrder.orderSn, 'NEWORDER123', 'new orders are found on the existing cPanel backend');
assert.equal(newOrder.is_handed_over, false);
globalThis.fetch = async () => ({ ok: false, status: 404 });
assert.equal(await scan.lookupCurrentScannerOrder('SPX123456789'), null, 'missing DB rows must not fall back to cached orders');
globalThis.fetch = async () => { throw new Error('offline'); };
await assert.rejects(scan.lookupCurrentScannerOrder('SPX123456789'), /offline/, 'network failures must not accept stale scans');
console.log('PASS: deduplication, independent cancellation, persistence, account isolation, stale/expired data, corrupt storage, API failures, invalidation');
console.log('PASS: current handover/return state across sessions, no stale fallback on missing orders or network errors');

assert.equal(scan.missingScannerOrderMessage('SPX-123456789'), 'Không tìm thấy đơn trong hệ thống');
assert.equal(scan.missingScannerOrderMessage('SPX123456789', scan.buildScannerSyncMap([
  { ...rows[0], isReturnReceived: true },
])), 'ĐƠN ĐÃ QUÉT');
assert.notEqual(scan.missingScannerOrderMessage('SPX123456789', scan.buildScannerSyncMap(rows)), 'ĐƠN ĐÃ QUÉT');
scan.rememberCommittedScans([{ code: 'SPX123456789', orderSn: 'ORDER123', action: 'rejected' }]);
assert.notEqual(scan.missingScannerOrderMessage('SPX123456789'), 'ĐƠN ĐÃ QUÉT');
scan.rememberCommittedScans([{ code: 'SPX123456789', orderSn: 'ORDER123', action: 'handed_over' }]);
assert.equal(scan.missingScannerOrderMessage('SPX-123456789'), 'ĐƠN ĐÃ QUÉT');
assert.equal(scan.missingScannerOrderMessage('ORDER123'), 'ĐƠN ĐÃ QUÉT');
localStorage.setItem('admin_token', token('another-account'));
assert.notEqual(scan.missingScannerOrderMessage('SPX123456789'), 'ĐƠN ĐÃ QUÉT');
console.log('PASS: exact duplicate message, confirmed DB receipts, code aliases, unknown/rejected scans, account isolation');
