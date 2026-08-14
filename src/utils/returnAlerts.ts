/** Client API — poll cảnh báo Yêu cầu trả hàng / Hoàn tiền mới. */

export type ReturnAlertItem = {
  id: string;
  orderSn: string;
  returnSn?: string;
  returnTrackingNumber?: string;
  shopId?: string;
  createdAt?: string;
};

export type ReturnAlertsResponse = {
  success: boolean;
  count: number;
  unnotified: ReturnAlertItem[];
  message?: string;
};

function authHeaders(): HeadersInit {
  const token = localStorage.getItem('admin_token');
  return {
    Authorization: token ? `Bearer ${token}` : '',
    'Content-Type': 'application/json',
  };
}

export async function fetchReturnAlerts(signal?: AbortSignal): Promise<ReturnAlertsResponse | null> {
  try {
    const res = await fetch('/api/orders/return-alerts', {
      headers: authHeaders(),
      signal,
    });
    const data = (await res.json().catch(() => ({}))) as ReturnAlertsResponse;
    if (!res.ok || data?.success === false) return null;
    return {
      success: true,
      count: Number(data.count) || (Array.isArray(data.unnotified) ? data.unnotified.length : 0),
      unnotified: Array.isArray(data.unnotified) ? data.unnotified : [],
      message: data.message ? String(data.message) : undefined,
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return null;
    return null;
  }
}

export async function ackReturnAlerts(ids?: string[]): Promise<void> {
  try {
    await fetch('/api/orders/return-alerts-ack', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ ids: ids || [], orderSns: ids || [] }),
    });
  } catch {
    /* ignore */
  }
}
