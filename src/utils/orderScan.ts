import type { Order } from '../types';
import { isShopeeInternalTrackingCode } from './orderTracking';
import { isReturnScanLocked } from './orderLocalStatus';
import { decodeJwtPayload } from './jwtClient';

export type ScannerMode = 'handover' | 'return';

/** Normalize for comparison: uppercase, strip common separators. */
export function normalizeOrderScanKey(raw: string): string {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[\s\-_#./\\|:;,]+/g, '');
}

/** Heuristic: QR waybill - prefix hang, alphanumeric, ho?c to�n s? 6-40 (GHN). */
export function isLikelyTrackingCode(raw: string): boolean {
  const key = normalizeOrderScanKey(raw);
  if (!key || key.length < 6 || key.length > 40) return false;
  if (isShopeeInternalTrackingCode(key)) return false;
  // Shopee order_sn ki?u 240814N2XXXX - kh�ng ph?i ma v?n don.
  if (/^\d{6}[A-Z][A-Z0-9]{5,}$/i.test(key)) return false;
  if (/^\d{6,40}$/.test(key)) return true;
  return /^[A-Z0-9][A-Z0-9\-]{5,39}$/.test(key);
}

function flexibleCodeMatch(scanKey: string, fieldKey: string): boolean {
  if (!scanKey || !fieldKey) return false;
  if (scanKey === fieldKey) return true;
  // Ma d? d�i: endsWith b?t prefix/suffix du t? m�y qu�t; includes b?t do?n gi?a.
  if (scanKey.length >= 8 && fieldKey.length >= 8) {
    if (fieldKey.endsWith(scanKey) || scanKey.endsWith(fieldKey)) return true;
  }
  if (scanKey.length >= 10 && fieldKey.length >= 10) {
    if (fieldKey.includes(scanKey) || scanKey.includes(fieldKey)) return true;
  }
  return false;
}

/** Build all normalized keys to try from raw QR / manual input. */
export function buildScanLookupKeys(raw: string): string[] {
  const text = String(raw || '').trim();
  if (!text) return [];

  const keys = new Set<string>();
  const add = (v: unknown) => {
    const normalized = normalizeOrderScanKey(String(v || ''));
    if (normalized.length >= 4) keys.add(normalized);
  };

  add(text);
  add(text.replace(/^#+/, ''));

  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      [
        'tracking',
        'tracking_no',
        'tracking_number',
        'tn',
        'order_sn',
        'ordersn',
        'order',
        'order_id',
        'package_number',
        'code',
        'sn',
      ].forEach((p) => {
        const v = url.searchParams.get(p);
        if (v) add(v);
      });
      url.pathname.split('/').filter(Boolean).forEach(add);
    } catch {
      /* ignore malformed URL */
    }
  }

  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      [
        'tracking_number',
        'trackingNumber',
        'tracking_no',
        'trackingNo',
        'order_sn',
        'orderSn',
        'package_number',
        'packageNumber',
      ].forEach((k) => {
        if (parsed?.[k]) add(parsed[k]);
      });
    } catch {
      /* ignore invalid JSON */
    }
  }

  for (const m of text.matchAll(
    /(?:tracking[_-]?(?:no|number)?|order[_-]?sn|package[_-]?number?)\s*[:=]\s*([A-Za-z0-9\-]+)/gi
  )) {
    add(m[1]);
  }

  return [...keys];
}

/** Heuristic: Shopee sorting / first-mile code on AWB (0FG...). */
export function isLikelyInternalTrackingCode(raw: string): boolean {
  return isShopeeInternalTrackingCode(raw);
}

