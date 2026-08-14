/** Client API — hàng đợi dò ngầm Backend (độc lập màn quét). */

export type ScanBgJob = {
  id: string;
  code: string;
  codeKey: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  enqueuedAt: string;
  finishedAt?: string;
  orderId?: string;
  orderSn?: string;
  action?:
    | 'cancelled'
    | 'return_received'
    | 'found_other'
    | 'not_found'
    | 'duplicate'
    | 'error';
  local_status?: string;
  message?: string;
  notified?: boolean;
};

export type ScanBgStatusResponse = {
  success: boolean;
  pendingCount: number;
  pending: ScanBgJob[];
  running: ScanBgJob[];
  recent: ScanBgJob[];
  unnotified: ScanBgJob[];
  summary: {
    cancelled: number;
    returnReceived: number;
    notFound: number;
    failed: number;
  };
  workerRunning?: boolean;
};

function authHeaders(): HeadersInit {
  const token = localStorage.getItem('admin_token');
  return {
    Authorization: token ? `Bearer ${token}` : '',
    'Content-Type': 'application/json',
  };
}

/** Đẩy mã vào queue Backend — worker tiếp tục dù tắt màn quét. */
export async function enqueueScanBgCodes(codes: string[]): Promise<{
  ok: boolean;
  queued: number;
  pending: number;
  message?: string;
}> {
  const list = [...new Set(codes.map((c) => String(c || '').trim()).filter(Boolean))];
  if (!list.length) return { ok: false, queued: 0, pending: 0 };
  try {
    const res = await fetch('/api/orders/scan-bg-enqueue', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ codes: list, scannedCodes: list }),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || data?.success === false) {
      return {
        ok: false,
        queued: 0,
        pending: 0,
        message: String(data?.message || data?.error || `HTTP ${res.status}`),
      };
    }
    return {
      ok: true,
      queued: Number(data.queued) || 0,
      pending: Number(data.pending) || 0,
      message: data.message ? String(data.message) : undefined,
    };
  } catch (err) {
    return {
      ok: false,
      queued: 0,
      pending: 0,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function fetchScanBgStatus(signal?: AbortSignal): Promise<ScanBgStatusResponse | null> {
  try {
    const res = await fetch('/api/orders/scan-bg-status', {
      headers: authHeaders(),
      cache: 'no-store',
      signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as ScanBgStatusResponse;
    return data?.success === false ? null : data;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return null;
    return null;
  }
}

export async function ackScanBgNotifications(ids?: string[]): Promise<void> {
  try {
    await fetch('/api/orders/scan-bg-ack', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(ids?.length ? { ids } : {}),
    });
  } catch {
    /* ignore */
  }
}

export function buildScanBgPendingKeySet(status: ScanBgStatusResponse | null): Set<string> {
  const keys = new Set<string>();
  if (!status) return keys;
  for (const j of [...(status.pending || []), ...(status.running || [])]) {
    const k = String(j.codeKey || j.code || '')
      .trim()
      .toUpperCase()
      .replace(/[\s\-_#./\\|:;,]+/g, '');
    if (k) keys.add(k);
    if (j.orderSn) {
      keys.add(
        String(j.orderSn)
          .trim()
          .toUpperCase()
          .replace(/[\s\-_#./\\|:;,]+/g, ''),
      );
    }
  }
  return keys;
}

export function orderMatchesScanBgPending(
  order: {
    orderSn?: string;
    trackingNumber?: string;
    tracking_no?: string;
    return_tracking_no?: string;
    packageNumber?: string;
    internalTrackingCode?: string;
  },
  pendingKeys: Set<string>,
): boolean {
  if (!pendingKeys.size) return false;
  const fields = [
    order.orderSn,
    order.trackingNumber,
    order.tracking_no,
    order.return_tracking_no,
    order.packageNumber,
    order.internalTrackingCode,
  ];
  for (const f of fields) {
    const k = String(f || '')
      .trim()
      .toUpperCase()
      .replace(/[\s\-_#./\\|:;,]+/g, '');
    if (k && pendingKeys.has(k)) return true;
  }
  return false;
}

export function formatScanBgToast(summary: ScanBgStatusResponse['summary']): string | null {
  const savedCancel = Number(summary.cancelled) || 0;
  const savedReturn = Number(summary.returnReceived) || 0;
  const notFound = Number(summary.notFound) || 0;
  const failed = Number(summary.failed) || 0;
  const saved = savedCancel + savedReturn;
  if (saved > 0) {
    const bits: string[] = [];
    if (savedCancel > 0) bits.push(`${savedCancel} đơn hủy`);
    if (savedReturn > 0) bits.push(`${savedReturn} đơn hoàn`);
    let msg = `Đã dò ngầm và lưu thành công ${bits.join(' · ')}`;
    if (notFound > 0) msg += ` · ${notFound} mã không tìm thấy`;
    if (failed > 0) msg += ` · ${failed} lỗi`;
    return msg;
  }
  if (notFound > 0 || failed > 0) {
    const bits: string[] = [];
    if (notFound > 0) bits.push(`${notFound} mã không tìm thấy`);
    if (failed > 0) bits.push(`${failed} lỗi`);
    return `Dò ngầm xong: ${bits.join(' · ')}`;
  }
  return null;
}
