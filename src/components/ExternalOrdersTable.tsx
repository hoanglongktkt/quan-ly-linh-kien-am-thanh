import React, { useState } from 'react';
import { Loader2, Printer, RefreshCw, Ban } from 'lucide-react';
import type { Order } from '../types';
import { orderCreatedAtMs, parseOrderTimeMs } from '../utils/sanitizeOrder';

type ExternalStatusKey = 'created' | 'shipping' | 'delivered' | 'rts' | 'cancelled';

function resolveExternalStatus(order: Order): ExternalStatusKey {
  const ext = String(
    (order as { external_status?: string }).external_status || '',
  ).toLowerCase();
  const ghn = String((order as { ghn_status?: string }).ghn_status || '').toLowerCase();
  const raw = String(order.shopee_order_status || '').toUpperCase();
  if (
    ext === 'cancelled' ||
    raw === 'EXTERNAL_CANCELLED' ||
    ghn === 'cancel' ||
    ghn === 'cancelled' ||
    ghn === 'canceled'
  ) {
    return 'cancelled';
  }
  if (ext === 'rts' || raw === 'EXTERNAL_RTS' || raw.includes('RTS') || order.is_rts === true) {
    return 'rts';
  }
  if (
    ext === 'delivered' ||
    raw === 'EXTERNAL_DELIVERED' ||
    raw.includes('DELIVER') ||
    order.status === 'completed'
  ) {
    return 'delivered';
  }
  if (
    ext === 'shipping' ||
    raw === 'EXTERNAL_SHIPPING' ||
    raw.includes('SHIPPING') ||
    order.status === 'shipping'
  ) {
    return 'shipping';
  }
  return 'created';
}

const STATUS_META: Record<
  ExternalStatusKey,
  { label: string; className: string }
> = {
  created: {
    label: 'Đã tạo đơn',
    className: 'bg-sky-50 text-sky-800 border-sky-200',
  },
  shipping: {
    label: 'Đang giao',
    className: 'bg-indigo-50 text-indigo-800 border-indigo-200',
  },
  delivered: {
    label: 'Giao thành công',
    className: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  },
  rts: {
    label: 'Giao không thành công / RTS',
    className: 'bg-rose-50 text-rose-800 border-rose-200',
  },
  cancelled: {
    label: 'Đã hủy',
    className: 'bg-slate-100 text-slate-700 border-slate-300',
  },
};

function providerOf(order: Order): 'ghn' | 'spx' | 'self' {
  const p = String(
    (order as { provider?: string }).provider || order.carrier || '',
  ).toLowerCase();
  if (p === 'ghn' || p === 'spx') return p;
  const carrier = String(order.shipping_carrier || '').toLowerCase();
  if (carrier.includes('ghn') || carrier.includes('giao hàng nhanh')) return 'ghn';
  if (carrier.includes('spx')) return 'spx';
  return 'self';
}

