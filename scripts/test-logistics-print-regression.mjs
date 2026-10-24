import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { PDFDocument } from 'pdf-lib';
import { mapWithConcurrency } from '../utils/concurrency.js';

// Chỉ biên dịch các hàm cần kiểm tra, không import/khởi động server hoặc kết nối DB.
const source = ts.createSourceFile('server.ts',
  fs.readFileSync(new URL('../server.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const declarations = new Map();
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name) declarations.set(node.name.text, node.getText(source));
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    declarations.set(node.name.text, `const ${node.getText(source)};`);
  }
  ts.forEachChild(node, visit);
}
visit(source);

function extract(names, dependencies) {
  const text = names.map((name) => {
    assert.ok(declarations.has(name), `Không tìm thấy khai báo thật: ${name}`);
    return declarations.get(name);
  }).join('\n');
  const js = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  // Cùng realm với pdf-lib để ArrayBuffer/Uint8Array không bị kiểm tra sai kiểu.
  return new Function(...Object.keys(dependencies), `${js}\nreturn {${names.join(',')}};`)(...Object.values(dependencies));
}
const quiet = { log() {}, warn() {}, error() {} };
const uniquePreserveOrder = (values) => [...new Set(values)];
const normalizePrintOrderSn = (value) => String(value || '').replace(/^shopee-/i, '').trim();

for (const otherShop of [false, true]) {
  for (const failure of ['hang', 'throw']) {
    test(`19 PDF vẫn được tải và giữ khi enrich đơn đầu thiếu kiện ${failure}, ${otherShop ? 'khác' : 'cùng'} shop`,
      { timeout: 5000 }, async () => {
        const valid = Array.from({ length: 19 }, (_, i) => ({
          orderSn: `READY${i + 1}`, shopId: 'ready-shop', packageNumber: `PKG${i + 1}`,
        }));
        const missing = { orderSn: 'MISSING', shopId: otherShop ? 'slow-shop' : 'ready-shop' };
        const orders = [missing, ...valid];
        const sns = orders.map((o) => o.orderSn);
        const memory = new Map();
        const marked = [];
        const events = [];
        const enrichCalls = [];
        const downloadCalls = [];
        let active = 0, peak = 0, missingSnapshot;
        const { fetchBatchPdfDocumentsByShopUnshared: fetch } = extract([
          'fetchBatchPdfDocumentsByShopUnshared', 'runBeforeBatchDeadline',
          'buildShopeeShippingDocOrderRows', 'sortBatchPdfResultByRequestedOrder',
          'alignBatchPdfDocumentsToRequestedOrder',
        ], {
          console: quiet, path, PDF_DIR: '/fake-labels',
          fs: { existsSync: () => false },
          AbortController, AbortSignal, setTimeout, clearTimeout,
          BATCH_PDF_MAX_BYTES: 25 * 1024 * 1024,
          SHOPEE_SHIPPING_DOCUMENT_TYPE: 'NORMAL_AIR_WAYBILL',
          uniquePreserveOrder, normalizePrintOrderSn,
          trackingForShopeeShippingDoc: () => undefined,
          isPdfBuffer: (buf) => Buffer.isBuffer(buf) && buf.subarray(0, 5).toString() === '%PDF-',
          getLabelMem: (name) => ({ buf: memory.get(name) }),
          putLabelMem: (name, buf) => memory.set(name, buf),
          readCachedOrderWaybillPdf: async (sn) => memory.get(`order_${sn}.pdf`) || null,
          unlinkWaybillFileQuiet() {},
          describeShopeeWaybillPayloadError: () => ({ error: 'invalid_pdf', message: 'PDF không hợp lệ' }),
          markHasPdfIfLabelFileReady: async (keys) => { marked.push(...keys); },
          getShopeeAccessTokenForApi: async (shopId) => ({ apiShopId: shopId, token: 'fake-token' }),
          mapWithConcurrency: async (groups, concurrency, worker) => {
            assert.equal(concurrency, 1, 'Các nhóm phải chạy tuần tự');
            return mapWithConcurrency(groups, concurrency, async (group) => {
              active++; peak = Math.max(peak, active);
              try { return await worker(group); } finally { active--; }
            });
          },
          enrichOrdersPackageAndTrackingForPrint: async (_shop, _token, group, options) => {
            enrichCalls.push(group.map((o) => o.orderSn));
            events.push(`enrich:${group[0].orderSn}`);
            assert.ok(options.signal instanceof AbortSignal);
            assert.equal(typeof options.deadlineAt, 'number');
            if (!group.some((o) => o.orderSn === 'MISSING')) return;
            missingSnapshot = { cached: memory.size, marked: [...marked], downloads: downloadCalls.length };
            if (failure === 'throw') throw new Error('fake enrichment unavailable');
            return new Promise(() => {}); // Không tạo timer/socket; deadline thật chịu trách nhiệm thoát.
          },
          batchDownloadShopeeWaybillPdf: async (_shop, rows) => {
            const keys = rows.map((r) => r.order_sn);
            downloadCalls.push(keys);
            events.push('download:ready');
            for (const sn of keys) memory.set(`order_${sn}.pdf`, Buffer.from(`%PDF-${sn}`));
            return { success: true, readyOrderSns: keys, skippedOrders: [] };
          },
        });
        const result = await fetch(orders, sns, Date.now() + 250, 'regression');
        const expected = valid.map((o) => o.orderSn);
        assert.deepEqual(enrichCalls, [expected, ['MISSING']], 'Không enrich đơn thiếu trước nhóm đủ kiện');
        assert.deepEqual(downloadCalls, [expected]);
        assert.deepEqual(events, ['enrich:READY1', 'download:ready', 'enrich:MISSING']);
        assert.deepEqual(missingSnapshot, { cached: 19, marked: expected, downloads: 1 },
          'Tất cả PDF đủ kiện phải được giữ trước khi enrich nhóm thiếu bắt đầu');
        assert.equal(peak, 1);
        assert.equal(active, 0);
        assert.deepEqual(result.documents.map((d) => d.orderSns[0]), expected);
        for (const doc of result.documents) {
          assert.strictEqual(doc.buffer, memory.get(`order_${doc.orderSns[0]}.pdf`));
        }
        assert.equal(result.failedOrders.length, 1);
        assert.equal(result.failedOrders[0].orderSn, 'MISSING');
        assert.equal(result.failedOrders[0].error, failure === 'hang' ? 'document_not_ready' : 'fatal_error');
      });
  }
}

