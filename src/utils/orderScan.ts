import type { Order } from '../types';
import { isShopeeInternalTrackingCode } from './orderTracking';

/** Normalize for comparison: uppercase, strip common separators. */
export function normalizeOrderScanKey(raw: string): string {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[\s\-_#./\\|:;,]+/g, '');
}

/** Heuristic: QR on waybill usually encodes carrier tracking (SPXVN..., etc.). */
export function isLikelyTrackingCode(raw: string): boolean {
  const key = normalizeOrderScanKey(raw);
  if (!key || key.length < 8) return false;
  return /^(SPX(VN)?|GHN|GHTK|JNT|JT|NINJA|VTP|VNPOST)[A-Z0-9]+$/.test(key);
}

function flexibleCodeMatch(scanKey: string, fieldKey: string): boolean {
  if (!scanKey || !fieldKey) return false;
  if (scanKey === fieldKey) return true;
  if (scanKey.length >= 10 && fieldKey.length >= 10) {
    return fieldKey.endsWith(scanKey) || scanKey.endsWith(fieldKey);
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
  const returnTrackingKey = order.return_tracking_no
    ? normalizeOrderScanKey(order.return_tracking_no)
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

/** Find order — prioritizes tracking match when scan looks like waybill code. */
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

  const trackingLike = isLikelyTrackingCode(raw);
  const internalLike = isLikelyInternalTrackingCode(raw);

  if (trackingLike) {
    for (const order of orders) {
      const candidates = [order.trackingNumber, order.tracking_no, order.return_tracking_no];
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

export async function lookupOrderByScanCode(
  raw: string,
  localOrders: Order[],
  token?: string | null,
  scanIndex?: OrderScanIndex
): Promise<Order | null> {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const local = findOrderByScanPayload(localOrders, trimmed, scanIndex);
  if (local) return local;

  if (!token) return null;

  try {
    const res = await fetch(`/api/orders/lookup?code=${encodeURIComponent(trimmed)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const order = (await res.json()) as Order;
    return order?.id ? order : null;
  } catch {
    return null;
  }
}

/** Âm thanh public tạm (mp3 ngắn) — success / warning(hủy) / error. */
export const SCAN_SOUND_URLS = {
  success:
    'https://actions.google.com/sounds/v1/cartoon/pop.ogg',
  warning:
    'https://actions.google.com/sounds/v1/alarms/beep_short.ogg',
  error:
    'https://actions.google.com/sounds/v1/cartoon/wood_plank_flicks.ogg',
} as const;

export type ScanSoundType = 'success' | 'warning' | 'error';

function playHtmlAudio(url: string) {
  try {
    const audio = new Audio(url);
    audio.volume = 0.85;
    void audio.play().catch(() => undefined);
  } catch {
    /* ignore */
  }
}

/** Web Audio fallback — success (2 tone cao), warning (còi), error (trầm dài). */
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
    } else {
      beep(320, 0, 0.28, 0.4, 'triangle');
    }
  } catch {
    /* audio unavailable */
  }
}

export function playScanSound(type: ScanSoundType = 'success') {
  playHtmlAudio(SCAN_SOUND_URLS[type]);
  playWebAudioTone(type);
}

/** @deprecated — dùng playScanSound */
export function playScanBeep(type: 'success' | 'error' = 'success') {
  playScanSound(type === 'success' ? 'success' : 'error');
}

export function vibrateScan(type: ScanSoundType | 'success' | 'error' = 'success') {
  if (typeof navigator !== 'undefined' && navigator.vibrate) {
    if (type === 'success') navigator.vibrate([30, 20, 30]);
    else if (type === 'warning') navigator.vibrate([100, 50, 100, 50, 120]);
    else navigator.vibrate([80, 40, 80]);
  }
}

export function scanFeedback(type: ScanSoundType | 'success' | 'error') {
  playScanSound(type === 'success' || type === 'warning' || type === 'error' ? type : 'error');
  vibrateScan(type);
}
