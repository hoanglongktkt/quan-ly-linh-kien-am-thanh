import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createWorkGate, createKeyedBatchWork, shopeeHttpGate } from '../utils/workGate.js';
import { fetchWithTimeout } from '../modules/shopee-sync/client.js';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test('concurrent callers share one bounded gate and recover after a failed worker', async () => {
  const gate = createWorkGate(2);
  let active = 0, peak = 0;
  const results = await Promise.allSettled(Array.from({length: 30}, (_, i) => gate.run(async () => {
    active++; peak = Math.max(peak, active);
    try { await delay(2); if (i === 7) throw new Error('failure'); return i; }
    finally { active--; }
  })));
  assert.equal(peak, 2);
  assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
  assert.equal(gate.snapshot().active, 0);
  assert.equal(gate.snapshot().pending, 0);
});

test('queued abort never starts work; queue full rejects without retaining more jobs', async () => {
  const gate = createWorkGate(1, 1);
  const release = await gate.acquire();
  const controller = new AbortController();
  let called = false;
  const waiting = gate.run(() => { called = true; }, controller.signal);
  const rejected = assert.rejects(waiting, /cancelled/);
  await assert.rejects(gate.acquire(), {code: 'work_queue_full'});
  controller.abort(new Error('cancelled'));
  await rejected;
  release(); release();
  assert.equal(called, false);
  assert.equal(gate.snapshot().active, 0);
  assert.equal(gate.snapshot().pending, 0);
});

test('overlapping batches generate each label once and preserve requested order', async () => {
  const share = createKeyedBatchWork(createWorkGate(1));
  const started = deferred(), finish = deferred();
  const calls = [];
  const worker = async (keys) => {
    calls.push(keys); started.resolve(); await finish.promise;
    return new Map(keys.map((key) => [key, `pdf:${key}`]));
  };
  const first = share(['A','B'], worker);
  await started.promise;
  const second = share(['B','C','A'], worker);
  finish.resolve();
  assert.deepEqual(await first, ['pdf:A','pdf:B']);
  assert.deepEqual(await second, ['pdf:B','pdf:C','pdf:A']);
  assert.deepEqual(calls, [['A','B'], ['C']]);
});

test('reader cancellation does not kill shared generation; errors allow a later retry', async () => {
  const share = createKeyedBatchWork(createWorkGate(1));
  const started = deferred(), finish = deferred();
  const controller = new AbortController();
  let calls = 0;
  const worker = async (keys) => { calls++; started.resolve(); await finish.promise; return new Map(keys.map((k) => [k,k])); };
  const first = share(['A'], worker, controller.signal);
  const rejected = assert.rejects(first, /cancelled/);
  await started.promise;
  const second = share(['A'], worker);
  controller.abort(new Error('cancelled'));
  await rejected;
  finish.resolve();
  assert.deepEqual(await second, ['A']);
  assert.equal(calls, 1);
  await assert.rejects(share(['X'], async () => { throw new Error('Shopee failed'); }), /Shopee failed/);
  assert.deepEqual(await share(['X'], worker), ['X']);
});

test('key capacity is bounded and is reclaimed after completion', async () => {
  const share = createKeyedBatchWork(createWorkGate(1), 2);
  const finish = deferred();
  const worker = async (keys) => { await finish.promise; return new Map(keys.map((key) => [key,key])); };
  const first = share(['A','B'], worker);
  await assert.rejects(share(['C'], worker), {code: 'work_queue_full'});
  finish.resolve();
  await first;
  assert.deepEqual(await share(['C'], worker), ['C']);
});

test('HTTP slots cover body consumption, queued cancellation, and release on failures', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response('{"ok":true}');
  });
  const held = await Promise.all(Array.from({length:3}, () => fetchWithTimeout('https://example.invalid', {}, 1000)));
  assert.equal(shopeeHttpGate.snapshot().active, 3);
  const controller = new AbortController();
  const cancelled = fetchWithTimeout('https://example.invalid', {signal:controller.signal}, 1000);
  const rejected = assert.rejects(cancelled);
  controller.abort();
  await rejected;
  assert.equal(calls, 3);
  const queued = fetchWithTimeout('https://example.invalid', {}, 1000);
  await delay(5);
  assert.equal(calls, 3, 'headers alone must not release a slot');
  await held[0].json();
  const fourth = await queued;
  assert.equal(calls, 4);
  await Promise.all([held[1].text(), held[2].arrayBuffer(), fourth.json()]);
  assert.equal(shopeeHttpGate.snapshot().active, 0);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('network failure'); });
  await assert.rejects(fetchWithTimeout('https://example.invalid', {}, 50));
  assert.equal(shopeeHttpGate.snapshot().active, 0);
});

test('server print coordinator serves cached labels while a slow overlapping batch is running', async () => {
  const source = ts.createSourceFile('server.ts', fs.readFileSync(new URL('../server.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  let fn;
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'fetchBatchPdfDocumentsByShop') fn = node.getText(source);
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(fn, 'exercise the real server wrapper');
  const gate = createWorkGate(1);
  const share = createKeyedBatchWork(gate);
  const started = deferred(), finish = deferred();
  const calls = [];
  const context = vm.createContext({
    AbortSignal, Set, Map,
    uniquePreserveOrder: (keys) => [...new Set(keys)],
    readCachedOrderWaybillPdf: async (sn) => sn === 'READY' ? Buffer.from('%PDF-cached') : null,
    sharedLabelWork: share,
    fetchBatchPdfDocumentsByShopUnshared: async (_orders, keys) => {
      calls.push([...keys]); started.resolve(); await finish.promise;
      return {documents: keys.map((sn) => ({orderSns:[sn], buffer:Buffer.from(`%PDF-${sn}`)})), failedOrders:[]};
    },
    sortBatchPdfResultByRequestedOrder: (sns, docs, failed) => ({
      documents: sns.flatMap((sn) => docs.filter((doc) => doc.orderSns.includes(sn))), failedOrders:failed,
    }),
  });
  vm.runInContext(ts.transpileModule(fn, {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
  const fetch = context.fetchBatchPdfDocumentsByShop;
  const first = fetch([], ['A','B'], Date.now()+2000, 'background');
  await started.promise;
  const second = fetch([], ['B','A'], Date.now()+2000, 'print');
  const cached = await fetch([], ['READY'], Date.now()+2000, 'reprint');
  assert.equal(cached.documents[0].buffer.toString(), '%PDF-cached');
  assert.equal(gate.snapshot().active, 1);
  finish.resolve();
  assert.deepEqual((await first).documents.map((d) => d.orderSns[0]), ['A','B']);
  assert.deepEqual((await second).documents.map((d) => d.orderSns[0]), ['B','A']);
  assert.deepEqual(calls, [['A','B']]);
});
