import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Product, Order } from '../types';
import { computeDashboardStats } from '../utils/dashboardStats';
import {
  DollarSign,
  ShoppingCart,
  RotateCcw,
  Ban,
  BarChart3,
  Calendar,
  Clock,
  CreditCard,
  Package,
  Truck,
  Navigation,
  Undo2,
  Warehouse,
  TrendingUp,
  Loader2,
  AlertCircle,
  Pencil,
  X,
  ImageOff,
} from 'lucide-react';

export type DashboardDateRange =
  | 'today'
  | 'last_7_days'
  | 'this_month'
  | 'last_month'
  | 'this_quarter'
  | 'this_year';

const DATE_RANGE_OPTIONS: { value: DashboardDateRange; label: string }[] = [
  { value: 'today', label: 'Hôm nay' },
  { value: 'last_7_days', label: '7 ngày qua' },
  { value: 'this_month', label: 'Tháng này' },
  { value: 'last_month', label: 'Tháng trước' },
  { value: 'this_quarter', label: 'Quý này' },
  { value: 'this_year', label: 'Năm nay' },
];

interface DashboardData {
  dateRange: string;
  dateRangeLabel: string;
  kpi: {
    revenue: number;
    newOrders: number;
    returns: number;
    cancelled: number;
  };
  pendingOrders: {
    pendingApproval: number;
    pendingPayment: number;
    pendingPack: number;
    pendingPickup: number;
    shipping: number;
    returnPending: number;
  };
  chart: { key: string; label: string; amount: number }[];
  topProducts: {
    rank: number;
    productId: string;
    title: string;
    sku: string;
    imageUrl: string | null;
    quantitySold: number;
  }[];
  inventory: {
    lowStockThreshold: number;
    lowStockProducts: { id: string; title: string; sku: string; stock: number; imageUrl?: string | null }[];
  };
}

interface DashboardProps {
  orders: Order[];
  products: Product[];
  onTabChange?: (tab: string) => void;
  onEditProductShortcut?: (productId: string) => void;
  onUpdateProduct?: (updated: Product, opts?: { save?: boolean }) => Promise<void>;
  onNavigateToImport?: (productId: string) => void;
}

