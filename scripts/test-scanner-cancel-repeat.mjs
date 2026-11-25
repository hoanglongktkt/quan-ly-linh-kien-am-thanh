import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { transform } from 'esbuild';
const source = fs.readFileSync('src/components/OrderManager.tsx', 'utf8');
const helper = source.slice(source.indexOf('  const isCodeAlreadyVerified ='), source.indexOf('  /**', source.indexOf('  const isCodeAlreadyVerified =')));
const start = source.indexOf('  const verifySingleOrder = React.useCallback(');
const end = source.indexOf('\n  useEffect(', start);
const { code } = await transform(helper + source.slice(start, end) + '\nglobalThis.verify = verifySingleOrder;', { loader: 'tsx' });
const ref = current => ({ current });
const cancelled = { id: 'shopee-ORDER123', orderSn: 'ORDER123', status: 'cancelled', trackingNumber: 'SPX123456789' };
let current = cancelled;
let banner = '';
const ctx = {
  console, Math, Date, queueMicrotask,
  React: { useCallback: fn => fn }, isFlushingQueue: false,
  isTearingDownScannerRef: ref(false), lastQrScanRef: ref({key: '', at: 0}),
  isScanBusyRef: ref(false), pendingScanQueueRef: ref([]), scannerModeRef: ref('handover'),
  daXuatKhoListRef: ref([]), donHuyListRef: ref([]), daNhanHoanListRef: ref([]), scannerSyncMapRef: ref(new Map()), scanGunInputRef: ref(null),
  normalizeOrderScanKey: value => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, ''),
  localStorage: {getItem: () => 'token'},
  lookupCurrentScannerOrder: async () => current,
  lookupScannerSyncMap: () => null, putOrderIntoScannerSyncMap: m => m,
  scannedMatchesReturnWaybill: () => false,
  resolveOrderBadgeStatus: o => o.status, getShopeeOrderRawStatus: o => o.status.toUpperCase(),
  resolveCancelReturnKind: () => 'cancelled',
  classifyScanCancelReturnBuckets: o => ({isCancelBucket: o.status === 'cancelled', isReturnBucket: o.status === 'return_pending'}),
  isShopeeRtsFailedDelivery: () => false, matchesShippingTab: () => false,
  getOrderWaybillCode: o => o.trackingNumber,
  isReturnScanLocked: o => o.isReturnReceived === true,
  SCANNED_ORDER_MESSAGE: 'ALREADY_SCANNED',
  setCameraScanResult: value => {banner = value;},
  setDonHuyList: value => {ctx.donHuyListRef.current = value;},
  document: {activeElement: null},
};
for (const name of ['playScanSound','vibrateScan','flashViewfinder','showScanToast','setIsVerifyingScan','setIsScanBusy']) ctx[name] = () => {};
vm.createContext(ctx);
vm.runInContext(code, ctx);
async function scan(value = 'SPX123456789') {
  ctx.lastQrScanRef.current = {key: '', at: 0};
  await ctx.verify(value);
}
await scan();
assert.ok(banner.includes('ORDER123'));
await scan();
assert.ok(banner.includes('ORDER123'), 'repeat cancellation displays order number');
await scan('ORDER123');
assert.ok(banner.includes('ORDER123'), 'alternate code still displays warning');
assert.equal(ctx.donHuyListRef.current.length, 1, 'repeat scans count/save once');
assert.equal(ctx.daXuatKhoListRef.current.length, 0, 'cancelled parcels never leave warehouse');
ctx.donHuyListRef.current = [];
current = {...cancelled, isReturnReceived: true};
await scan();
assert.ok(banner.includes('ORDER123'), 'stored cancellations remain inspectable in handover mode');
assert.equal(ctx.donHuyListRef.current.length, 0, 'stored parcels are not queued for another save');
ctx.scannerModeRef.current = 'return';
await scan();
assert.equal(banner, 'ALREADY_SCANNED', 'return intake remains locked');
ctx.scannerModeRef.current = 'handover';
current = {...cancelled, status: 'processed'};
ctx.daXuatKhoListRef.current = [{code:'SPX123456789',orderSn:'ORDER123'}];
await scan();
assert.equal(banner, 'ALREADY_SCANNED', 'normal handover deduplication remains enabled');
console.log('PASS: repeat cancellation, alias, unique count, no handover, stored cancellation, return lock, normal duplicate');