/** Flexible OR match: orderSn OR trackingNumber OR internalTrackingCode OR packageNumber. */
export function matchScannedCodeToOrder(order: Order, raw: string): boolean {
  const scanKeys = buildScanLookupKeys(raw);
  if (scanKeys.length === 0) return false;

  const orderSnKey = normalizeOrderScanKey(order.orderSn);
  const trackingKey = order.trackingNumber ? normalizeOrderScanKey(order.trackingNumber) : '';
  const returnTrackingKey = order.return_tracking_no || order.returnTrackingNumber
    ? normalizeOrderScanKey(order.return_tracking_no || order.returnTrackingNumber)
    : '';
  const trackingNoKey = order.tracking_no ? normalizeOrderScanKey(order.tracking_no) : '';
  const internalKey = order.internalTrackingCode ? normalizeOrderScanKey(order.internalTrackingCode) : '';
  const packageKey = order.packageNumber ? normalizeOrderScanKey(order.packageNumber) : '';
  const idKey = normalizeOrderScanKey(order.id?.replace(/^shopee-/i, '') || '');

  return scanKeys.some(
    (sk) =>
      flexibleCodeMatch(sk, orderSnKey) ||
      flexibleCodeMatch(sk, trackingKey) ||
      flexibleCodeMatch(sk, returnTrackingKey) ||
      flexibleCodeMatch(sk, trackingNoKey) ||
      flexibleCodeMatch(sk, internalKey) ||
      flexibleCodeMatch(sk, packageKey) ||
      flexibleCodeMatch(sk, idKey)
  );
}

export type OrderScanIndex = {
  byOrderSn: Map<string, Order>;
  byTracking: Map<string, Order>;
  byInternal: Map<string, Order>;
  byPackage: Map<string, Order>;
  byId: Map<string, Order>;
};

export function buildOrderScanIndex(orders: Order[]): OrderScanIndex {
  const byOrderSn = new Map<string, Order>();
  const byTracking = new Map<string, Order>();
  const byInternal = new Map<string, Order>();
  const byPackage = new Map<string, Order>();
  const byId = new Map<string, Order>();

  for (const order of orders) {
    const put = (map: Map<string, Order>, value?: string) => {
      const key = normalizeOrderScanKey(value || '');
      if (key) map.set(key, order);
    };
    put(byOrderSn, order.orderSn);
    put(byTracking, order.trackingNumber);
    put(byTracking, order.tracking_no);
    put(byTracking, order.return_tracking_no);
    put(byTracking, order.returnTrackingNumber);
    put(byInternal, order.internalTrackingCode);
    put(byPackage, order.packageNumber);
    put(byId, order.id);
    put(byId, String(order.id || '').replace(/^shopee-/i, ''));
  }

  return { byOrderSn, byTracking, byInternal, byPackage, byId };
}

function lookupExactFromScanIndex(index: OrderScanIndex, scanKeys: string[]): Order | null {
  for (const sk of scanKeys) {
    for (const map of [index.byTracking, index.byInternal, index.byOrderSn, index.byPackage, index.byId]) {
      const hit = map.get(sk);
      if (hit) return hit;
    }
  }
  return null;
}

/** Fallback sau exact: endsWith / includes tr�n to�n b? key trong index. */
function lookupFlexibleFromScanIndex(index: OrderScanIndex, scanKeys: string[]): Order | null {
  const maps = [index.byTracking, index.byInternal, index.byOrderSn, index.byPackage, index.byId];
  for (const sk of scanKeys) {
    if (sk.length < 8) continue;
    for (const map of maps) {
      for (const [mapKey, order] of map) {
        if (mapKey.length < 8) continue;
        if (flexibleCodeMatch(sk, mapKey)) return order;
      }
    }
  }
  return null;
}

