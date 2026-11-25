import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { build } from 'esbuild';
await build({ stdin: { contents: `export * from './modules/orders/shipmentReview.ts';
export * from './modules/logistics/handover.ts'; export { orderTabFilter } from './src/db/mongoStore.ts';`,
  resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: 'tmp/shipment-review-module.mjs' });
const state = await import('../tmp/shipment-review-module.mjs');
function extract(file, name, deps) {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  let code;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) code = node.getText(source);
    ts.forEachChild(node, visit);
  }
  visit(source); assert.ok(code, name);
  const compiled = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(deps), `${compiled}; return ${name};`)(...Object.values(deps));
}
function matches(doc, query) {
  return Object.entries(query).every(([key, value]) => {
    if (key === '$and') return value.every(q => matches(doc, q));
    if (key === '$or') return value.some(q => matches(doc, q));
    if (key === '$nor') return !value.some(q => matches(doc, q));
    const actual = key.split('.').reduce((a, k) => a?.[k], doc);
    if (value && typeof value === 'object') return Object.entries(value).every(([operator, expected]) => {
      if (operator === '$in') return expected.includes(actual);
      if (operator === '$nin') return !expected.includes(actual);
      if (operator === '$ne') return actual !== expected;
      if (operator === '$regex') return expected.test(String(actual ?? ''));
      throw new Error(operator);
    });
    return actual === value;
  });
}
const pending = extract('src/components/OrderManager.tsx', 'isPendingConfirmOrder', state);
const base = { id: 'shopee-ORDER123', orderSn: 'ORDER123', channel: 'shopee', shopId: 'SHOP',
  status: 'processed', shopee_order_status: 'PROCESSED', isPrepared: true, isPrinted: true };
for (const raw of ['READY_TO_SHIP', 'RETRY_SHIP', 'PROCESSED']) {
  const order = { ...base, shopee_order_status: raw };
  assert.equal(state.markShipmentReview(order, 'logistics.tracking_number_invalid'), true);
  assert.equal(order.status, 'pending_confirm'); assert.equal(order.isPrinted, false); assert.equal(order.isPrepared, false);
  for (const phase of ['before sync', 'after stale sync']) {
    if (phase === 'after stale sync') {
      Object.assign(order, { status: 'processed', isPrepared: true });
      state.reconcileShipmentReview(order);
    }
    assert.equal(pending(order), true);
    assert.equal(state.matchesProcessedPickupTab(order), false);
    assert.equal(state.matchesUnprocessedPickupTab(order), false);
    for (const tab of ['pending_confirm', 'processed', 'unprocessed'])
      assert.equal(matches(order, state.orderTabFilter(tab)), tab === 'pending_confirm', raw + ': ' + phase + ': ' + tab);
  }
  order.tracking_no = '0FG12345';
  state.reconcileShipmentReview(order); assert.equal(order.status, 'pending_confirm', 'internal package IDs are not carrier waybills');
  order.tracking_no = 'SPXVN123456789';
  state.reconcileShipmentReview(order);
  assert.equal(order.status, 'unprocessed'); assert.equal(order.is_pending_shopee_check, false);
  assert.equal(order.isPrepared, false); assert.equal(order.isPrinted, false); assert.equal(pending(order), false);
  assert.equal(state.matchesUnprocessedPickupTab(order), true);
  assert.equal(state.matchesProcessedPickupTab(order), false);
  assert.equal(matches(order, state.orderTabFilter('unprocessed')), true);
  assert.equal(matches(order, state.orderTabFilter('pending_confirm')), false);
}
for (const patch of [{ status: 'shipping' }, { status: 'completed' }, { status: 'cancelled' },
  { shopee_order_status: 'SHIPPED' }, { shopee_order_status: 'TO_RETURN' },
  { is_handed_over: true }, { return_sn: 'RETURN123' }, { channel: 'manual' }]) {
  const order = { ...base, ...patch }, before = structuredClone(order);
  assert.equal(state.markShipmentReview(order, 'failure'), false);
  assert.deepEqual(order, before, 'terminal, returned, handed-over and non-Shopee orders stay unchanged');
}
let persisted = 0;
const mark = extract('server.ts', 'markOrderPendingShopeeCheck', state);
const persist = extract('server.ts', 'persistPendingShopeeCheckFlag', {
  ...state, markOrderPendingShopeeCheck: mark, isMongoReady: () => true,
  updateOrderPendingShopeeCheckInStore: async (sn, flag, patch) => {
    persisted++; assert.equal(sn, 'ORDER123'); assert.equal(flag, true);
    assert.equal(patch.status, 'pending_confirm'); assert.equal(patch.isPrepared, false); assert.equal(patch.isPrinted, false);
  }, console: { log() {}, warn() {} },
});
const failedOrder = { ...base };
const arrange = extract('server.ts', 'arrangeShipment', {
  shipShopeeOrderReal: async () => ({ success: false, error: 'logistics.tracking_number_invalid' }),
  isAlreadyShippedError: () => false, persistPendingShopeeCheckFlag: persist,
});
assert.equal((await arrange(failedOrder, 'dropoff')).success, false);
assert.equal(failedOrder.status, 'pending_confirm'); assert.equal(persisted, 1);
const pdfFailures = extract('server.ts', 'persistMissingWaybillFailures', { ...state, persistPendingShopeeCheckFlag: persist });
await pdfFailures([{ ...base, isPrinted: false }], [{ orderSn: 'ORDER123', error: 'document_not_ready' }]);
assert.equal(persisted, 2, 'accepted arrangement without a waybill returns to pending after PDF failure');
await pdfFailures([{ ...base, isPrinted: false, tracking_no: 'SPX123' }], [{ orderSn: 'ORDER123', error: 'network_error' }]);
assert.equal(persisted, 2, 'PDF errors with a valid waybill do not reset the order');
console.log('PASS: rejected/no-waybill orders move to pending; incoming valid tracking moves to unprocessed with no preparation/print flags; 3 raw statuses, client/server tab exclusivity, sync protection, Mongo persistence, terminal/handover exclusions and PDF-only errors');
const repair = extract('server.ts', 'repairFalseProcessedReadyToShip', state);
const waiting = { ...base }; state.markShipmentReview(waiting, 'pending');
repair(waiting);
assert.equal(waiting.status, 'pending_confirm', 'generic READY_TO_SHIP repair cannot erase the review state');
const push = extract('server.ts', 'applyShopeePushFieldsToOrder', {
  ...state, applyShopeeTrackingCode(order, code) { order.tracking_no = code; },
  hasUsableShopeeTrackingNumber: state.hasShipmentWaybill,
  isShopeeInternalTrackingCode: code => /^0FG/i.test(code),
  promoteRawStatusFromLogistics: () => false, isShopeeTerminalRawStatus: () => false,
  enforceShopeeTerminalLocalStatus() {}, repairMisassignedTracking() {},
  console: { log() {} },
});
push(waiting, { trackingNo: 'SPXNEW123456' });
assert.equal(waiting.status, 'unprocessed'); assert.equal(waiting.isPrepared, false); assert.equal(waiting.isPrinted, false);
console.log('PASS: real auto-heal and tracking webhook preserve/recover pending confirmation correctly');