test('bulk 19 đơn một kiện không chứa đơn hai kiện; tải riêng giữ hai trang và không tải lại 19 đơn',
  { timeout: 10000 }, async () => {
    const singles = Array.from({ length: 19 }, (_, i) => ({ order_sn: `S${i + 1}`, package_number: `P${i + 1}` }));
    const multi = [{ order_sn: 'MULTI', package_number: 'MULTI-P1' }, { order_sn: 'MULTI', package_number: 'MULTI-P2' }];
    const input = [multi[0], ...singles, multi[1]];
    const files = new Map(), memory = new Map();
    const creates = [], polls = [], downloads = [], sleeps = [];
    const dimensions = new Map(input.map((row, i) => [row.package_number, [200 + i, 400 + i]]));
    const { batchDownloadShopeeWaybillPdf: download } = extract([
      'batchDownloadShopeeWaybillPdf', 'splitMergedWaybillPdfToOrders',
      'splitMergedWaybillPdfToOrdersUnqueued', 'mapWaybillSettled',
      'toShippingDocApiItems', 'shippingDocRowKey', 'waybillDownloadBudgetMs',
      'isBenignCreateShippingFail', 'cacheOrderWaybillPdf',
      'SHOPEE_SHIPPING_DOCUMENT_TYPE', 'SHOPEE_SHIPPING_DOC_BULK_MAX',
      'PRINT_WAYBILL_BATCH_POLL_MAX_ATTEMPTS', 'PRINT_WAYBILL_BATCH_POLL_INTERVAL_MS',
      'PRINT_WAYBILL_DOWNLOAD_PAUSE_MS', 'PRINT_WAYBILL_DOWNLOAD_TIMEOUT_CAP_MS',
      'PRINT_WAYBILL_DOWNLOAD_CONCURRENCY',
    ], {
      console: quiet, path, PDF_DIR: '/fake-labels', Buffer, PDFDocument,
      fs: { existsSync: () => false, promises: { readFile: async (name) => {
        assert.ok(files.has(name), `Chưa có PDF giả lập ${name}`);
        return files.get(name);
      } } },
      getValidShopeeAccessToken: async () => 'fake-token',
      isShopeeInternalTrackingCode: () => false,
      uniquePreserveOrder,
      pdfMergeGate: { run: (fn) => fn() },
      yieldEventLoop: async () => {},
      sleepMs: async (ms) => { sleeps.push(ms); },
      buildCachedLabelFilename: () => 'bulk-singles.pdf',
      isPdfBuffer: (buf) => Buffer.isBuffer(buf) && buf.subarray(0, 5).toString() === '%PDF-',
      putLabelMem: (name, buf) => memory.set(name, buf),
      unlinkWaybillFileQuiet() {},
      shopeeCreateShippingDocument: async (_shop, _token, rows) => {
        creates.push(structuredClone(rows));
        return { response: { result_list: [] } };
      },
      shopeeGetShippingDocumentResult: async (_shop, _token, rows) => {
        polls.push(structuredClone(rows));
        return { response: { result_list: rows.map((r) => ({ ...r, status: 'READY' })) } };
      },
      shopeeDownloadShippingDocument: async (_shop, _token, rows, filename) => {
        downloads.push({ rows: structuredClone(rows), filename });
        const pdf = await PDFDocument.create();
        for (const row of rows) pdf.addPage(dimensions.get(row.package_number));
        const buf = Buffer.from(await pdf.save());
        const filePath = path.join('/fake-labels', filename);
        files.set(filePath, buf);
        return { filename, filePath, size: buf.length, contentType: 'application/pdf' };
      },
    });
    const result = await download('shop', input, { deadlineAt: Date.now() + 120000 });
    const rowKeys = (rows) => rows.map((r) => `${r.order_sn}:${r.package_number}`);
    const sortedKeys = (rows) => rowKeys(rows).sort();
    const expectedKeys = sortedKeys(input);
    assert.equal(result.success, true);
    assert.deepEqual(result.skippedOrders, []);
    assert.equal(creates.length, 1, 'Chỉ một lần create cho toàn lô');
    assert.deepEqual(sortedKeys(creates[0]), expectedKeys, 'Create bao gồm cả hai kiện của đơn nhiều kiện');
    assert.equal(polls.length, 1, 'Mọi kiện READY ngay lần poll đầu');
    assert.deepEqual(sortedKeys(polls[0]), expectedKeys);
    assert.deepEqual(sleeps, [], 'Không đợi thêm khi mọi kiện đã READY');
    assert.equal(downloads.length, 2, 'Chỉ một bulk và một request riêng cho đơn hai kiện');
    assert.deepEqual(rowKeys(downloads[0].rows), rowKeys(singles), 'Bulk download chỉ chứa 19 đơn một kiện');
    assert.deepEqual(rowKeys(downloads[1].rows), rowKeys(multi), 'Đơn hai kiện tải đúng 2 row trong 1 request');
    assert.equal(downloads[1].filename, 'order_MULTI.pdf');
    for (const call of [...creates, ...polls, ...downloads.map((d) => d.rows)]) {
      assert.ok(call.every((r) => r.shipping_document_type === 'NORMAL_AIR_WAYBILL'));
    }
    assert.deepEqual([...result.readyOrderSns].sort(), [...new Set(input.map((r) => r.order_sn))].sort());
    assert.equal(result.readyOrderSns.length, 20);
    assert.deepEqual(rowKeys(result.readyOrderRows).sort(), rowKeys(input).sort());
    for (const row of singles) {
      const pdf = await PDFDocument.load(memory.get(`order_${row.order_sn}.pdf`));
      assert.equal(pdf.getPageCount(), 1);
      const { width, height } = pdf.getPage(0).getSize();
      assert.deepEqual([width, height], dimensions.get(row.package_number), 'Split phải giữ đúng trang theo đơn');
    }
    const multiPdf = await PDFDocument.load(memory.get('order_MULTI.pdf'));
    assert.equal(multiPdf.getPageCount(), 2, 'Không mất trang thứ hai của đơn nhiều kiện');
    assert.deepEqual(multiPdf.getPages().map((page) => {
      const { width, height } = page.getSize(); return [width, height];
    }), multi.map((row) => dimensions.get(row.package_number)));
  });