/** Find order - prioritizes tracking match when scan looks like waybill code. */
export function findOrderByScanPayload(
  orders: Order[],
  raw: string,
  scanIndex?: OrderScanIndex
): Order | null {
  const scanKeys = buildScanLookupKeys(raw);
  if (scanKeys.length === 0) return null;

  const index = scanIndex || buildOrderScanIndex(orders);
  const exactHit = lookupExactFromScanIndex(index, scanKeys);
  if (exactHit) return exactHit;

  const flexibleHit = lookupFlexibleFromScanIndex(index, scanKeys);
  if (flexibleHit) return flexibleHit;

  const trackingLike = isLikelyTrackingCode(raw);
  const internalLike = isLikelyInternalTrackingCode(raw);

  if (trackingLike) {
    for (const order of orders) {
      const candidates = [order.trackingNumber, order.tracking_no, order.return_tracking_no, order.returnTrackingNumber];
      for (const c of candidates) {
        const trackingKey = c ? normalizeOrderScanKey(c) : '';
        if (!trackingKey) continue;
        const matched = scanKeys.some((sk) => flexibleCodeMatch(sk, trackingKey));
        if (matched) return order;
      }
    }
  }

  if (internalLike) {
    for (const order of orders) {
      const internalKey = order.internalTrackingCode ? normalizeOrderScanKey(order.internalTrackingCode) : '';
      if (!internalKey) continue;
      const matched = scanKeys.some((sk) => flexibleCodeMatch(sk, internalKey));
      if (matched) return order;
    }
  }

  for (const order of orders) {
    if (matchScannedCodeToOrder(order, raw)) return order;
  }

  return null;
}

export class ScanLookupError extends Error {
  kind: 'timeout' | 'network' | 'http';
  constructor(message: string, kind: 'timeout' | 'network' | 'http') {
    super(message);
    this.name = 'ScanLookupError';
    this.kind = kind;
  }
}

const SCAN_LOOKUP_TIMEOUT_MS = 3_000;

export async function lookupOrderByScanCode(
  raw: string,
  localOrders: Order[],
  token?: string | null,
  scanIndex?: OrderScanIndex,
  opts?: { lean?: boolean },
): Promise<Order | null> {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (localOrders.length > 0) {
    const local = findOrderByScanPayload(localOrders, trimmed, scanIndex);
    if (local) return local;
  }

  const leanQ = opts?.lean !== false ? '&lean=scanner' : '';
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer =
    controller && typeof window !== 'undefined'
      ? window.setTimeout(() => controller.abort(), SCAN_LOOKUP_TIMEOUT_MS)
      : undefined;
  try {
    const res = await fetch(
      `/api/orders/lookup?code=${encodeURIComponent(trimmed)}${leanQ}`,
      {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: controller?.signal,
        cache: 'no-store',
      },
    );
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new ScanLookupError(`HTTP ${res.status}`, 'http');
    }
    const order = (await res.json()) as Order;
    return order?.id || order?.orderSn ? order : null;
  } catch (err: unknown) {
    if (err instanceof ScanLookupError) throw err;
    const name = err instanceof Error ? err.name : '';
    const msg = err instanceof Error ? err.message : String(err || '');
    if (name === 'AbortError' || /aborted|timeout/i.test(msg)) {
      throw new ScanLookupError('timeout', 'timeout');
    }
    throw new ScanLookupError(msg || 'network', 'network');
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
}

