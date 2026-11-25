import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { PDFDocument } from 'pdf-lib';
import { mapWithConcurrency } from '../utils/concurrency.js';

const source = ts.createSourceFile('server.ts', fs.readFileSync(new URL('../server.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const declarations = new Map();
(function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name) declarations.set(node.name.text, node.getText(source));
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) declarations.set(node.name.text, `const ${node.getText(source)};`);
  ts.forEachChild(node, visit);
})(source);
const names = [
  'batchDownloadShopeeWaybillPdf', 'splitMergedWaybillPdfToOrders', 'mapWaybillSettled',
  'toShippingDocApiItems', 'shippingDocRowKey', 'waybillDownloadBudgetMs', 'isBenignCreateShippingFail',
  'cacheOrderWaybillPdf', 'SHOPEE_SHIPPING_DOCUMENT_TYPE', 'SHOPEE_SHIPPING_DOC_BULK_MAX',
  'PRINT_WAYBILL_BATCH_POLL_MAX_ATTEMPTS', 'PRINT_WAYBILL_BATCH_POLL_INTERVAL_MS',
  'PRINT_WAYBILL_DOWNLOAD_PAUSE_MS', 'PRINT_WAYBILL_DOWNLOAD_TIMEOUT_CAP_MS', 'PRINT_WAYBILL_DOWNLOAD_CONCURRENCY',
  'enrichOrdersPackageAndTrackingForPrint', 'SHOPEE_ORDER_DETAIL_MAX_ORDER_SNS', 'isShopeeOrderNotFoundError',
  'fetchBatchPdfDocumentsByShopUnshared', 'runBeforeBatchDeadline', 'buildShopeeShippingDocOrderRows',
  'sortBatchPdfResultByRequestedOrder', 'alignBatchPdfDocumentsToRequestedOrder',
];
const code = ts.transpileModule(names.map((name) => {
  assert.ok(declarations.has(name), name); return declarations.get(name);
}).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function harness(mode, badIndex = 9, count = 20) {
  const orders = Array.from({ length: count }, (_, i) => ({
    orderSn: i === badIndex ? 'BAD' : `GOOD${i}`, shopId: 'shop', packageNumber: `P${i}`, trackingNumber: `T${i}`,
  }));
  if (mode === 'missing') orders[badIndex].packageNumber = '';
  const files = new Map(), memory = new Map();
  const calls = { create: [], poll: [], detail: [], download: [] };
  const deps = {
    Buffer, PDFDocument, path, AbortController, AbortSignal, setTimeout, clearTimeout, mapWithConcurrency,
    console: { log() {}, warn() {}, error() {} }, PDF_DIR: '/fake', BATCH_PDF_MAX_BYTES: 25 * 1024 * 1024,
    fs: { existsSync: () => false, promises: { readFile: async (file) => files.get(file) } },
    uniquePreserveOrder: (v) => [...new Set(v)], normalizePrintOrderSn: (v) => String(v || '').replace(/^shopee-/i, '').trim(),
    trackingForShopeeShippingDoc: (o) => o.trackingNumber,
    getValidShopeeAccessToken: async () => 'fake', getShopeeAccessTokenForApi: async () => ({ apiShopId: 'shop', token: 'fake' }),
    isShopeeInternalTrackingCode: () => false, sleepMs: async () => {}, sleep: async () => {},
    PRINT_API_DELAY_MS: 200,
    isPdfBuffer: (b) => Boolean(b?.subarray(0, 5).equals(Buffer.from('%PDF-'))),
    buildCachedLabelFilename: (sns) => `batch_${sns.join('_')}.pdf`,
    putLabelMem: (name, buf) => memory.set(name, buf), getLabelMem: (name) => ({ buf: memory.get(name) }),
    readCachedOrderWaybillPdf: async (sn) => memory.get(`order_${sn}.pdf`) || null,
    unlinkWaybillFileQuiet() {}, markHasPdfIfLabelFileReady: async () => {}, persistMissingWaybillFailures: async () => {},
    persistOrderTrackingToDb: async () => {},
    describeShopeeWaybillPayloadError: () => ({ error: 'invalid_pdf', message: 'Invalid PDF' }),
    shopeeGetOrderDetail: async (_s, _t, sns) => {
      calls.detail.push([...sns]);
      if (mode === 'detail-throw' && sns.includes('BAD')) throw new Error('order_sn does not exist');
      if (mode === 'detail' && sns.includes('BAD')) return { error: 'order_not_found', message: 'order_sn does not exist' };
      return { response: { order_list: sns.map((sn) => ({ order_sn: sn, package_list: [{ package_number: orders.find((o) => o.orderSn === sn).packageNumber }] })) } };
    },
    applyShopeePackageListTracking() {}, applyShopeePackageNumbers() {},
    extractShopeePackageNumbersFromPayload: (d) => d.package_list.map((p) => p.package_number),
    pickBestTrackingNumber: (...v) => v.find(Boolean),
    shopeeCreateShippingDocument: async (_s, _t, rows) => {
      calls.create.push(rows.map((r) => r.order_sn));
      if (mode === 'network') throw new Error('ECONNRESET network unavailable');
      if ((mode === 'create' && rows.some((r) => r.order_sn === 'BAD')) || mode === 'all-create') throw Object.assign(new Error('logistics.invalid_order: package cannot create document'), { code: 'logistics.invalid_order' });
      if (mode === 'create-named' && rows.some((r) => r.order_sn === 'BAD')) throw Object.assign(new Error('Some orders failed'), {
        httpStatus: 500,
        orderResults: [{ order_sn: 'BAD', fail_error: 'invalid_order', fail_message: 'Package rejected' }],
      });
      return { response: { result_list: [] } };
    },
    shopeeGetShippingDocumentResult: async (_s, _t, rows) => {
      calls.poll.push(rows.map((r) => r.order_sn));
      if (mode === 'poll-global' && rows.some((r) => r.order_sn === 'BAD')) return { error: 'invalid_order', message: 'Order not found' };
      return { response: { result_list: rows.map((r) => ({ ...r,
        status: r.order_sn === 'BAD' && mode === 'poll-failed' ? 'FAILED' : r.order_sn === 'BAD' && mode === 'processing' ? 'PROCESSING' : 'READY',
        ...(r.order_sn === 'BAD' && mode === 'poll-failed' ? { fail_error: 'invalid_order', fail_message: 'Package rejected' } : {}),
      })) } };
    },
    shopeeDownloadShippingDocument: async (_s, _t, rows, filename) => {
      calls.download.push(rows.map((r) => r.order_sn));
      const pdf = await PDFDocument.create();
      for (const row of rows) pdf.addPage([200 + orders.findIndex((o) => o.orderSn === row.order_sn), 400]);
      const buf = Buffer.from(await pdf.save());
      const filePath = path.join('/fake', filename); files.set(filePath, buf);
      return { filename, filePath, size: buf.length, contentType: 'application/pdf' };
    },
  };
  const run = new Function(...Object.keys(deps), `${code}; return {batchDownloadShopeeWaybillPdf, fetchBatchPdfDocumentsByShopUnshared, isBenignCreateShippingFail};`)(...Object.values(deps));
  return { run, orders, calls, memory };
}

for (const mode of ['create', 'create-named', 'detail', 'detail-throw', 'missing', 'poll-failed', 'poll-global', 'processing']) {
  test(`20 đơn, một đơn ${mode}: vẫn trả đúng 19 PDF còn lại`, { timeout: 5000 }, async () => {
    const { run, orders, calls, memory } = harness(mode);
    const sns = orders.map((o) => o.orderSn), expected = sns.filter((sn) => sn !== 'BAD');
    const result = mode.startsWith('detail')
      ? await run.fetchBatchPdfDocumentsByShopUnshared(orders, sns, Date.now() + 120000, 'test')
      : await run.batchDownloadShopeeWaybillPdf('shop', orders.map((o) => ({ order_sn: o.orderSn, package_number: o.packageNumber, tracking_number: o.trackingNumber })), { deadlineAt: Date.now() + 120000 });
    const ready = result.documents ? result.documents.flatMap((d) => d.orderSns) : result.readyOrderSns;
    assert.deepEqual([...ready].sort(), [...expected].sort());
    const failed = result.failedOrders || result.skippedOrders;
    assert.deepEqual(failed.map((f) => f.orderSn), ['BAD']);
    for (const sn of expected) {
      const pdf = await PDFDocument.load(memory.get(`order_${sn}.pdf`));
      assert.equal(pdf.getPageCount(), 1);
      assert.equal(pdf.getPage(0).getWidth(), 200 + sns.indexOf(sn));
    }
    if (mode === 'create') assert.ok(calls.create.length <= 12, 'Không tải/create tuần tự lại toàn bộ 20 đơn');
    if (mode === 'create-named') assert.equal(calls.create.length, 2, 'Dùng mã lỗi cụ thể để chỉ gửi lại 19 đơn hợp lệ');
    if (mode === 'poll-failed') assert.equal(calls.poll.length, 1, 'Đơn FAILED phải được tách ngay');
    if (mode === 'processing') assert.ok(calls.poll.length <= 5, 'Không giữ 19 PDF vì một đơn đang processing');
  });
}

for (const [count, badIndex] of [[20, 0], [20, 19], [50, 49]]) {
  test(`${count} đơn, đơn từ chối ở vị trí ${badIndex}: vẫn giữ toàn bộ đơn tốt`, async () => {
    const { run, orders, calls } = harness('create', badIndex, count);
    const result = await run.batchDownloadShopeeWaybillPdf('shop', orders.map((o) => ({ order_sn: o.orderSn, package_number: o.packageNumber })), { deadlineAt: Date.now() + 120000 });
    assert.equal(result.readyOrderSns.length, count - 1);
    assert.deepEqual(result.skippedOrders.map((o) => o.orderSn), ['BAD']);
    assert.ok(calls.create.length <= 16);
  });
}

test('lỗi kết nối chung không kích hoạt chia lô và dội request Shopee', async () => {
  const { run, orders, calls } = harness('network');
  const result = await run.batchDownloadShopeeWaybillPdf('shop', orders.map((o) => ({ order_sn: o.orderSn, package_number: o.packageNumber })), { deadlineAt: Date.now() + 120000 });
  assert.equal(result.readyOrderSns.length, 0);
  assert.equal(calls.create.length, 1);
});

test('mọi đơn bị từ chối vẫn thoát hữu hạn, không gọi API quá giới hạn', async () => {
  const { run, orders, calls } = harness('all-create');
  const result = await run.batchDownloadShopeeWaybillPdf('shop', orders.map((o) => ({ order_sn: o.orderSn, package_number: o.packageNumber })), { deadlineAt: Date.now() + 120000 });
  assert.equal(result.readyOrderSns.length, 0);
  assert.equal(result.skippedOrders.length, orders.length);
  assert.ok(calls.create.length <= 16);
});

test('order does not exist là lỗi thật, khác với document already exists', () => {
  const { run } = harness('create');
  assert.equal(run.isBenignCreateShippingFail('order_not_exist', 'Order does not exist'), false);
  assert.equal(run.isBenignCreateShippingFail('document_already_exists', 'Already created'), true);
});
