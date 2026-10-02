import React, { useEffect, useState } from 'react';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { CustomerOrderRow, getCustomerOrderHistory } from '../utils/customers';

interface CustomerOrderHistoryPageProps {
  phone: string;
  authHeaders: () => Record<string, string>;
  onBack: () => void;
}

function formatVnd(n: number): string {
  return Math.round(n || 0).toLocaleString('vi-VN');
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('vi-VN');
}

const STATUS_LABELS: Record<string, string> = {
  COMPLETED: 'Hoàn thành',
  CANCELLED: 'Đã hủy',
  IN_CANCEL: 'Đang hủy',
  READY_TO_SHIP: 'Chờ lấy hàng',
  PROCESSED: 'Đã xử lý',
  SHIPPED: 'Đang giao',
  TO_CONFIRM_RECEIVE: 'Chờ nhận',
  TO_RETURN: 'Trả hàng',
  UNPAID: 'Chưa thanh toán',
  completed: 'Hoàn thành',
  cancelled: 'Đã hủy',
  shipping: 'Đang giao',
  pending: 'Chờ xử lý',
};

function statusLabel(status: string): string {
  return STATUS_LABELS[status] || status || '—';
}

export default function CustomerOrderHistoryPage({
  phone,
  authHeaders,
  onBack,
}: CustomerOrderHistoryPageProps) {
  const [orders, setOrders] = useState<CustomerOrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getCustomerOrderHistory(phone, authHeaders)
      .then((list) => {
        if (!cancelled) setOrders(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setOrders([]);
          setError(err instanceof Error ? err.message : 'Không tải được lịch sử đơn');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [phone, authHeaders]);

  return (
    <div className="space-y-4 max-w-6xl mx-auto pb-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-600 hover:text-slate-900 cursor-pointer mb-2"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Quay lại
          </button>
          <h2 className="text-lg font-extrabold text-slate-900">Lịch sử đơn hàng</h2>
          <p className="text-xs text-slate-500 font-medium mt-1 tabular-nums">
            Số điện thoại {phone}
          </p>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">
          {error}
        </div>
      )}

      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
        {loading ? (
          <div className="py-16 text-center text-sm font-semibold text-slate-400">
            <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" />
            Đang tải lịch sử đơn…
          </div>
        ) : orders.length === 0 ? (
          <div className="py-16 text-center text-sm font-semibold text-slate-400">
            Chưa có đơn hàng khớp số điện thoại này.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-[880px] w-full text-xs">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="px-3 py-2.5 text-left font-bold">Mã đơn</th>
                  <th className="px-3 py-2.5 text-left font-bold">Ngày mua</th>
                  <th className="px-3 py-2.5 text-left font-bold">Tên sản phẩm</th>
                  <th className="px-3 py-2.5 text-right font-bold">Số lượng</th>
                  <th className="px-3 py-2.5 text-right font-bold">Đơn giá</th>
                  <th className="px-3 py-2.5 text-right font-bold">Thành tiền</th>
                  <th className="px-3 py-2.5 text-left font-bold">Trạng thái</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order, orderIndex) =>
                  order.items.map((item, itemIndex) => (
                    <tr
                      key={`${order.orderSn}-${itemIndex}`}
                      className={`border-t border-slate-100 ${orderIndex % 2 === 0 ? 'bg-white' : 'bg-slate-50/70'}`}
                    >
                      {itemIndex === 0 && (
                        <td
                          rowSpan={order.items.length}
                          className="px-3 py-2.5 font-bold text-slate-800 align-top whitespace-nowrap"
                        >
                          {order.orderSn}
                        </td>
                      )}
                      {itemIndex === 0 && (
                        <td
                          rowSpan={order.items.length}
                          className="px-3 py-2.5 font-semibold text-slate-600 align-top whitespace-nowrap"
                        >
                          {formatDate(order.date)}
                        </td>
                      )}
                      <td className="px-3 py-2.5 text-slate-800">{item.name}</td>
                      <td className="px-3 py-2.5 text-right font-bold tabular-nums text-slate-700">
                        {item.quantity}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-700 whitespace-nowrap">
                        {formatVnd(item.price)}₫
                      </td>
                      <td className="px-3 py-2.5 text-right font-black tabular-nums text-emerald-700 whitespace-nowrap">
                        {formatVnd(item.lineTotal)}₫
                      </td>
                      {itemIndex === 0 && (
                        <td
                          rowSpan={order.items.length}
                          className="px-3 py-2.5 font-semibold text-slate-700 align-top whitespace-nowrap"
                        >
                          {statusLabel(order.status)}
                        </td>
                      )}
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