export default function Dashboard({
  orders,
  products,
  onTabChange,
  onEditProductShortcut,
  onUpdateProduct,
  onNavigateToImport,
}: DashboardProps) {
  const [dateRange, setDateRange] = useState<DashboardDateRange>('today');
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [usingFallback, setUsingFallback] = useState(false);
  const [stockEditItem, setStockEditItem] = useState<{ id: string; title: string; stock: number } | null>(null);
  const [stockInput, setStockInput] = useState('');
  const [stockSaving, setStockSaving] = useState(false);

  const applyFallback = useCallback(
    (range: DashboardDateRange) => {
      const stats = computeDashboardStats(orders, products, range);
      console.log('[Dashboard] Client fallback stats:', stats);
      setData(stats);
      setUsingFallback(true);
      setError(null);
    },
    [orders, products]
  );

  const fetchDashboard = useCallback(async (range: DashboardDateRange) => {
    const token = localStorage.getItem('admin_token');
    const url = `/api/dashboard?date_range=${encodeURIComponent(range)}`;

    console.log('[Dashboard] Fetch URL:', url);
    console.log('[Dashboard] Query params:', { date_range: range });

    if (!token) {
      const msg = 'Chưa đăng nhập — không có admin_token trong localStorage.';
      console.error('[Dashboard]', msg);
      setError(msg);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    setUsingFallback(false);

    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });

      const contentType = res.headers.get('content-type') || '';
      const rawText = await res.text();

      console.log('[Dashboard] HTTP status:', res.status);
      console.log('[Dashboard] Content-Type:', contentType);

      if (!contentType.includes('application/json')) {
        console.warn('[Dashboard] Non-JSON response — switching to client fallback.');
        console.error('[Dashboard] Body preview:', rawText.slice(0, 200));
        if (orders.length > 0 || products.length > 0) {
          applyFallback(range);
          return;
        }
        setError(
          res.status === 404
            ? 'API /api/dashboard không tồn tại — hãy restart server (npm run dev).'
            : `Backend trả về HTML thay vì JSON (HTTP ${res.status}). Hãy restart server.`
        );
        setData(null);
        return;
      }

      let payload: DashboardData & { error?: string; message?: string };
      try {
        payload = JSON.parse(rawText);
      } catch {
        setError('Không parse được JSON từ API dashboard.');
        setData(null);
        return;
      }

      console.log('[Dashboard] Response:', payload);

      if (!res.ok) {
        if (orders.length > 0 || products.length > 0) {
          applyFallback(range);
          return;
        }
        setError(payload.message || payload.error || `Lỗi HTTP ${res.status}`);
        setData(null);
        return;
      }

      setData(payload);
      setUsingFallback(false);
    } catch (err) {
      if (orders.length > 0 || products.length > 0) {
        applyFallback(range);
        return;
      }
      const msg = err instanceof Error ? err.message : 'Lỗi kết nối API dashboard.';
      console.error('[Dashboard] Fetch error:', err);
      setError(msg);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [orders, products, applyFallback]);

  useEffect(() => {
    fetchDashboard(dateRange);
  }, [dateRange, fetchDashboard, orders.length, products.length]);

  const refreshInventoryList = useCallback(() => {
    if (usingFallback) {
      applyFallback(dateRange);
    } else {
      fetchDashboard(dateRange);
    }
  }, [usingFallback, applyFallback, dateRange, fetchDashboard]);

  const openStockModal = (item: { id: string; title: string; stock: number }) => {
    setStockEditItem(item);
    setStockInput(String(item.stock));
  };

  const closeStockModal = () => {
    if (stockSaving) return;
    setStockEditItem(null);
    setStockInput('');
  };

  const handleConfirmStock = async () => {
    if (!stockEditItem || !onUpdateProduct) return;
    const qty = Number(stockInput);
    if (!Number.isFinite(qty) || qty < 0) {
      alert('Vui lòng nhập số lượng hợp lệ (≥ 0).');
      return;
    }
    const product = products.find((p) => p.id === stockEditItem.id);
    if (!product) return;

    setStockSaving(true);
    try {
      await onUpdateProduct({ ...product, stock: qty }, { save: true });
      setStockEditItem(null);
      setStockInput('');
      refreshInventoryList();
    } finally {
      setStockSaving(false);
    }
  };

  const lowStockThreshold = data?.inventory.lowStockThreshold ?? 5;
  const lowStockProducts = useMemo(() => {
    const resolveImage = (id: string) => {
      const prod = products.find((p) => p.id === id);
      return prod?.avatarUrl || prod?.imageUrl || null;
    };

    const base =
      data?.inventory.lowStockProducts ??
      products
        .filter((p) => (Number(p.stock) || 0) < lowStockThreshold)
        .map((p) => ({
          id: p.id,
          title: p.title || p.sku || p.id,
          sku: p.sku || '',
          stock: Number(p.stock) || 0,
        }));

    return base
      .map((item) => ({
        ...item,
        imageUrl: item.imageUrl ?? resolveImage(item.id),
      }))
      .sort((a, b) => a.stock - b.stock);
  }, [data, products, lowStockThreshold]);

  const kpiCards = data
    ? [
        {
          id: 'revenue',
          title: 'Doanh thu',
          value: `${data.kpi.revenue.toLocaleString('vi-VN')} đ`,
          icon: DollarSign,
          iconBg: 'bg-blue-50',
          iconColor: 'text-blue-600',
        },
        {
          id: 'new-orders',
          title: 'Đơn hàng mới',
          value: data.kpi.newOrders.toLocaleString('vi-VN'),
          icon: ShoppingCart,
          iconBg: 'bg-emerald-50',
          iconColor: 'text-emerald-600',
        },
        {
          id: 'returns',
          title: 'Đơn trả hàng',
          value: data.kpi.returns.toLocaleString('vi-VN'),
          icon: RotateCcw,
          iconBg: 'bg-amber-50',
          iconColor: 'text-amber-600',
        },
        {
          id: 'cancelled',
          title: 'Đơn hủy',
          value: data.kpi.cancelled.toLocaleString('vi-VN'),
          icon: Ban,
          iconBg: 'bg-rose-50',
          iconColor: 'text-rose-600',
        },
      ]
    : [];

  const pendingCards = data
    ? [
        { key: 'pendingApproval', title: 'Chờ duyệt', count: data.pendingOrders.pendingApproval, icon: Clock, color: 'text-amber-600', bg: 'bg-amber-50' },
        { key: 'pendingPayment', title: 'Chờ thanh toán', count: data.pendingOrders.pendingPayment, icon: CreditCard, color: 'text-orange-600', bg: 'bg-orange-50' },
        { key: 'pendingPack', title: 'Chờ đóng gói', count: data.pendingOrders.pendingPack, icon: Package, color: 'text-sky-600', bg: 'bg-sky-50' },
        { key: 'pendingPickup', title: 'Chờ lấy hàng', count: data.pendingOrders.pendingPickup, icon: Truck, color: 'text-indigo-600', bg: 'bg-indigo-50' },
        { key: 'shipping', title: 'Đang giao hàng', count: data.pendingOrders.shipping, icon: Navigation, color: 'text-blue-600', bg: 'bg-blue-50' },
        { key: 'returnPending', title: 'Hủy giao — chờ nhận', count: data.pendingOrders.returnPending, icon: Undo2, color: 'text-purple-600', bg: 'bg-purple-50' },
      ]
    : [];

  const maxChart = Math.max(...(data?.chart.map((c) => c.amount) || [1]), 1);

  return (
    <div className="space-y-6" id="dashboard-tab">
      <div className="flex flex-col sm:flex-row sm:items-center justify-end gap-3">
        <div className="flex items-center gap-2">
          <Calendar className="w-4 h-4 text-gray-400 shrink-0" />
          <select
            value={dateRange}
            onChange={(e) => setDateRange(e.target.value as DashboardDateRange)}
            className="px-3 py-2.5 min-h-11 bg-white border border-gray-200 rounded-xl text-sm font-semibold text-gray-700 outline-none cursor-pointer focus:border-blue-400 w-full sm:min-w-[160px]"
          >
            {DATE_RANGE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {usingFallback && (
        <div className="p-3 rounded-xl border border-amber-200 bg-amber-50 text-xs text-amber-800">
          Đang dùng dữ liệu local (orders/products). Restart server để kích hoạt API <code className="font-mono">/api/dashboard</code>.
        </div>
      )}

      {error && (
        <div className="p-4 rounded-2xl border border-rose-200 bg-rose-50 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-rose-800">Không tải được dữ liệu Dashboard</p>
            <p className="text-xs text-rose-700 mt-1 break-words">{error}</p>
            <button
              type="button"
              onClick={() => fetchDashboard(dateRange)}
              className="mt-3 px-3 py-1.5 bg-white border border-rose-200 text-rose-700 text-xs font-semibold rounded-lg hover:bg-rose-100"
            >
              Thử lại
            </button>
          </div>
        </div>
      )}

      {loading && !data && !error ? (
        <div className="flex items-center justify-center py-20 text-gray-400 gap-2">
          <Loader2 className="w-5 h-5 animate-spin" />
          <span className="text-sm font-medium">Đang tải dữ liệu tổng quan...</span>
        </div>
      ) : data ? (
        <>
          <div className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 transition-opacity ${loading ? 'opacity-60' : ''}`}>
            {kpiCards.map((card) => {
              const Icon = card.icon;
              return (
                <div
                  key={card.id}
                  className="bg-white p-5 rounded-2xl border border-gray-100 shadow-xs flex items-center gap-4"
                >
                  <div className={`w-12 h-12 rounded-xl ${card.iconBg} ${card.iconColor} flex items-center justify-center shrink-0`}>
                    <Icon className="w-6 h-6" />
                  </div>
                  <div className="min-w-0">
                    <span className="text-[11px] text-gray-400 uppercase font-bold tracking-wide block">
                      {card.title}
                    </span>
                    <h3 className="text-xl font-extrabold text-gray-900 mt-0.5 truncate">{card.value}</h3>
                  </div>
                </div>
              );
            })}
          </div>

          <div className={`bg-white p-5 rounded-2xl border border-gray-100 shadow-xs space-y-4 ${loading ? 'opacity-60' : ''}`}>
            <h3 className="font-bold text-sm uppercase tracking-wide text-gray-500">
              Đơn hàng chờ xử lý
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              {pendingCards.map((card) => {
                const Icon = card.icon;
                return (
                  <button
                    key={card.key}
                    type="button"
                    onClick={() => onTabChange?.('orders')}
                    className="p-4 min-h-[72px] rounded-xl border border-gray-100 bg-gray-50/50 hover:bg-white hover:border-gray-200 hover:shadow-xs transition-all text-left"
                  >
                    <div className={`w-9 h-9 rounded-lg ${card.bg} ${card.color} flex items-center justify-center mb-3`}>
                      <Icon className="w-4.5 h-4.5" />
                    </div>
                    <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wide leading-tight min-h-[28px]">
                      {card.title}
                    </p>
                    <p className="text-2xl font-extrabold text-gray-900 mt-1">{card.count}</p>
                  </button>
                );
              })}
            </div>
          </div>

          <div className={`bg-white p-6 rounded-2xl border border-gray-100 shadow-xs ${loading ? 'opacity-60' : ''}`}>
            <div className="flex items-center justify-between gap-4 mb-6">
              <div>
                <h3 className="font-bold text-gray-900 text-base flex items-center gap-2">
                  <BarChart3 className="w-5 h-5 text-blue-500" />
                  Doanh Thu Bán Hàng
                </h3>
                <p className="text-[11px] text-gray-400 mt-0.5">{data?.dateRangeLabel || '7 ngày qua'}</p>
              </div>
            </div>

            <div className="flex items-end justify-between gap-2 sm:gap-3 h-56 border-b border-gray-100 pb-3 overflow-x-auto">
              {(data?.chart || []).map((day) => {
                const heightPct = (day.amount / maxChart) * 100;
                const barHeight = day.amount > 0 ? Math.max(heightPct, 8) : 4;
                return (
                  <div key={day.key} className="flex-1 min-w-[36px] flex flex-col items-center gap-2 group">
                    <span className="text-[10px] font-mono font-bold text-gray-500 opacity-0 group-hover:opacity-100 transition-opacity truncate max-w-full">
                      {day.amount > 0 ? `${(day.amount / 1000).toFixed(0)}k` : '0'}
                    </span>
                    <div className="w-full flex justify-center items-end h-44">
                      <div
                        className="w-full max-w-[40px] bg-blue-500 hover:bg-blue-600 rounded-t-lg transition-all duration-300"
                        style={{ height: `${barHeight}%` }}
                        title={`${day.label}: ${day.amount.toLocaleString('vi-VN')} đ`}
                      />
                    </div>
                    <span className="text-[10px] font-semibold text-gray-600 font-mono text-center">{day.label}</span>
                  </div>
                );
              })}
            </div>
          </div>

          <div className={`grid grid-cols-1 lg:grid-cols-2 gap-6 ${loading ? 'opacity-60' : ''}`}>
            <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-xs">
              <h3 className="font-bold text-gray-900 text-base flex items-center gap-2 mb-5">
                <TrendingUp className="w-5 h-5 text-emerald-500" />
                Top Sản Phẩm Bán Chạy
              </h3>
              {(data?.topProducts.length || 0) === 0 ? (
                <p className="text-sm text-gray-400 text-center py-8">Chưa có dữ liệu bán hàng trong khoảng thời gian này.</p>
              ) : (
                <ul className="space-y-3">
                  {data!.topProducts.map((item) => (
                    <li
                      key={item.productId}
                      className="flex items-center gap-3 p-3 rounded-xl border border-gray-50 bg-gray-50/40 hover:bg-gray-50 transition-colors"
                    >
                      <span className="text-xs font-extrabold text-gray-400 w-6 shrink-0">
                        {String(item.rank).padStart(2, '0')}
                      </span>
                      {item.imageUrl ? (
                        <img
                          src={item.imageUrl}
                          alt=""
                          className="w-10 h-10 rounded-lg object-cover border border-gray-100 shrink-0"
                          referrerPolicy="no-referrer"
                        />
                      ) : (
                        <div className="w-10 h-10 rounded-lg bg-gray-100 border border-gray-100 flex items-center justify-center text-[10px] font-bold text-gray-400 shrink-0">
                          SP
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-gray-900 line-clamp-1">{item.title}</p>
                        <p className="text-[11px] font-mono text-gray-400">{item.sku}</p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-sm font-extrabold text-emerald-600">{item.quantitySold}</p>
                        <p className="text-[10px] text-gray-400">đã bán</p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-xs flex flex-col">
              <h3 className="font-bold text-gray-900 text-base flex items-center gap-2 mb-1">
                <Warehouse className="w-5 h-5 text-indigo-500" />
                Thông Tin Kho
              </h3>
              <p className="text-[11px] text-gray-400 mb-4">
                Sản phẩm tồn &lt; {lowStockThreshold} cái
              </p>

              <div className="max-h-64 overflow-y-auto rounded-xl border border-gray-100 divide-y divide-gray-50">
                {lowStockProducts.length === 0 ? (
                  <p className="text-sm text-gray-400 text-center py-10 px-4">
                    Không có sản phẩm nào dưới định mức
                  </p>
                ) : (
                  lowStockProducts.map((item) => (
                    <div
                      key={item.id}
                      className="flex flex-col sm:flex-row sm:items-center gap-2.5 px-3 py-3 hover:bg-rose-50/80 transition-colors group"
                    >
                      <div className="flex items-center gap-2.5 flex-1 min-w-0">
                        {item.imageUrl ? (
                          <img
                            src={item.imageUrl}
                            alt=""
                            className="w-10 h-10 rounded-lg object-cover border border-gray-100 shrink-0"
                            referrerPolicy="no-referrer"
                          />
                        ) : (
                          <div
                            className="w-10 h-10 rounded-lg bg-gray-100 border border-gray-200 flex items-center justify-center shrink-0"
                            title="Không có ảnh"
                          >
                            <ImageOff className="w-4 h-4 text-gray-400" />
                          </div>
                        )}

                        <button
                          type="button"
                          onClick={() => onEditProductShortcut?.(item.id)}
                          className="flex-1 min-w-0 text-left"
                        >
                          <p className="text-sm font-medium text-gray-800 group-hover:text-rose-800 line-clamp-1">
                            {item.title}
                          </p>
                          <p className="text-[11px] font-mono text-gray-400 truncate">{item.sku || '—'}</p>
                        </button>
                      </div>

                      <div className="flex items-center justify-between sm:justify-end gap-2 sm:gap-1 shrink-0 pl-[3.25rem] sm:pl-0">
                        <span className="text-sm font-bold text-rose-600 whitespace-nowrap">
                          Tồn: {item.stock}
                        </span>

                        <div className="flex items-center gap-1">
                        <button
                          type="button"
                          title="Điều chỉnh tồn kho nhanh"
                          onClick={(e) => {
                            e.stopPropagation();
                            openStockModal(item);
                          }}
                          className="inline-flex items-center justify-center gap-1 min-h-11 px-3 py-2 text-[11px] font-semibold rounded-lg border border-gray-200 bg-white text-gray-600 hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700 hover:shadow-sm transition-all"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                          Sửa
                        </button>
                        <button
                          type="button"
                          title="Nhập hàng cho sản phẩm này"
                          onClick={(e) => {
                            e.stopPropagation();
                            onNavigateToImport?.(item.id);
                          }}
                          className="inline-flex items-center justify-center gap-1 min-h-11 px-3 py-2 text-[11px] font-semibold rounded-lg border border-gray-200 bg-white text-gray-600 hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-700 hover:shadow-sm transition-all"
                        >
                          <Truck className="w-3.5 h-3.5" />
                          Nhập
                        </button>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </>
      ) : null}

      {stockEditItem && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4"
          onClick={closeStockModal}
        >
          <div
            className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-5 border border-gray-100"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 mb-4">
              <div>
                <h4 className="font-bold text-gray-900 text-base">Điều chỉnh tồn kho nhanh</h4>
                <p className="text-xs text-gray-500 mt-1 line-clamp-2">{stockEditItem.title}</p>
              </div>
              <button
                type="button"
                onClick={closeStockModal}
                disabled={stockSaving}
                className="p-1 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <label className="block text-xs font-semibold text-gray-600 mb-1.5">
              Nhập số lượng thực tế
            </label>
            <input
              type="number"
              min={0}
              step={1}
              value={stockInput}
              onChange={(e) => setStockInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void handleConfirmStock()}
              autoFocus
              className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400"
            />
            <button
              type="button"
              onClick={() => void handleConfirmStock()}
              disabled={stockSaving}
              className="mt-4 w-full py-2.5 rounded-xl bg-indigo-600 text-white text-sm font-bold hover:bg-indigo-700 disabled:opacity-60 transition-colors flex items-center justify-center gap-2"
            >
              {stockSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              Xác nhận
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
