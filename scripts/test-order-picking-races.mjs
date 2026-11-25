import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

// Thực thi callback thật từ component, không cần DOM hoặc kết nối máy chủ.
const source = ts.createSourceFile('OrderPicking.tsx',
  fs.readFileSync(new URL('../src/components/OrderPicking.tsx', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function callback(name) {
  let expression;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) {
      expression = node.initializer;
      if (ts.isCallExpression(expression) && expression.expression.getText(source) === 'useCallback') {
        expression = expression.arguments[0];
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(expression, `Missing actual callback ${name}`);
  return ts.transpileModule(`const action = ${expression.getText(source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
}
function bind(name, dependencies) {
  return new Function(...Object.keys(dependencies), `${callback(name)}; return action;`)(...Object.values(dependencies));
}
const ref = (current) => ({ current });
const noop = () => {};

test('lookup: kết quả A trả muộn không ghi đè đơn B và không xóa các dòng đã nhặt', async () => {
  const pending = new Map();
  const state = { active: null, picked: new Set(['picked-B']) };
  const mountedRef = ref(true);
  const activeOrderRef = ref(null);
  const lookupAbortRef = ref(null);
  const dependencies = {
    mountedRef, activeOrderRef, lookupAbortRef, lookupSeqRef: ref(0), submittingRef: ref(false),
    localStorage: { getItem: () => 'mock-token' }, AbortController, orders: [],
    isPickableOrder: () => true, findOrderByScanPayload: () => null,
    lookupOrderByScanCode: (code) => new Promise(resolve => pending.set(code, resolve)),
    rejectWrongStatus: () => assert.fail('Stale lookup must not reject the active order'),
    scanFeedback: noop, console: { warn: noop }, setScanError: noop,
    setScanInput: noop, setCameraOpen: noop,
    setActiveOrder: order => { state.active = order; },
    setPickedKeys: keys => { state.picked = keys; },
  };
  const lookup = bind('lookupOrder', dependencies);
  const a = lookup('CODE-A');
  const aSignal = lookupAbortRef.current.signal;
  const b = lookup('CODE-B');
  assert.equal(aSignal.aborted, true);
  pending.get('CODE-B')({ id: 'B', orderSn: 'B', items: [{ productId: 'P' }] });
  await b;
  state.picked.add('picked-B');
  pending.get('CODE-A')({ id: 'A', orderSn: 'A', items: [{ productId: 'P' }] });
  await a;
  assert.equal(state.active.id, 'B');
  assert.equal(activeOrderRef.current.id, 'B');
  assert.ok(state.picked.has('picked-B'));
  await lookup('CODE-C');
  assert.equal(pending.has('CODE-C'), false, 'Không quét đè đơn đang nhặt');
});

function packingHarness(mode) {
  const order = { id: 'A', orderSn: 'A', channel: 'shopee' };
  const state = { requests: 0, error: '', submitting: false, packed: 0, reset: 0, cleanups: 0 };
  const mountedRef = ref(true);
  const packingAbortRef = ref(null);
  const dependencies = {
    activeOrder: order, canPick: true, submitting: false, allPicked: true,
    submittingRef: ref(false), packingAbortRef, activeOrderRef: ref(order), mountedRef,
    AbortController, safeGetItem: () => 'mock-token', alert: noop,
    setSubmitting: value => { state.submitting = value; },
    setScanError: value => { state.error = value; },
    createTimeoutSignal: (_ms, parent) => {
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      parent.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(onAbort, 15);
      return { signal: controller.signal, cleanup: () => {
        state.cleanups++;
        clearTimeout(timer);
        parent.removeEventListener('abort', onAbort);
      } };
    },
    fetch: async (_url, { signal }) => {
      state.requests++;
      if (mode === 'headers') return new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      return new Response(new ReadableStream({ start(controller) {
        signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      } }));
    },
    readResponseJson: async response => JSON.parse(await response.text()),
    isAbortError: error => error?.name === 'AbortError',
    onOrderPacked: () => { state.packed++; }, onAddLog: noop, vibratePick: noop,
    resetSession: () => { state.reset++; },
  };
  return { run: bind('handleMoveToPacking', dependencies), state, dependencies };
}
for (const mode of ['headers', 'body']) {
  test(`packing: timeout ${mode} nhả khóa và báo kết quả chưa xác định`, async () => {
    const { run, state, dependencies } = packingHarness(mode);
    await Promise.all([run(), run()]);
    assert.equal(state.requests, 1, 'Khóa đồng bộ chặn double-submit');
    assert.equal(state.cleanups, 1);
    assert.equal(state.submitting, false);
    assert.equal(dependencies.submittingRef.current, false);
    assert.equal(state.packed, 0);
    assert.match(state.error, /Chưa xác nhận được kết quả/);
  });
}
test('packing: unmount trong lúc chờ không báo lỗi hoặc điều hướng trễ', async () => {
  const { run, state, dependencies } = packingHarness('headers');
  const request = run();
  dependencies.mountedRef.current = false;
  dependencies.packingAbortRef.current.abort();
  await request;
  assert.equal(state.error, '');
  assert.equal(state.reset, 0);
  assert.equal(state.packed, 0);
  assert.equal(state.cleanups, 1);
});