for (const budget of ['expired', 'aborted']) {
  test(`enrich ${budget} không gọi API mới hoặc persist`, async () => {
    const calls = [];
    const boundary = (name) => async () => { calls.push(name); return {}; };
    const controller = new AbortController();
    if (budget === 'aborted') controller.abort(new Error('fake cancellation'));
    const { enrichOrdersPackageAndTrackingForPrint: enrich } = extract([
      'enrichOrdersPackageAndTrackingForPrint', 'SHOPEE_ORDER_DETAIL_MAX_ORDER_SNS',
    ], {
      console: quiet,
      shopeeGetOrderDetail: boundary('detail'),
      shopeeGetTrackingNumber: boundary('tracking'),
      shopeeGetShippingDocumentDataInfo: boundary('document-info'),
      persistOrderTrackingToDb: boundary('persist'),
    });
    const orders = [{ orderSn: 'MISSING' }, { orderSn: 'READY', packageNumber: 'PKG', trackingNumber: 'CARRIER' }];
    const before = structuredClone(orders);
    await enrich('shop', 'fake-token', orders, {
      deadlineAt: budget === 'expired' ? Date.now() - 1 : Date.now() + 60000,
      signal: controller.signal,
    });
    assert.deepEqual(calls, []);
    assert.deepEqual(orders, before);
  });
}