/** Ghi don v?a lookup v�o HashMap s�ng - l?n qu�t sau O(1), kh�ng g?i l?i HTTP. */
export function putOrderIntoScannerSyncMap(
  map: Map<string, ScannerSyncEntry>,
  order: Order,
  scannedCode?: string,
): Map<string, ScannerSyncEntry> {
  const next = new Map(map);
  const tracking = String(order.tracking_no || order.trackingNumber || '').trim();
  const returnWb = String(order.return_tracking_no || order.returnTrackingNumber || '').trim();
  const orderId = String(order.orderSn || '').replace(/^shopee-/i, '').trim();
  const scannedNorm = scannedCode ? normalizeOrderScanKey(scannedCode) : '';
  const returnNorm = returnWb ? normalizeOrderScanKey(returnWb) : '';
  const outNorm = tracking ? normalizeOrderScanKey(tracking) : '';
  const flexEq = (a: string, b: string) =>
    Boolean(
      a &&
        b &&
        (a === b ||
          (a.length >= 10 && b.length >= 10 && (a.endsWith(b) || b.endsWith(a)))),
    );
  const matchesOutbound = flexEq(scannedNorm, outNorm);
  const matchesReturn = flexEq(scannedNorm, returnNorm);
  const scannedIsReturn = Boolean(
    matchesReturn || (!matchesOutbound && scannedNorm && order.return_sn),
  );
  const handed =
    order.is_handed_over === true ||
    order.isHandedOverToCarrier === true ||
    order.is_handed_over_to_carrier === true ||
    order.is_handed_over_to_courier === true ||
    String(order.local_status || order.localStatus || order.internal_status || '')
      .toUpperCase() === 'HANDED_OVER';
  const entry: ScannerSyncEntry = {
    order_id: orderId,
    tracking_code: tracking,
    return_waybill: returnWb || (scannedIsReturn ? String(scannedCode || '').trim() : ''),
    status: handed
      ? 'handed_over'
      : String(order.status || '').trim().toLowerCase(),
    logistics_status: order.logistics_status,
    shopee_cancel_return_kind: order.shopee_cancel_return_kind,
    is_rts: order.is_rts,
    isReturnReceived: isReturnScanLocked(order),
    returnReceivedAt: order.returnReceivedAt
      ? String(order.returnReceivedAt)
      : undefined,
    matchedReturn: scannedIsReturn,
  };
  const put = (raw: string, matchedReturn = false) => {
    const key = normalizeOrderScanKey(raw);
    if (!key || key.length < 4) return;
    next.set(key, { ...entry, matchedReturn });
  };
  if (entry.tracking_code) put(entry.tracking_code, false);
  if (entry.return_waybill) put(entry.return_waybill, true);
  if (entry.order_id) put(entry.order_id, scannedIsReturn);
  if (scannedCode) put(scannedCode, scannedIsReturn);
  return next;
}

/** Am thanh public t?m (mp3 ng?n) - success / warning(h?y) / error / pending(d� ng?m). */
export const SCAN_SOUND_URLS = {
  success:
    'https://actions.google.com/sounds/v1/cartoon/pop.ogg',
  warning:
    'https://actions.google.com/sounds/v1/alarms/beep_short.ogg',
  error:
    'https://actions.google.com/sounds/v1/cartoon/wood_plank_flicks.ogg',
  pending:
    'https://actions.google.com/sounds/v1/cartoon/clang_and_wobble.ogg',
  /** Qu�t tr�ng don da b�n giao DVVC - file local, kh�c success/h?y/ho�n. */
  duplicate: '/sounds/warning.mp3',
} as const;

export type ScanSoundType = 'success' | 'warning' | 'error' | 'pending' | 'duplicate';

function playHtmlAudio(url: string) {
  try {
    const audio = new Audio(url);
    audio.volume = 0.85;
    void audio.play().catch(() => undefined);
  } catch {
    /* ignore */
  }
}

/**
 * Am ri�ng khi qu�t tr�ng don DA giao DVVC.
 * Uu ti�n /sounds/warning.mp3; fallback Web Audio n?u file l?i / autoplay b? ch?n.
 */
export function playDuplicateHandedOverSound() {
  try {
    const audio = new Audio(SCAN_SOUND_URLS.duplicate);
    audio.volume = 0.9;
    void audio.play().catch(() => {
      playWebAudioTone('duplicate');
    });
  } catch {
    try {
      playWebAudioTone('duplicate');
    } catch {
      /* ignore DOM Exception / autoplay */
    }
  }
}

