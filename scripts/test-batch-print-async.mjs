import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createPrintJobs } from '../utils/printJobs.js';

test('print acknowledgement is immediate, progress and result belong to the initiating user', async () => {
  const jobs = createPrintJobs();
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const id = jobs.start('long', async (_signal, progress) => {
    progress('merging');
    await pending;
    return { filename: 'merged.pdf', printedOrders: ['A'] };
  });
  assert.equal(jobs.get(id, 'someone-else'), null);
  assert.equal(jobs.get(id, 'long').status, 'running');
  await delay(0);
  assert.equal(jobs.get(id, 'long').message, 'merging');
  finish();
  await delay(0);
  assert.equal(jobs.get(id, 'long').status, 'done');
  assert.equal(jobs.get(id, 'long').result.filename, 'merged.pdf');
});

test('stalled work fails at deadline, cannot overwrite failure or release its slot early', async () => {
  const jobs = createPrintJobs({ timeoutMs: 15, maxActive: 1 });
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  let signal;
  const id = jobs.start('long', async (s) => { signal = s; await pending; return 'late'; });
  await delay(30);
  assert.equal(signal.aborted, true);
  assert.equal(jobs.get(id, 'long').status, 'failed');
  assert.throws(() => jobs.start('long', async () => {}), /đầy/);
  finish();
  await delay(0);
  assert.equal(jobs.get(id, 'long').status, 'failed');
  assert.equal(jobs.get(id, 'long').result, undefined);
  assert.ok(jobs.start('long', async () => 'recovered'));
});

function frontend(fetch) {
  const source = fs.readFileSync(new URL('../src/utils/batchPrint.ts', import.meta.url), 'utf8');
  const context = vm.createContext({ fetch, Response, Headers, AbortSignal, setTimeout, clearTimeout, exports: {} });
  vm.runInContext(ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText, context);
  return context.exports.fetchMergedPrint;
}

test('frontend polls short requests then downloads the file, keeping partial success metadata', async () => {
  const calls = [];
  const messages = [];
  const print = frontend(async (url, init) => {
    calls.push([url, init.method || 'GET']);
    if (url.endsWith('-async')) return Response.json({ jobId: 'job1' }, { status: 202 });
    if (url.includes('-jobs/')) return Response.json({ status: 'done', result: {
      filename: 'reprint.pdf', total: 2, printedOrders: ['A'], failedOrders: [{ orderSn: 'B' }],
    } });
    return new Response('%PDF-ready', { headers: { 'content-type': 'application/pdf' } });
  });
  const result = await print({ headers: {}, body: '{}', signal: new AbortController().signal,
    onProgress: (message) => messages.push(message) });
  assert.equal(await result.text(), '%PDF-ready');
  assert.equal(result.headers.get('X-Print-Printed-Orders'), 'A');
  assert.equal(result.headers.get('X-Print-Failed-Orders'), 'B');
  assert.equal(result.headers.get('X-Print-Total'), '2');
  assert.deepEqual(calls, [
    ['/api/orders/batch-print-async', 'POST'],
    ['/api/orders/batch-print-jobs/job1', 'GET'],
    ['/api/public/labels/reprint.pdf', 'GET'],
  ]);
  assert.equal(messages.length, 1);
});

test('frontend reports failed or expired jobs without downloading or marking orders', async () => {
  for (const expired of [false, true]) {
    let calls = 0;
    const print = frontend(async () => {
      calls++;
      return calls === 1 ? Response.json({jobId:'job1'}, {status:202})
        : Response.json({ status:'failed', message:'try printing again' }, {status:expired ? 404 : 200});
    });
    await assert.rejects(print({ headers:{}, body:'{}', signal:new AbortController().signal }), /try printing again/);
    assert.equal(calls, 2);
  }
});

test('frontend cancels a stalled PDF body instead of hanging after headers', async () => {
  const controller = new AbortController();
  const print = frontend(async (url, {signal}) => {
    if (url.endsWith('-async')) return Response.json({jobId:'job1'}, {status:202});
    if (url.includes('-jobs/')) return Response.json({status:'done', result:{filename:'file.pdf', printedOrders:['A']}});
    const stream = new ReadableStream({ start(streamController) {
      signal.addEventListener('abort', () => streamController.error(signal.reason), {once:true});
    } });
    setTimeout(() => controller.abort(new Error('cancel stalled body')), 10);
    return new Response(stream, {headers:{'content-type':'application/pdf'}});
  });
  await assert.rejects(print({headers:{}, body:'{}', signal:controller.signal}), /cancel stalled body/);
});

test('frontend remains compatible until cPanel is updated, without retrying accepted jobs', async () => {
  const calls = [];
  const print = frontend(async (url) => {
    calls.push(url);
    return calls.length === 1 ? new Response('Not Found', {status:404})
      : new Response('%PDF-legacy', {headers:{'content-type':'application/pdf'}});
  });
  const result = await print({headers:{}, body:'{}', signal:new AbortController().signal});
  assert.equal(await result.text(), '%PDF-legacy');
  assert.deepEqual(calls, ['/api/orders/batch-print-async', '/api/orders/batch-print']);
});

test('registered async routes detach from HTTP and pass cancellation to the existing print route', async () => {
  const source = fs.readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
  const start = source.indexOf('  const mergedPrintJobs = createPrintJobs();');
  const end = source.indexOf('  app.post("/api/orders/batch-print",', start);
  assert.ok(start > 0 && end > start);
  const handlers = new Map();
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const context = vm.createContext({
    createPrintJobs, String, Error,
    parseBatchPrintOrderSns: (body) => body.orderSns,
    authMiddleware() {},
    app: { post: (url, _auth, handler) => handlers.set(url, handler),
      get: (url, _auth, handler) => handlers.set(url, handler) },
    batchPrintOnlyRoute: async (req, res) => {
      assert.equal(req.path, '/api/orders/batch-print-only');
      assert.ok(req.printJobSignal);
      req.printProgress('merging');
      await pending;
      res.json({success:true, filename:'merged.pdf', printedOrders:['A']});
    },
  });
  vm.runInContext(ts.transpileModule(source.slice(start, end), {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText, context);
  const response = () => ({ code:200, body:null, status(code) {this.code=code;return this;},
    json(body) {this.body=body;return this;}, setHeader() {} });
  const res = response();
  handlers.get('/api/orders/batch-print-async')({body:{orderSns:['A']}, user:{username:'long'}}, res);
  assert.equal(res.code, 202);
  assert.ok(res.body.jobId);
  await delay(0);
  const statusReq = {params:{id:res.body.jobId}, user:{username:'long'}};
  const status = response();
  handlers.get('/api/orders/batch-print-jobs/:id')(statusReq, status);
  assert.equal(status.body.status, 'running');
  finish();
  await delay(0);
  handlers.get('/api/orders/batch-print-jobs/:id')(statusReq, status);
  assert.equal(status.body.result.filename, 'merged.pdf');
});
