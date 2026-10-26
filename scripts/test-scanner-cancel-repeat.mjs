import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import ts from 'typescript';
const path = new URL('../src/components/OrderManager.tsx', import.meta.url);
const source = fs.readFileSync(path, 'utf8');
const start = source.indexOf('    async (rawQuery: string) => {', source.indexOf('const verifySingleOrder ='));
const end = source.indexOf('\n    [isFlushingQueue]', start);
const callback = source.slice(start, end).trim().replace(/,$/, '');
const code = ts.transpile(`globalThis.verifySingleOrder = ${callback}`, {target: ts.ScriptTarget.ES2022});
function harness({mode='return', locked=false, failed=false, cancel=true}={}) {
  let time=1000, lookups=0, message='', toast='';
  const outbound={current:[]}, cancelled={current:[]}, returned={current:[]};
  const order={id:'shopee-ORDER123',orderSn:'ORDER123',trackingNumber:'SPXVN123456',status:cancel?'cancelled':'processed',locked};
  const norm=(x)=>String(x||'').toUpperCase().replace(/[-\s]/g,'');
  const ctx={console, Date:{now:()=>time}, Math, queueMicrotask, window:{}, document:{activeElement:null},
    isFlushingQueue:false,isTearingDownScannerRef:{current:false},lastQrScanRef:{current:{key:'',at:0}},
    normalizeOrderScanKey:norm,
    isCodeAlreadyVerified:(key)=>Boolean(key)&&[...outbound.current,...cancelled.current,...returned.current].some(i=>norm(i.code)===key||norm(i.orderSn)===key),
    donHuyListRef:cancelled,daNhanHoanListRef:returned,daXuatKhoListRef:outbound,
    isScanBusyRef:{current:false},pendingScanQueueRef:{current:[]},scannerModeRef:{current:mode},scannerSyncMapRef:{current:new Map()},
    setIsVerifyingScan:()=>{},setIsScanBusy:()=>{},playScanSound:()=>{},vibrateScan:()=>{},flashViewfinder:()=>{},
    setCameraScanResult:(v)=>message=v,showScanToast:(v)=>toast=v,
    SCANNED_ORDER_MESSAGE:'ĐƠN ĐÃ QUÉT', localStorage:{getItem:()=>''},
    lookupCurrentScannerOrder:async()=>{lookups++;return order;},scannedMatchesReturnWaybill:()=>false,
    putOrderIntoScannerSyncMap:()=>new Map(),ScanLookupError:class extends Error{},
    resolveOrderBadgeStatus:()=>order.status,getShopeeOrderRawStatus:()=>cancel?'CANCELLED':'PROCESSED',
    resolveCancelReturnKind:()=>cancel?(failed?'failed_delivery':'cancelled'):null,
    classifyScanCancelReturnBuckets:()=>({isReturnBucket:false,isCancelBucket:cancel}),
    isShopeeRtsFailedDelivery:()=>failed,matchesShippingTab:()=>false,getOrderWaybillCode:()=>order.trackingNumber,
    isReturnScanLocked:()=>locked,isEligibleForHandOverToCarrier:()=>!cancel,
    setDonHuyList:(fn)=>cancelled.current=fn(cancelled.current),setDaNhanHoanList:(fn)=>returned.current=fn(returned.current),
    setDaXuatKhoList:(fn)=>outbound.current=fn(outbound.current),scanGunInputRef:{current:null},
  };
  vm.runInNewContext(code,ctx);
  return {scan:async(value)=>{time+=500;await ctx.verifySingleOrder(value);},get message(){return message},get toast(){return toast},get lookups(){return lookups},outbound,cancelled,returned};
}
for (const mode of ['return','handover']) {
  const h=harness({mode});
  await h.scan('SPXVN123456');
  const rows=()=>h.cancelled.current.length+h.returned.current.length;
  assert.equal(rows(),1);
  await h.scan('SPXVN123456');
  assert.match(h.message,/ĐƠN HỦY.*SPXVN123456.*ORDER123/);
  assert.match(h.toast,/ORDER123/);
  assert.equal(rows(),1);assert.equal(h.outbound.current.length,0);assert.equal(h.lookups,1);
  await h.scan('ORDER123');
  assert.match(h.message,/ĐƠN HỦY.*ORDER123/);assert.equal(rows(),1);assert.equal(h.lookups,1);
  await h.scan('ALIAS123456');
  assert.match(h.message,/ĐƠN HỦY.*ORDER123/);assert.equal(rows(),1);assert.equal(h.lookups,2);
}
for (const failed of [false,true]) {
  const h=harness({locked:true,failed});await h.scan('SPXVN123456');
  assert.match(h.message,failed?/GIAO THẤT BẠI.*ORDER123/:/ĐƠN HỦY.*ORDER123/);
  assert.equal(h.returned.current.length,0);assert.equal(h.cancelled.current.length,0);assert.equal(h.outbound.current.length,0);
}
const ordinary=harness({cancel:false});ordinary.returned.current.push({code:'SPXVN123456',orderSn:'ORDER123'});
await ordinary.scan('SPXVN123456');assert.equal(ordinary.message,'ĐƠN ĐÃ QUÉT');assert.equal(ordinary.lookups,0);
console.log('PASS: both modes, same code/order code/alias, committed cancelled/failed delivery, ordinary duplicate; no duplicate rows or outbound writes.');