/** Web Audio fallback - success (2 tone cao), warning (c�i), error (tr?m d�i). */
function playWebAudioTone(type: ScanSoundType) {
  try {
    const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const now = audioCtx.currentTime;

    const beep = (freq: number, start: number, dur: number, vol = 0.35, wave: OscillatorType = 'sine') => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = wave;
      osc.frequency.setValueAtTime(freq, now + start);
      gain.gain.setValueAtTime(vol, now + start);
      gain.gain.exponentialRampToValueAtTime(0.01, now + start + dur);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(now + start);
      osc.stop(now + start + dur);
    };

    if (type === 'success') {
      beep(980, 0, 0.08);
      beep(1310, 0.09, 0.1);
    } else if (type === 'warning') {
      beep(620, 0, 0.12, 0.4, 'square');
      beep(420, 0.14, 0.16, 0.4, 'square');
      beep(620, 0.32, 0.14, 0.35, 'square');
    } else if (type === 'pending') {
      // 3 tone ng?n trung b�nh - kh�c success/warning/error, b�o "dang d� ng?m".
      beep(740, 0, 0.07, 0.3, 'sine');
      beep(880, 0.1, 0.07, 0.28, 'sine');
      beep(740, 0.2, 0.1, 0.25, 'sine');
    } else if (type === 'duplicate') {
      // 4 beep v�ng nhanh - kh�c h?n success (xanh) / warning h?y (c�i) / error.
      beep(880, 0, 0.09, 0.38, 'sawtooth');
      beep(660, 0.11, 0.09, 0.38, 'sawtooth');
      beep(880, 0.22, 0.09, 0.36, 'sawtooth');
      beep(660, 0.33, 0.12, 0.34, 'sawtooth');
    } else {
      beep(320, 0, 0.28, 0.4, 'triangle');
    }
  } catch {
    /* audio unavailable */
  }
}

export function playScanSound(type: ScanSoundType = 'success') {
  if (type === 'duplicate') {
    playDuplicateHandedOverSound();
    return;
  }
  playHtmlAudio(SCAN_SOUND_URLS[type]);
  playWebAudioTone(type);
}

/** @deprecated - d�ng playScanSound */
export function playScanBeep(type: 'success' | 'error' = 'success') {
  playScanSound(type === 'success' ? 'success' : 'error');
}

export function vibrateScan(type: ScanSoundType | 'success' | 'error' = 'success') {
  if (typeof navigator !== 'undefined' && navigator.vibrate) {
    if (type === 'success') navigator.vibrate([30, 20, 30]);
    else if (type === 'warning' || type === 'duplicate') navigator.vibrate([100, 50, 100, 50, 120]);
    else if (type === 'pending') navigator.vibrate([40, 30, 40, 30, 40]);
    else navigator.vibrate([80, 40, 80]);
  }
}

export function scanFeedback(type: ScanSoundType | 'success' | 'error') {
  playScanSound(
    type === 'success' ||
      type === 'warning' ||
      type === 'error' ||
      type === 'pending' ||
      type === 'duplicate'
      ? type
      : 'error',
  );
  vibrateScan(type);
}

/** Payload lean t? GET /api/orders/scanner-sync */
export type ScannerSyncRow = {
  order_id: string;
  tracking_code: string;
  return_waybill: string;
  status: string;
  logistics_status?: string;
  shopee_cancel_return_kind?: string;
  is_rts?: boolean;
  isReturnReceived?: boolean;
  returnReceivedAt?: string;
};

export type ScannerSyncEntry = ScannerSyncRow & {
  /** true n?u key map kh?p return_waybill */
  matchedReturn?: boolean;
};

/** Hash map ma VD  row - lookup O(1) khi qu�t. */
export function buildScannerSyncMap(rows: ScannerSyncRow[]): Map<string, ScannerSyncEntry> {
  const map = new Map<string, ScannerSyncEntry>();
  for (const row of rows) {
    const base: ScannerSyncEntry = {
      order_id: String(row.order_id || '').trim(),
      tracking_code: String(row.tracking_code || '').trim(),
      return_waybill: String(row.return_waybill || '').trim(),
      status: String(row.status || '').trim().toLowerCase(),
      logistics_status: row.logistics_status,
      shopee_cancel_return_kind: row.shopee_cancel_return_kind,
      is_rts: row.is_rts,
      isReturnReceived: row.isReturnReceived === true,
      returnReceivedAt: row.returnReceivedAt,
    };
    if (!base.order_id) continue;
    const put = (raw: string, matchedReturn = false) => {
      const key = normalizeOrderScanKey(raw);
      if (!key || key.length < 4) return;
      map.set(key, { ...base, matchedReturn });
    };
    if (base.tracking_code) put(base.tracking_code, false);
    if (base.return_waybill) put(base.return_waybill, true);
    if (base.order_id) put(base.order_id, false);
  }
  return map;
}

