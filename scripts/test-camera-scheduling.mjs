import assert from 'node:assert/strict';
import { build } from 'esbuild';
await build({ entryPoints: ['src/utils/cameraScanner.ts'], bundle: true, platform: 'node', format: 'esm', outfile: 'tmp/camera-scheduling-test.mjs',
  plugins: [{ name: 'fake-decoders', setup(b) {
    b.onResolve({ filter: /^@zxing\// }, args => ({ path: args.path, namespace: 'decoder' }));
    b.onLoad({ filter: /.*/, namespace: 'decoder' }, ({ path }) => ({ contents: path.endsWith('/browser') ? `
      export class BrowserMultiFormatReader {
        constructor(hints) { this.hints = hints; }
        decodeFromCanvas(canvas) {
          const state = globalThis.__cameraTest;
          state.attempts.push({ at: state.now, hard: this.hints.has('hard'), width: canvas.width });
          if (state.zxingValue) return { getText: () => state.zxingValue };
          throw new Error('NotFound');
        }
      }` : `export const DecodeHintType = { POSSIBLE_FORMATS: 'formats', TRY_HARDER: 'hard' };
        export const BarcodeFormat = { QR_CODE: 'qr', CODE_128: 'code128' };`, loader: 'js' }));
  } }],
});
const { startLiveQrScanner } = await import('../tmp/camera-scheduling-test.mjs');
function setup(nativeMode) {
  const state = { now: 0, attempts: [], nativeValue: '', zxingValue: '', events: [], stopped: false, raf: new Map(), id: 0 };
  globalThis.__cameraTest = state;
  globalThis.performance = { now: () => state.now };
  const track = { getSettings: () => ({ deviceId: 'rear' }), getCapabilities: () => ({}), stop: () => { state.stopped = true; } };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Android', mediaDevices: {
    enumerateDevices: async () => [], getUserMedia: async () => ({ getVideoTracks: () => [track], getTracks: () => [track] }),
  } } });
  globalThis.localStorage = { getItem: () => null };
  globalThis.requestAnimationFrame = callback => { const id = ++state.id; state.raf.set(id, callback); return id; };
  globalThis.cancelAnimationFrame = id => state.raf.delete(id);
  globalThis.window = { isSecureContext: true, setTimeout: () => 0 };
  if (nativeMode) window.BarcodeDetector = class {
    constructor({ formats }) { if (nativeMode === 'qr' && formats.length > 1) throw new Error('qr only'); }
    async detect() { return state.nativeValue ? [{ rawValue: state.nativeValue }] : []; }
  };
  const container = { innerHTML: '', isConnected: true, appendChild(video) { video.parentNode = this; }, removeChild() {} };
  globalThis.document = { getElementById: () => container, createElement(tag) {
    return tag === 'video' ? { setAttribute() {}, style: {}, play: async () => {}, videoWidth: 1280, videoHeight: 720, readyState: 2 }
      : { width: 0, height: 0, getContext: () => ({ drawImage() {} }) };
  } };
  state.step = async time => {
    state.now = time;
    const callbacks = [...state.raf.values()]; state.raf.clear();
    callbacks.forEach(callback => callback(time));
    await Promise.resolve(); await Promise.resolve();
  };
  return state;
}
let state = setup('full');
let handle = await startLiveQrScanner({ containerId: 'test', onSuccess: value => state.events.push(value) });
await state.step(100); await state.step(600);
assert.equal(state.attempts.length, 0, 'native reader gets the first frames without duplicate JS decode');
await state.step(720);
assert.equal(state.attempts.length, 1, 'fallback starts when native fails to read the label');
await state.step(800);
assert.equal(state.attempts.length, 1, 'fallback is throttled');
state.nativeValue = 'SPX123';
await state.step(1000); await state.step(1100);
assert.deepEqual(state.events, ['SPX123'], 'native duplicate frames emit only one result');
assert.equal(state.attempts.length, 1, 'native success suspends the expensive fallback');
await handle.stop();
await state.step(3000);
assert.equal(state.raf.size, 0); assert.ok(state.stopped);

for (const nativeMode of [null, 'qr']) {
  state = setup(nativeMode);
  handle = await startLiveQrScanner({ containerId: 'test', onSuccess: value => state.events.push(value) });
  for (const time of [80, 160, 240, 320]) await state.step(time);
  assert.deepEqual(state.attempts.map(attempt => attempt.hard), [false, false, false, true], 'hard labels retain periodic TRY_HARDER decoding');
  assert.equal(state.attempts[0].width, 1280, 'retain thin barcode bars');
  state.zxingValue = 'SPX456';
  await state.step(400);
  assert.deepEqual(state.events, ['SPX456'], 'barcode scanning remains available without a full native detector');
  await handle.stop(); await state.step(2000);
  assert.equal(state.raf.size, 0); assert.ok(state.stopped);
}
console.log('PASS: native priority, throttled fallback, duplicate suppression, ZXing-only/QR-only browsers, hard labels, full barcode width, teardown');