function ProviderBadge({ provider }: { provider: 'ghn' | 'spx' | 'self' }) {
  if (provider === 'ghn') {
    return (
      <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-emerald-600 text-white text-[9px] font-black tracking-wide">
        GHN
      </span>
    );
  }
  if (provider === 'spx') {
    return (
      <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-orange-500 text-white text-[9px] font-black tracking-wide">
        SPX
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-slate-500 text-white text-[9px] font-black tracking-wide">
      TỰ GIAO
    </span>
  );
}

function formatAddress(order: Order): string {
  const sa = order.shippingAddress;
  if (sa && typeof sa === 'object') {
    const full = String((sa as { fullAddress?: string }).fullAddress || '').trim();
    if (full) return full;
    return [
      (sa as { street?: string }).street,
      (sa as { ward?: string }).ward,
      (sa as { district?: string }).district,
      (sa as { province?: string }).province,
    ]
      .filter(Boolean)
      .join(', ');
  }
  if (typeof sa === 'string' && sa.trim()) return sa;
  return String(order.customerAddress || '').trim() || '—';
}

function trackingOf(order: Order): string {
  return String(order.tracking_no || order.trackingNumber || '').trim();
}

function orderKeyOf(order: Order): string {
  return String(order.id || order.orderSn || '').trim();
}

function codOf(order: Order): number {
  const n = Number((order as { cod_amount?: number }).cod_amount ?? order.totalAmount);
  return Number.isFinite(n) ? n : 0;
}

function formatOrderDateTime(raw: unknown): string {
  const ms = parseOrderTimeMs(raw);
  if (ms <= 0) return '—';
  try {
    return new Date(ms).toLocaleString('vi-VN', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return String(raw || '—');
  }
}

function orderDeliveredAtMs(order: Order): number {
  const raw = order as Record<string, unknown>;
  const candidates = [
    order.ghn_synced_at,
    raw.updated_at,
    raw.updatedAt,
    raw.update_time,
    order.local_status_updated_at,
    order.localStatusAt,
  ];
  for (let i = 0; i < candidates.length; i += 1) {
    const t = parseOrderTimeMs(candidates[i]);
    if (t > 0) return t;
  }
  return 0;
}

function OrderTimeCell({ order, status }: { order: Order; status: ExternalStatusKey }) {
  const createdMs = orderCreatedAtMs(order);
  const deliveredMs = status === 'delivered' ? orderDeliveredAtMs(order) : 0;
  return (
    <div className="leading-snug">
      <div className="font-bold text-gray-900 text-[11px] whitespace-nowrap">
        Tạo: {formatOrderDateTime(createdMs > 0 ? createdMs : order.date)}
      </div>
      {status === 'delivered' && deliveredMs > 0 ? (
        <div className="text-[10px] text-emerald-600 font-semibold mt-0.5 whitespace-nowrap">
          Giao: {formatOrderDateTime(deliveredMs)}
        </div>
      ) : null}
    </div>
  );
}

async function postGhnOrderAction(path: string, order: Order): Promise<Record<string, unknown>> {
  const token = localStorage.getItem('admin_token') || '';
  const id = encodeURIComponent(String(order.id || order.orderSn || '').trim());
  const res = await fetch(`/api/orders/${id}/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: token ? `Bearer ${token}` : '',
    },
    body: JSON.stringify({ orderSn: order.orderSn }),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || data?.success === false) {
    throw new Error(String(data?.message || data?.error || 'Thao tác GHN thất bại'));
  }
  return data;
}

function GhnActionButtons({
  order,
  busyKind,
  onPrintWaybill,
  onSyncGhn,
  onCancelGhn,
}: {
  order: Order;
  busyKind: 'print' | 'sync' | 'cancel' | null;
  onPrintWaybill: (order: Order) => void;
  onSyncGhn: (order: Order) => void;
  onCancelGhn: (order: Order) => void;
}) {
  const provider = providerOf(order);
  const tn = trackingOf(order);
  const st = resolveExternalStatus(order);
  const printBusy = busyKind === 'print';
  const syncBusy = busyKind === 'sync';
  const cancelBusy = busyKind === 'cancel';
  const anyBusy = Boolean(busyKind);
  const canGhn = provider === 'ghn' && Boolean(tn);
  const canCancel = canGhn && st !== 'cancelled' && st !== 'delivered';

  return (
    <div className="inline-flex flex-col items-stretch gap-1 min-w-[8.5rem]">
      <button
        type="button"
        disabled={anyBusy || provider === 'self' || !tn}
        onClick={() => onPrintWaybill(order)}
        className="inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white font-bold text-[10px] rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed"
        title={
          provider === 'self'
            ? 'Đơn tự giao không có phiếu bưu cục'
            : !tn
              ? 'Chưa có mã vận đơn từ hãng'
              : 'Mở PDF vận đơn gốc của hãng'
        }
      >
        {printBusy ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <Printer className="w-3.5 h-3.5" />
        )}
        In vận đơn
      </button>
      <button
        type="button"
        disabled={anyBusy || !canGhn}
        onClick={() => onSyncGhn(order)}
        className="inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-[10px] rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed"
        title={!canGhn ? 'Chỉ đồng bộ đơn GHN đã có mã vận đơn' : 'Lấy trạng thái mới nhất từ GHN'}
      >
        {syncBusy ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <RefreshCw className="w-3.5 h-3.5" />
        )}
        Đồng bộ GHN
      </button>
      <button
        type="button"
        disabled={anyBusy || !canCancel}
        onClick={() => onCancelGhn(order)}
        className="inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 bg-rose-600 hover:bg-rose-700 text-white font-bold text-[10px] rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed"
        title={
          !canGhn
            ? 'Chỉ hủy vận đơn GHN'
            : st === 'cancelled'
              ? 'Đơn đã hủy'
              : 'Hủy đồng thời trên GHN và phần mềm'
        }
      >
        {cancelBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Ban className="w-3.5 h-3.5" />}
        Hủy vận chuyển
      </button>
    </div>
  );
}

export function ExternalOrdersTable({
  orders,
  printingOrderId,
  onPrintWaybill,
  onOrderUpdated,
}: {
  orders: Order[];
  printingOrderId: string | null;
  onPrintWaybill: (order: Order) => void;
  onOrderUpdated?: (order: Order) => void;
}) {
  const [actionKey, setActionKey] = useState<string | null>(null);
  const [actionKind, setActionKind] = useState<'print' | 'sync' | 'cancel' | null>(null);

  const runGhnAction = async (order: Order, kind: 'sync' | 'cancel') => {
    const key = orderKeyOf(order);
    if (!key || actionKey) return;
    if (kind === 'cancel') {
      const ok = window.confirm(
        'Hủy đơn vận chuyển trên GHN và đổi trạng thái Đã hủy trên phần mềm?',
      );
      if (!ok) return;
    }
    setActionKey(key);
    setActionKind(kind);
    try {
      const path = kind === 'sync' ? 'sync-ghn' : 'cancel-ghn';
      const data = await postGhnOrderAction(path, order);
      const updated = (data.order || null) as Order | null;
      if (updated && onOrderUpdated) onOrderUpdated(updated);
      const msg = String(data.message || (kind === 'sync' ? 'Đã đồng bộ GHN' : 'Đã hủy đơn GHN'));
      window.alert(msg);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Thao tác GHN thất bại';
      window.alert(msg);
    } finally {
      setActionKey(null);
      setActionKind(null);
    }
  };

  if (orders.length === 0) {
    return (
      <div className="bg-white rounded-2xl border border-gray-100 px-6 py-16 text-center text-sm text-gray-500 font-medium">
        Chưa có đơn ngoại sàn. Bấm “Tạo đơn hàng ngoài sàn” để lên đơn GHN/SPX.
      </div>
    );
  }

  return (
    <>
      <div className="overflow-x-auto om-orders-table-view max-md:hidden bg-white rounded-2xl border border-gray-100">
        <table className="w-full text-left border-collapse text-xs">
          <thead>
            <tr className="bg-slate-50 border-b border-gray-100 text-[10px] font-bold text-gray-400 uppercase tracking-wider">
              <th className="p-4 w-40">Thời gian</th>
              <th className="p-4 w-48">Mã vận đơn</th>
              <th className="p-4 w-44">Khách hàng</th>
              <th className="p-4">Địa chỉ</th>
              <th className="p-4 text-right w-32">Tiền thu hộ (COD)</th>
              <th className="p-4 text-center w-40">Trạng thái</th>
              <th className="p-4 text-center w-40">Thao tác</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {orders.map((order) => {
              const provider = providerOf(order);
              const tn = trackingOf(order);
              const st = resolveExternalStatus(order);
              const meta = STATUS_META[st];
              const key = orderKeyOf(order);
              const printBusy = printingOrderId === order.id || printingOrderId === order.orderSn;
              const rowBusy = actionKey === key;
              const busyKind = printBusy ? 'print' : rowBusy ? actionKind : null;
              return (
                <tr key={order.id || order.orderSn} className="hover:bg-slate-50/40">
                  <td className="p-4">
                    <OrderTimeCell order={order} status={st} />
                  </td>
                  <td className="p-4">
                    <div className="flex items-center gap-1.5">
                      <ProviderBadge provider={provider} />
                      {tn ? (
                        <span className="font-mono font-extrabold text-gray-900 text-sm tracking-tight truncate max-w-[10rem]">
                          {tn}
                        </span>
                      ) : (
                        <span className="text-[11px] text-amber-700 italic font-semibold">
                          Chưa có mã hãng
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="p-4">
                    <p className="font-extrabold text-slate-800 truncate" title={order.customerName}>
                      {order.customerName || '—'}
                    </p>
                    <p className="font-mono text-[11px] text-slate-600 mt-0.5">
                      {order.customerPhone || '—'}
                    </p>
                  </td>
                  <td className="p-4">
                    <p className="text-[11px] text-slate-600 leading-snug line-clamp-2" title={formatAddress(order)}>
                      {formatAddress(order)}
                    </p>
                  </td>
                  <td className="p-4 text-right">
                    <span className="font-black text-gray-950 text-sm">
                      {codOf(order).toLocaleString('vi-VN')}đ
                    </span>
                  </td>
                  <td className="p-4 text-center">
                    <span
                      className={`inline-block px-2.5 py-1 text-[10px] font-bold rounded-full border ${meta.className}`}
                    >
                      {meta.label}
                    </span>
                  </td>
                  <td className="p-4 text-center">
                    <GhnActionButtons
                      order={order}
                      busyKind={busyKind}
                      onPrintWaybill={onPrintWaybill}
                      onSyncGhn={(o) => void runGhnAction(o, 'sync')}
                      onCancelGhn={(o) => void runGhnAction(o, 'cancel')}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="om-order-card-list flex flex-col divide-y divide-gray-100 w-full bg-white rounded-2xl border border-gray-100 md:hidden">
        {orders.map((order) => {
          const provider = providerOf(order);
          const tn = trackingOf(order);
          const st = resolveExternalStatus(order);
          const meta = STATUS_META[st];
          const key = orderKeyOf(order);
          const printBusy = printingOrderId === order.id || printingOrderId === order.orderSn;
          const rowBusy = actionKey === key;
          const busyKind = printBusy ? 'print' : rowBusy ? actionKind : null;
          return (
            <div key={`card-${order.id || order.orderSn}`} className="p-4 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <OrderTimeCell order={order} status={st} />
                <span className={`shrink-0 px-2 py-0.5 text-[10px] font-bold rounded-full border ${meta.className}`}>
                  {meta.label}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <ProviderBadge provider={provider} />
                <span className="font-mono text-xs font-bold">{tn || 'Chưa có mã hãng'}</span>
              </div>
              <p className="text-xs font-bold text-slate-800">
                {order.customerName || '—'} · {order.customerPhone || '—'}
              </p>
              <p className="text-[11px] text-slate-500 leading-snug">{formatAddress(order)}</p>
              <div className="flex items-center justify-between gap-2">
                <span className="font-black text-sm">{codOf(order).toLocaleString('vi-VN')}đ</span>
                <GhnActionButtons
                  order={order}
                  busyKind={busyKind}
                  onPrintWaybill={onPrintWaybill}
                  onSyncGhn={(o) => void runGhnAction(o, 'sync')}
                  onCancelGhn={(o) => void runGhnAction(o, 'cancel')}
                />
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
