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
  const internalKey = order.internalTrackingCode ? normalizeOrderScanKey(order.internalTrackingCode) : '';
  const packageKey = order.packageNumber ? normalizeOrderScanKey(order.packageNumber) : '';
  const idKey = normalizeOrderScanKey(order.id?.replace(/^shopee-/i, '') || '');

  return scanKeys.some(
    (sk) =>
      flexibleCodeMatch(sk, orderSnKey) ||
      flexibleCodeMatch(sk, trackingKey) ||
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
      const trackingKey = order.trackingNumber ? normalizeOrderScanKey(order.trackingNumber) : '';
      if (!trackingKey) continue;
      const matched = scanKeys.some((sk) => flexibleCodeMatch(sk, trackingKey));
      if (matched) return order;
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

export function playScanBeep(type: 'success' | 'error' = 'success') {
  try {
    const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const oscillator = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(type === 'success' ? 1200 : 400, audioCtx.currentTime);
    gainNode.gain.setValueAtTime(0.4, audioCtx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(
      0.01,
      audioCtx.currentTime + (type === 'success' ? 0.12 : 0.25)
    );
    oscillator.start();
    oscillator.stop(audioCtx.currentTime + (type === 'success' ? 0.12 : 0.25));
  } catch {
    /* audio unavailable */
  }
}

export function vibrateScan(type: 'success' | 'error' = 'success') {
  if (typeof navigator !== 'undefined' && navigator.vibrate) {
    navigator.vibrate(type === 'success' ? [30, 20, 30] : [80, 40, 80]);
  }
}

export function scanFeedback(type: 'success' | 'error') {
  playScanBeep(type);
  vibrateScan(type);
}
