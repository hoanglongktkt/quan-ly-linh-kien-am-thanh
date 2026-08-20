import React from 'react';
import { Loader2, Printer } from 'lucide-react';
import type { Order } from '../types';

type ExternalStatusKey = 'created' | 'shipping' | 'delivered' | 'rts';

function resolveExternalStatus(order: Order): ExternalStatusKey {
  const raw = String(
    (order as { external_status?: string }).external_status ||
      order.shopee_order_status ||
      '',
  ).toUpperCase();
  if (raw.includes('RTS') || order.is_rts === true || order.status === 'cancelled') return 'rts';
  if (raw.includes('DELIVER') || order.status === 'completed') return 'delivered';
  if (raw.includes('SHIPPING') || order.status === 'shipping') return 'shipping';
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

function codOf(order: Order): number {
  const n = Number((order as { cod_amount?: number }).cod_amount ?? order.totalAmount);
  return Number.isFinite(n) ? n : 0;
}

export function ExternalOrdersTable({
  orders,
  printingOrderId,
  onPrintWaybill,
}: {
  orders: Order[];
  printingOrderId: string | null;
  onPrintWaybill: (order: Order) => void;
}) {
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
              <th className="p-4 w-36">Mã đơn</th>
              <th className="p-4 w-48">Mã vận đơn</th>
              <th className="p-4 w-44">Khách hàng</th>
              <th className="p-4">Địa chỉ</th>
              <th className="p-4 text-right w-32">Tiền thu hộ (COD)</th>
              <th className="p-4 text-center w-40">Trạng thái</th>
              <th className="p-4 text-center w-36">Thao tác</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {orders.map((order) => {
              const provider = providerOf(order);
              const tn = trackingOf(order);
              const st = resolveExternalStatus(order);
              const meta = STATUS_META[st];
              const busy = printingOrderId === order.id || printingOrderId === order.orderSn;
              return (
                <tr key={order.id || order.orderSn} className="hover:bg-slate-50/40">
                  <td className="p-4">
                    <div className="font-mono font-extrabold text-gray-900 text-sm">
                      {order.orderSn}
                    </div>
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
                    <button
                      type="button"
                      disabled={busy || provider === 'self' || !tn}
                      onClick={() => onPrintWaybill(order)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white font-bold text-[10px] rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                      title={
                        provider === 'self'
                          ? 'Đơn tự giao không có phiếu bưu cục'
                          : !tn
                            ? 'Chưa có mã vận đơn từ hãng'
                            : 'Mở PDF vận đơn gốc của hãng'
                      }
                    >
                      {busy ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Printer className="w-3.5 h-3.5" />
                      )}
                      In vận đơn
                    </button>
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
          const busy = printingOrderId === order.id || printingOrderId === order.orderSn;
          return (
            <div key={`card-${order.id || order.orderSn}`} className="p-4 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono font-extrabold text-sm">{order.orderSn}</span>
                <span className={`px-2 py-0.5 text-[10px] font-bold rounded-full border ${meta.className}`}>
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
              <div className="flex items-center justify-between">
                <span className="font-black text-sm">{codOf(order).toLocaleString('vi-VN')}đ</span>
                <button
                  type="button"
                  disabled={busy || provider === 'self' || !tn}
                  onClick={() => onPrintWaybill(order)}
                  className="inline-flex items-center gap-1 px-3 py-1.5 bg-blue-600 text-white font-bold text-[10px] rounded-lg disabled:opacity-50"
                >
                  {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Printer className="w-3.5 h-3.5" />}
                  In vận đơn
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
