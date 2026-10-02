import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Crown, Loader2, RefreshCw, X } from 'lucide-react';
import {
  AddressBookEntry,
  fetchAddressBookRanking,
} from '../utils/addressBook';
import {
  CustomerOrderRow,
  getCustomerOrderHistory,
  updateCustomerAddress,
} from '../utils/customers';

interface VipCustomersPageProps {
  authHeaders: () => Record<string, string>;
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

const MONTHS = [
  { value: 0, label: 'Cả năm' },
  { value: 1, label: 'Tháng 1' },
  { value: 2, label: 'Tháng 2' },
  { value: 3, label: 'Tháng 3' },
  { value: 4, label: 'Tháng 4' },
  { value: 5, label: 'Tháng 5' },
  { value: 6, label: 'Tháng 6' },
  { value: 7, label: 'Tháng 7' },
  { value: 8, label: 'Tháng 8' },
  { value: 9, label: 'Tháng 9' },
  { value: 10, label: 'Tháng 10' },
  { value: 11, label: 'Tháng 11' },
  { value: 12, label: 'Tháng 12' },
];

export default function VipCustomersPage({ authHeaders }: VipCustomersPageProps) {
  const now = new Date();
  const [year, setYear] = useState<number | null>(null);
  const [month, setMonth] = useState<number>(0);
  const [rows, setRows] = useState<AddressBookEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<AddressBookEntry | null>(null);
  const [detailTab, setDetailTab] = useState<'info' | 'orders'>('info');
  const [addressDraft, setAddressDraft] = useState('');
  const [savingAddress, setSavingAddress] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [orders, setOrders] = useState<CustomerOrderRow[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersError, setOrdersError] = useState<string | null>(null);

  const yearOptions = useMemo(() => {
    const y = now.getFullYear();
    const list: number[] = [];
    for (let i = 0; i < 6; i += 1) list.push(y - i);
    return list;
  }, [now]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const entries = await fetchAddressBookRanking(authHeaders, {
        year: year ?? undefined,
        month: month >= 1 && month <= 12 ? month : null,
        limit: 300,
      });
      const sorted = [...entries].sort(
        (a, b) => (b.total_spent || 0) - (a.total_spent || 0),
      );
      setRows(sorted);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Tải xếp hạng VIP thất bại');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [authHeaders, year, month]);

  useEffect(() => {
    void load();
  }, [load]);

  const openDetail = useCallback((row: AddressBookEntry) => {
    setSelected(row);
    setDetailTab('info');
    setAddressDraft(row.fullAddress || row.street || '');
    setSaveMsg(null);
    setOrders([]);
    setOrdersError(null);
  }, []);

  const closeDetail = useCallback(() => {
    setSelected(null);
    setSaveMsg(null);
  }, []);

  useEffect(() => {
    if (!selected?.phone || detailTab !== 'orders') return;
    let cancelled = false;
    setOrdersLoading(true);
    setOrdersError(null);
    getCustomerOrderHistory(selected.phone, authHeaders)
      .then((list) => {
        if (!cancelled) setOrders(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setOrders([]);
          setOrdersError(err instanceof Error ? err.message : 'Không tải được lịch sử đơn');
        }
      })
      .finally(() => {
        if (!cancelled) setOrdersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, detailTab, authHeaders]);

  const saveAddress = useCallback(async () => {
    if (!selected) return;
    const address = addressDraft.trim();
    if (!address) {
      setSaveMsg('Nhập địa chỉ trước khi lưu.');
      return;
    }
    setSavingAddress(true);
    setSaveMsg(null);
    const result = await updateCustomerAddress(
      selected.id || selected.phone,
      address,
      selected.phone,
      authHeaders,
    );
    setSavingAddress(false);
    if (!result.success) {
      setSaveMsg(result.error || 'Lưu địa chỉ thất bại');
      return;
    }
    setRows((prev) =>
      prev.map((row) =>
        row.id === selected.id
          ? { ...row, street: address, fullAddress: address }
          : row,
      ),
    );
    setSelected((prev) =>
      prev ? { ...prev, street: address, fullAddress: address } : prev,
    );
    setSaveMsg('Đã lưu địa chỉ.');
  }, [selected, addressDraft, authHeaders]);

  return (
    <div className="space-y-4 max-w-6xl mx-auto pb-10">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-extrabold text-slate-900 flex items-center gap-2">
            <Crown className="w-5 h-5 text-amber-500" />
            Khách hàng VIP
          </h2>
          <p className="text-xs text-slate-500 font-medium mt-1">
            Thống kê từ Sổ địa chỉ — sắp xếp theo tổng chi tiêu giảm dần để chọn khách tặng quà.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-slate-200 bg-white text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50 cursor-pointer"
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Làm mới
        </button>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs font-bold text-slate-600 space-y-1">
            <span>Năm mua hàng</span>
            <select
              value={year ?? ''}
              onChange={(e) => {
                const v = e.target.value;
                setYear(v === '' ? null : Number(v));
              }}
              className="block w-40 rounded-xl border border-slate-200 px-3 py-2 text-sm font-semibold bg-white"
            >
              <option value="">Tất cả</option>
              {yearOptions.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-bold text-slate-600 space-y-1">
            <span>Tháng</span>
            <select
              value={month}
              onChange={(e) => setMonth(Number(e.target.value) || 0)}
              disabled={year == null}
              className="block w-40 rounded-xl border border-slate-200 px-3 py-2 text-sm font-semibold bg-white disabled:opacity-50"
            >
              {MONTHS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <div className="text-[11px] font-semibold text-slate-400 pb-2">
            Sort: Tổng chi tiêu ↓ · {rows.length} khách
          </div>
        </div>

        {error && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">
            {error}
          </div>
        )}

        <div className="overflow-x-auto rounded-xl border border-slate-100">
          <table className="min-w-full text-xs">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="px-3 py-2.5 text-left font-bold">STT</th>
                <th className="px-3 py-2.5 text-left font-bold">Tên</th>
                <th className="px-3 py-2.5 text-left font-bold">Số điện thoại</th>
                <th className="px-3 py-2.5 text-left font-bold">Địa chỉ</th>
                <th className="px-3 py-2.5 text-right font-bold">Tổng số đơn</th>
                <th className="px-3 py-2.5 text-right font-bold">Tổng chi tiêu</th>
                <th className="px-3 py-2.5 text-left font-bold">Ngày mua cuối</th>
                <th className="px-3 py-2.5 text-right font-bold">Thao tác</th>
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-3 py-10 text-center text-slate-400 font-semibold">
                    <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" />
                    Đang tải…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-3 py-10 text-center text-slate-400 font-semibold">
                    Chưa có dữ liệu VIP — tạo đơn nhanh có SĐT để tích lũy chi tiêu.
                  </td>
                </tr>
              ) : (
                rows.map((row, i) => (
                  <tr
                    key={row.id || `${row.phone}-${i}`}
                    className={`border-t border-slate-100 ${i < 3 && (row.total_spent || 0) > 0 ? 'bg-amber-50/40' : ''}`}
                  >
                    <td className="px-3 py-2.5 font-bold text-slate-500">{i + 1}</td>
                    <td className="px-3 py-2.5 font-extrabold text-slate-800">
                      {i === 0 && (row.total_spent || 0) > 0 && (
                        <Crown className="w-3.5 h-3.5 text-amber-500 inline-block mr-1 -mt-0.5" />
                      )}
                      {row.name || '—'}
                    </td>
                    <td className="px-3 py-2.5 font-semibold text-slate-700 tabular-nums">
                      {row.phone || '—'}
                    </td>
                    <td className="px-3 py-2.5 text-slate-600 max-w-xs truncate" title={row.fullAddress || row.street}>
                      {row.fullAddress || row.street || '—'}
                    </td>
                    <td className="px-3 py-2.5 text-right font-bold tabular-nums text-slate-700">
                      {row.total_orders ?? 0}
                    </td>
                    <td className="px-3 py-2.5 text-right font-black tabular-nums text-emerald-700">
                      {formatVnd(row.total_spent || 0)}₫
                    </td>
                    <td className="px-3 py-2.5 font-semibold text-slate-600">
                      {formatDate(row.last_purchase_date)}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <button
                        type="button"
                        onClick={() => openDetail(row)}
                        className="inline-flex items-center px-2.5 py-1.5 rounded-lg bg-slate-900 text-white text-[11px] font-bold hover:bg-slate-800 cursor-pointer"
                      >
                        Chi tiết
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {selected && (
        <div
          className="fixed inset-0 z-[80] flex items-end sm:items-center justify-center bg-slate-900/50 p-0 sm:p-4"
          onClick={closeDetail}
        >
          <div
            className="w-full sm:max-w-2xl max-h-[92vh] overflow-hidden flex flex-col rounded-t-2xl sm:rounded-2xl bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Chi tiết khách hàng"
          >
            <div className="flex items-start justify-between gap-3 px-4 py-3 border-b border-slate-100">
              <div className="min-w-0">
                <div className="text-sm font-extrabold text-slate-900 truncate">
                  {selected.name || 'Khách hàng'}
                </div>
                <div className="text-xs font-semibold text-slate-500 tabular-nums">
                  {selected.phone || '—'}
                </div>
              </div>
              <button
                type="button"
                onClick={closeDetail}
                className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 cursor-pointer"
                aria-label="Đóng"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex border-b border-slate-100 px-2">
              <button
                type="button"
                onClick={() => setDetailTab('info')}
                className={`px-3 py-2.5 text-xs font-bold border-b-2 cursor-pointer ${
                  detailTab === 'info'
                    ? 'border-slate-900 text-slate-900'
                    : 'border-transparent text-slate-500'
                }`}
              >
                Thông tin cá nhân
              </button>
              <button
                type="button"
                onClick={() => setDetailTab('orders')}
                className={`px-3 py-2.5 text-xs font-bold border-b-2 cursor-pointer ${
                  detailTab === 'orders'
                    ? 'border-slate-900 text-slate-900'
                    : 'border-transparent text-slate-500'
                }`}
              >
                Lịch sử đơn hàng
              </button>
            </div>

            <div className="overflow-y-auto p-4">
              {detailTab === 'info' ? (
                <div className="space-y-3">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <div className="text-[11px] font-bold text-slate-500">Tên</div>
                      <div className="text-sm font-extrabold text-slate-800">{selected.name || '—'}</div>
                    </div>
                    <div>
                      <div className="text-[11px] font-bold text-slate-500">Số điện thoại</div>
                      <div className="text-sm font-bold text-slate-800 tabular-nums">{selected.phone || '—'}</div>
                    </div>
                  </div>
                  <label className="block space-y-1">
                    <span className="text-[11px] font-bold text-slate-500">Địa chỉ</span>
                    <textarea
                      value={addressDraft}
                      onChange={(e) => setAddressDraft(e.target.value)}
                      rows={3}
                      className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium text-slate-800"
                    />
                  </label>
                  {saveMsg && (
                    <div className="text-xs font-bold text-slate-600">{saveMsg}</div>
                  )}
                  <button
                    type="button"
                    onClick={() => void saveAddress()}
                    disabled={savingAddress}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-600 text-white text-xs font-bold hover:bg-emerald-700 disabled:opacity-50 cursor-pointer"
                  >
                    {savingAddress && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                    Lưu thay đổi
                  </button>
                </div>
              ) : (
                <div className="space-y-2">
                  {ordersError && (
                    <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">
                      {ordersError}
                    </div>
                  )}
                  {ordersLoading ? (
                    <div className="py-8 text-center text-xs font-semibold text-slate-400">
                      <Loader2 className="w-4 h-4 animate-spin inline-block mr-2" />
                      Đang tải đơn hàng…
                    </div>
                  ) : orders.length === 0 ? (
                    <div className="py-8 text-center text-xs font-semibold text-slate-400">
                      Chưa có đơn hàng khớp số điện thoại này.
                    </div>
                  ) : (
                    <div className="overflow-x-auto rounded-xl border border-slate-100">
                      <table className="min-w-full text-xs">
                        <thead className="bg-slate-50 text-slate-600">
                          <tr>
                            <th className="px-2.5 py-2 text-left font-bold">Mã đơn</th>
                            <th className="px-2.5 py-2 text-left font-bold">Ngày mua</th>
                            <th className="px-2.5 py-2 text-left font-bold">Sản phẩm</th>
                            <th className="px-2.5 py-2 text-right font-bold">Tổng tiền</th>
                            <th className="px-2.5 py-2 text-left font-bold">Trạng thái</th>
                          </tr>
                        </thead>
                        <tbody>
                          {orders.map((order) => (
                            <tr key={`${order.orderSn}-${order.date || ''}`} className="border-t border-slate-100 align-top">
                              <td className="px-2.5 py-2 font-bold text-slate-800 whitespace-nowrap">{order.orderSn}</td>
                              <td className="px-2.5 py-2 font-semibold text-slate-600 whitespace-nowrap">{formatDate(order.date)}</td>
                              <td className="px-2.5 py-2 text-slate-700 max-w-[220px]">{order.products}</td>
                              <td className="px-2.5 py-2 text-right font-black tabular-nums text-emerald-700 whitespace-nowrap">
                                {formatVnd(order.total)}₫
                              </td>
                              <td className="px-2.5 py-2 font-semibold text-slate-700 whitespace-nowrap">
                                {statusLabel(order.status)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