export function lookupScannerSyncMap(
  map: Map<string, ScannerSyncEntry>,
  raw: string,
): ScannerSyncEntry | null {
  if (!map.size) return null;
  const keys = buildScanLookupKeys(raw);
  for (const sk of keys) {
    const hit = map.get(sk);
    if (hit) return hit;
  }
  // Flexible endsWith / includes cho ma �8 ky t? (m�y qu�t du prefix/suffix).
  for (const sk of keys) {
    if (sk.length < 8) continue;
    for (const [mapKey, entry] of map) {
      if (mapKey.length < 8) continue;
      if (flexibleCodeMatch(sk, mapKey)) return entry;
    }
  }
  return null;
}

/**
 * TTL cache phi�n FE cho pool scanner-sync (ms) - kh?p TTL cache server (240s)
 * d? tr�nh client coi "c�n h?n" trong khi server da �m th?m query l?i.
 */
export const SCANNER_POOL_CACHE_TTL_MS = 240_000;
/** Coi g?n h?t h?n  refresh n?n (stale-while-revalidate). */
export const SCANNER_POOL_STALE_MS = 180_000;
/** Timeout 1 l?n g?i scanner-sync - kh�ng ch? proxy 60s. */
export const SCANNER_SYNC_FETCH_TIMEOUT_MS = 12_000;

export type ScannerPoolCacheEntry = {
  map: Map<string, ScannerSyncEntry>;
  rows: ScannerSyncRow[];
  codeCount: number;
  fetchedAt: number;
};

export type ScannerPoolCache = {
  handover: ScannerPoolCacheEntry | null;
  return: ScannerPoolCacheEntry | null;
};

// Persist only lean scan rows, scoped to the signed-in account. Never store tokens.
const SCANNER_DISPLAY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
function scannerStorageKey(mode: ScannerMode): string | null {
  try {
    const username = decodeJwtPayload(localStorage.getItem('admin_token') || '')?.username;
    return username ? `scanner_pool_v1:${username}:${mode}` : null;
  } catch { return null; }
}

export function isScannerPoolUsable(entry: ScannerPoolCacheEntry | null | undefined): boolean {
  return isScannerPoolFresh(entry, Date.now(), SCANNER_DISPLAY_MAX_AGE_MS);
}

export function loadScannerPoolCache(): ScannerPoolCache {
  const load = (mode: ScannerMode): ScannerPoolCacheEntry | null => {
    try {
      const key = scannerStorageKey(mode);
      if (!key) return null;
      const saved = JSON.parse(localStorage.getItem(key) || 'null');
      if (!saved || !Array.isArray(saved.rows) || !Number.isFinite(saved.fetchedAt) || saved.fetchedAt > Date.now()) return null;
      const entry = { ...saved, map: buildScannerSyncMap(saved.rows) };
      return isScannerPoolUsable(entry) ? entry : null;
    } catch { return null; }
  };
  return { handover: load('handover'), return: load('return') };
}

export function clearScannerPoolCache(mode: ScannerMode): void {
  try {
    const key = scannerStorageKey(mode);
    if (key) localStorage.removeItem(key);
  } catch { /* Storage may be unavailable. */ }
}

type ScannerFetchOptions = {
  lookbackDays?: number;
  token?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  fresh?: boolean;
};
const scannerPoolRequests = new Map<string, Promise<ScannerPoolCacheEntry>>();

