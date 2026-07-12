import type { Order } from '../types';

/** Normalize for comparison: uppercase, strip common separators. */
export function normalizeOrderScanKey(raw: string): string {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[\s\-_#./\\|:;,]+/g, '');
}

/** Extract candidate lookup keys from raw QR payload. */
export function extractOrderScanKeys(raw: string): string[] {
  const text = String(raw || '').trim();
  if (!text) return [];

  const keys = new Set<string>();
  const add = (v: unknown) => {
    const s = String(v || '').trim();
    if (!s || s.length < 4) return;
    keys.add(normalizeOrderScanKey(s));
    keys.add(s.trim().toUpperCase());
  };

  add(text);
  add(text.replace(/^#+/, ''));

  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      [
        'order_sn',
        'ordersn',
        'order',
        'order_id',
        'orderid',
        'tracking',
        'tracking_no',
        'tracking_number',
        'tn',
        'code',
        'sn',
        'package_number',
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
        'order_sn',
        'orderSn',
        'ordersn',
        'tracking_number',
        'trackingNumber',
        'tracking_no',
        'trackingNo',
        'package_number',
        'packageNumber',
        'id',
        'code',
      ].forEach((k) => {
        if (parsed?.[k]) add(parsed[k]);
      });
    } catch {
      /* ignore invalid JSON */
    }
  }

  for (const m of text.matchAll(
    /(?:order[_-]?sn|tracking[_-]?(?:no|number)?|package[_-]?number?)\s*[:=]\s*([A-Za-z0-9\-]+)/gi
  )) {
    add(m[1]);
  }

  for (const token of text.match(/[A-Z0-9][A-Z0-9\-]{3,}/gi) || []) {
    add(token);
  }

  return [...keys].filter((k, i, arr) => k && arr.indexOf(k) === i);
}

export function getOrderLookupKeys(order: Order): string[] {
  const raw = [
    order.orderSn,
    order.trackingNumber,
    order.packageNumber,
    order.id,
    order.id?.replace(/^shopee-/i, ''),
  ];
  const keys = new Set<string>();
  for (const v of raw) {
    if (!v) continue;
    keys.add(normalizeOrderScanKey(v));
    keys.add(String(v).trim().toUpperCase());
  }
  return [...keys];
}

function scanKeysMatch(scanKey: string, orderKey: string): boolean {
  if (!scanKey || !orderKey) return false;
  if (scanKey === orderKey) return true;
  if (scanKey.length >= 10 && orderKey.length >= 10) {
    return orderKey.endsWith(scanKey) || scanKey.endsWith(orderKey);
  }
  return false;
}

export function findOrderByScanPayload(orders: Order[], raw: string): Order | null {
  const scanKeys = extractOrderScanKeys(raw);
  if (scanKeys.length === 0) return null;

  for (const order of orders) {
    const orderKeys = getOrderLookupKeys(order);
    const matched = scanKeys.some((sk) => orderKeys.some((ok) => scanKeysMatch(sk, ok)));
    if (matched) return order;
  }
  return null;
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
