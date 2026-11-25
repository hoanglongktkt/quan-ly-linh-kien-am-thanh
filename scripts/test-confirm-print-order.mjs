import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { PDFDocument } from 'pdf-lib';
import { mapByShopGroups } from '../utils/concurrency.js';
import { resolveOrdersFromRequest } from '../modules/orders/lookupService.js';

// Chạy worker xác nhận và bộ gộp PDF thật; chỉ giả lập Shopee/DB, không khởi động server.
const source = ts.createSourceFile('server.ts', fs.readFileSync(new URL('../server.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const declarations = new Map();
(function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name) declarations.set(node.name.text, node.getText(source));
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) declarations.set(node.name.text, `const ${node.getText(source)};`);
  ts.forEachChild(node, visit);
})(source);
function extract(names, dependencies) {
  const code = names.map((name) => {
    assert.ok(declarations.has(name), `Missing real source: ${name}`);
    return declarations.get(name);
  }).join('\n');
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(dependencies), `${js}; return {${names.join(',')}};`)(...Object.values(dependencies));
}
const group = {};
new Function('exports', ts.transpileModule(fs.readFileSync(new URL('../src/utils/groupPickingSort.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)(group);
const noop = () => {};
const quiet = { log: noop, warn: noop, error: noop };

for (const [count, failedPositions] of [[20, []], [20, [1]], [45, [4, 23]]]) {
  test(`${count} đơn, ${failedPositions.length} lỗi: xác nhận song song nhiều shop → nhóm sản phẩm → trang PDF giữ thứ tự`, { timeout: 10000 }, async () => {
    const requested = Array.from({ length: count }, (_, i) => ({
      id: `mongo-id-${i}`, orderSn: `ORDER${i}`, shopId: `SHOP${i % 3}`,
      items: [{ name: i % 2 ? 'Loa B' : 'Amply A', sku: i % 2 ? 'B' : 'A' }],
      width: 200 + i,
    })).sort(group.compareGroupPickingOrders);
    const snapshot = requested.map(({ id, orderSn }) => ({ id, orderSn }));
    const failures = new Set(failedPositions.map((i) => requested[i].orderSn));
    const expected = requested.filter((o) => !failures.has(o.orderSn));
    const completionOrder = [];
    const job = { status: 'pending', results: [] };
    const { executeConfirmOnlyBackgroundJob: run, buildPdfBuffersInRequestedOrder, mergeBatchPdfBuffers } = extract([
      'executeConfirmOnlyBackgroundJob', 'reorderOrdersByRequestedSns', 'buildShipConfirmSummaryPayload',
      'alignBatchPdfDocumentsToRequestedOrder', 'buildPdfBuffersInRequestedOrder', 'mergeBatchPdfBuffers',
    ], {
      console: quiet, PDFDocument, Buffer,
      shipOrderJobs: new Map([['fake-job', job]]), beginLogisticsWork: noop, endLogisticsWork: noop,
      CONFIRM_ASYNC_DB_TIMEOUT_MS: 1000, BATCH_CONFIRM_OPERATION_TIMEOUT_MS: 1000,
      CONFIRM_ASYNC_BATCH_SIZE: 20, CONFIRM_ASYNC_BATCH_PAUSE_MS: 0,
      uniquePreserveOrder: group.uniquePreserveOrder, normalizePrintOrderSn: group.normalizePrintOrderSn,
      loadOrdersForShipScoped: async () => [...requested].reverse().map((o) => ({ ...o })),
      withOperationTimeout: async (fn) => fn(new AbortController().signal),
      resolveOrdersFromRequest, resolveOrderShopId: (o) => o.shopId,
      arrangeShipment: async (order) => {
        const rank = requested.findIndex((o) => o.orderSn === order.orderSn);
        await new Promise((resolve) => setTimeout(resolve, (7 - rank % 7) * 3));
        completionOrder.push(order.orderSn);
        return failures.has(order.orderSn) ? { success: false, error: 'shipment_rejected' } : { success: true };
      },
      isAlreadyShippedError: () => false, forceHealPickupOrderIfHasTracking: noop,
      mapByShopGroups, sleep: async () => {}, yieldEventLoop: async () => {},
      persistConfirmedShipOrdersToMongo: async (orders) => {
        assert.equal(job.status, 'running');
        assert.equal(orders.length, expected.length);
      },
      setImmediate: noop, // Tác vụ nền sau kết quả không thuộc giao dịch đang kiểm tra.
    });
    await run('fake-job', 'dropoff', snapshot.map((o) => o.id), snapshot.map((o) => o.orderSn));
    assert.equal(job.status, 'done', job.message);
    assert.notDeepEqual(completionOrder, snapshot.map((o) => o.orderSn), 'Phải thực sự hoàn thành lệch thứ tự');
    assert.deepEqual(job.results.map((r) => r.orderSn), snapshot.map((o) => o.orderSn));
    assert.deepEqual(job.successfulOrderIds, expected.map((o) => o.id));

    // FE vẫn đúng khi máy chủ cũ trả thành công lệch thứ tự/ID DB khác mã Shopee.
    requested.reverse();
    const printSns = group.getConfirmedPrintOrderSns(snapshot, [...job.successfulOrderIds].reverse());
    assert.deepEqual(printSns, expected.map((o) => o.orderSn));
    const docs = [];
    for (const order of [...expected].reverse()) {
      const pdf = await PDFDocument.create();
      pdf.addPage([order.width, 400]);
      if (order === expected[2]) pdf.addPage([order.width, 450]);
      docs.push({ orderSns: [order.orderSn], buffer: Buffer.from(await pdf.save()) });
    }
    const pdfs = buildPdfBuffersInRequestedOrder(printSns, docs);
    const merged = await mergeBatchPdfBuffers(pdfs, 'test', (sn) => assert.fail(`Invalid PDF ${sn}`));
    const expectedPages = expected.flatMap((o) => o === expected[2] ? [o.width, o.width] : [o.width]);
    const finalPdf = await PDFDocument.load(await merged.save());
    assert.deepEqual(finalPdf.getPages().map((p) => p.getWidth()), expectedPages);
    assert.deepEqual(job.failedOrders.map((o) => o.orderSn), snapshot.map((o) => o.orderSn).filter((sn) => failures.has(sn)));
  });
}

test('snapshot chỉ in đơn thành công đã chọn, chuẩn hóa prefix và loại trùng, bỏ mã ngoài lô', () => {
  const snapshot = [{ id: 'db-a', orderSn: 'A' }, { id: 'shopee-B', orderSn: 'B' }, { id: 'db-c', orderSn: 'C' }];
  assert.deepEqual(group.getConfirmedPrintOrderSns(snapshot, ['shopee-C', 'db-a', 'A', 'OTHER']), ['A', 'C']);
  assert.deepEqual(group.getConfirmedPrintOrderSns(snapshot, []), []);
});