/** Each caller can leave without cancelling another caller's shared request. */
export async function fetchScannerSyncPool(mode: ScannerMode, opts?: ScannerFetchOptions): Promise<ScannerPoolCacheEntry> {
  if (opts?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const token = opts?.token ?? (typeof localStorage !== 'undefined' ? localStorage.getItem('admin_token') || '' : '');
  const key = JSON.stringify([token, mode, opts?.lookbackDays ?? 30]);
  let request = scannerPoolRequests.get(key);
  if (!request) {
    request = requestScannerSyncPool(mode, { ...opts, token, signal: undefined });
    scannerPoolRequests.set(key, request);
    void request.finally(() => {
      if (scannerPoolRequests.get(key) === request) scannerPoolRequests.delete(key);
    }).catch(() => undefined);
  }
  if (!opts?.signal) return request;
  const signal = opts.signal;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    request!.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export function isScannerPoolFresh(
  entry: ScannerPoolCacheEntry | null | undefined,
  now = Date.now(),
  ttlMs = SCANNER_POOL_CACHE_TTL_MS,
): boolean {
  if (!entry || !(entry.map instanceof Map)) return false;
  return now - entry.fetchedAt < ttlMs;
}

export function isScannerPoolStale(
  entry: ScannerPoolCacheEntry | null | undefined,
  now = Date.now(),
  staleMs = SCANNER_POOL_STALE_MS,
): boolean {
  if (!entry) return true;
  return now - entry.fetchedAt >= staleMs;
}

export function countScannerSyncCodes(rows: ScannerSyncRow[]): number {
  let n = 0;
  for (const row of rows) {
    if (row.tracking_code) n += 1;
    if (row.return_waybill) n += 1;
  }
  return n;
}

/**
 * Fetch lean pool cho 1 mode scanner-sync.
 * Timeout 12s + optional AbortSignal; cache: no-store.
 */
async function requestScannerSyncPool(
  mode: ScannerMode,
  opts?: {
    lookbackDays?: number;
    token?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    fresh?: boolean;
  },
): Promise<ScannerPoolCacheEntry> {
  const timeoutMs = opts?.timeoutMs ?? SCANNER_SYNC_FETCH_TIMEOUT_MS;
  const token =
    opts?.token ??
    (typeof localStorage !== 'undefined' ? localStorage.getItem('admin_token') || '' : '');
  const storageKey = scannerStorageKey(mode);
  const params = new URLSearchParams();
  params.set('mode', mode);
  if (mode === 'return') {
    params.set('lookbackDays', String(Math.max(1, Math.min(30, opts?.lookbackDays ?? 30))));
  }
  if (opts?.fresh) params.set('fresh', '1');

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (opts?.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`/api/orders/scanner-sync?${params.toString()}`, {
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as {
      orders?: ScannerSyncRow[];
      code_count?: number;
      success?: boolean;
    };
    if (data.success === false || !Array.isArray(data.orders)) throw new Error('Invalid scanner response');
    const rows = data.orders;
    const map = buildScannerSyncMap(rows);
    const codeCount = Number.isFinite(Number(data.code_count))
      ? Number(data.code_count)
      : countScannerSyncCodes(rows);
    const entry = { map, rows, codeCount, fetchedAt: Date.now() };
    try {
      if (storageKey && storageKey === scannerStorageKey(mode) && (mode !== 'return' || !opts?.lookbackDays || opts.lookbackDays === 30)) {
        localStorage.setItem(storageKey, JSON.stringify({ rows, codeCount, fetchedAt: entry.fetchedAt }));
      }
    } catch { /* Cache failure must not prevent scanning. */ }
    return entry;
  } finally {
    clearTimeout(timer);
    if (opts?.signal) opts.signal.removeEventListener('abort', onAbort);
  }
}

/** Prefetch song song c? 2 mode (1 retry ng?n n?u fail). */
export async function prefetchBothScannerPools(opts?: {
  token?: string;
  signal?: AbortSignal;
  fresh?: boolean;
}): Promise<ScannerPoolCache> {
  const loadOne = async (mode: ScannerMode): Promise<ScannerPoolCacheEntry | null> => {
    try {
      return await fetchScannerSyncPool(mode, opts);
    } catch (err) {
      console.warn(`[Scan Prefetch] ${mode} fail, retry once:`, err);
      if (opts?.signal?.aborted) return null;
      await new Promise((r) => setTimeout(r, 800));
      if (opts?.signal?.aborted) return null;
      try {
        return await fetchScannerSyncPool(mode, opts);
      } catch (err2) {
        console.warn(`[Scan Prefetch] ${mode} retry fail:`, err2);
        return null;
      }
    }
  };
  const [handover, ret] = await Promise.all([loadOne('handover'), loadOne('return')]);
  return { handover, return: ret };
}

/** Stub Order t?i thi?u t? scanner-sync - d? ph�n lo?i + b�n giao. */
export function scannerSyncEntryToOrder(entry: ScannerSyncEntry): Order {
  const sn = String(entry.order_id || '').replace(/^shopee-/i, '').trim();
  const statusRaw = String(entry.status || '').toLowerCase();
  const tracking = entry.tracking_code || undefined;
  const returnWb = entry.return_waybill || undefined;

  let status: Order['status'] = 'processed';
  let shopee_order_status: string | undefined = 'PROCESSED';
  let is_handed_over = false;
  let return_sn: string | undefined;
  let local_status: string | undefined;
  let is_rts = entry.is_rts === true;
  let shopee_cancel_return_kind = entry.shopee_cancel_return_kind;
  const logistics_status = entry.logistics_status;

  if (statusRaw === 'rts' || entry.shopee_cancel_return_kind === 'failed_delivery' || is_rts) {
    status = 'cancelled';
    shopee_order_status = 'CANCELLED';
    is_rts = true;
    shopee_cancel_return_kind = 'failed_delivery';
  } else if (statusRaw === 'shipping' || statusRaw === 'handed_over') {
    if (statusRaw === 'shipping') {
      status = 'shipping';
      shopee_order_status = 'SHIPPED';
    } else {
      status = 'processed';
      shopee_order_status = 'PROCESSED';
      is_handed_over = true;
      local_status = 'HANDED_OVER';
    }
  } else if (statusRaw === 'cancelled') {
    status = 'cancelled';
    shopee_order_status = 'CANCELLED';
  } else if (statusRaw === 'return_received') {
    status = 'return_received';
    shopee_order_status = 'TO_RETURN';
    return_sn = 'scanner-sync';
  } else if (
    statusRaw === 'return_pending' ||
    statusRaw === 'return_requests' ||
    statusRaw === 'return'
  ) {
    status = 'return_pending';
    shopee_order_status = 'TO_RETURN';
    return_sn = 'scanner-sync';
  } else if (statusRaw === 'unprocessed') {
    status = 'unprocessed';
    shopee_order_status = 'READY_TO_SHIP';
  } else {
    status = 'processed';
    shopee_order_status = 'PROCESSED';
  }

  if (entry.matchedReturn && status !== 'cancelled') {
    status = status === 'return_received' ? 'return_received' : 'return_pending';
    shopee_order_status = 'TO_RETURN';
    return_sn = return_sn || 'scanner-sync';
  }

  return {
    id: `shopee-${sn}`,
    orderSn: sn,
    status,
    shopee_order_status,
    trackingNumber: tracking,
    tracking_no: tracking,
    return_tracking_no: returnWb,
    return_sn,
    is_handed_over,
    is_rts,
    shopee_cancel_return_kind,
    logistics_status,
    isPrinted: true,
    isReturnReceived: entry.isReturnReceived === true,
    returnReceivedAt: entry.returnReceivedAt,
    internal_flags: entry.isReturnReceived
      ? { isReturnReceived: true, returnReceivedAt: entry.returnReceivedAt }
      : undefined,
    local_status: entry.isReturnReceived
      ? status === 'cancelled'
        ? 'CANCELLED_STORED'
        : 'RETURN_RECEIVED'
      : local_status,
    channel: 'shopee',
    date: new Date().toISOString(),
    items: [],
    totalAmount: 0,
    revenue: 0,
  } as Order;
}

