import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Product, Order, SystemFee, getProductChildren } from '../types';
import { computeDashboardStats, isRtsOrder } from '../utils/dashboardStats';
import { buildShopeeSyncPayload } from '../utils/shopeeSyncPayload';
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
  ImageOff,
  CheckCircle2,
  XCircle,
} from 'lucide-react';

export type DashboardDateRange =
  | 'today'
  | 'last_7_days'
  | 'this_month'
  | 'last_month'
  | 'this_quarter'
  | 'this_year';

const DATE_RANGE_OPTIONS: { value: DashboardDateRange; label: string }[] = [
  { value: 'last_7_days', label: '7 ngày qua' },
  { value: 'this_month', label: 'Tháng này' },
  { value: 'last_month', label: 'Tháng trước' },
  { value: 'this_quarter', label: 'Quý này' },
  { value: 'this_year', label: 'Năm nay' },
];

function formatVnd(amount: number): string {
  return Math.round(Number(amount) || 0).toLocaleString('vi-VN');
}

interface DashboardData {
  dateRange: string;
  dateRangeLabel: string;
  kpi: {
    revenue: number;
    profit: number;
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
  chart: { key: string; label: string; amount: number; profit: number }[];
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

function normalizeDashboardPayload(raw: Partial<DashboardData> | null | undefined): DashboardData | null {
  if (!raw || typeof raw !== 'object') return null;
  const kpi = raw.kpi || { revenue: 0, profit: 0, newOrders: 0, returns: 0, cancelled: 0 };
  const pending = raw.pendingOrders || {
    pendingApproval: 0,
    pendingPayment: 0,
    pendingPack: 0,
    pendingPickup: 0,
    shipping: 0,
    returnPending: 0,
  };
  return {
    dateRange: String(raw.dateRange || 'last_7_days'),
    dateRangeLabel: String(raw.dateRangeLabel || '7 ngày qua'),
    kpi: {
      revenue: Number(kpi.revenue) || 0,
      profit: Number.isFinite(Number(kpi.profit)) ? Number(kpi.profit) : 0,
      newOrders: Number(kpi.newOrders) || 0,
      returns: Number(kpi.returns) || 0,
      cancelled: Number(kpi.cancelled) || 0,
    },
    pendingOrders: {
      pendingApproval: Number(pending.pendingApproval) || 0,
      pendingPayment: Number(pending.pendingPayment) || 0,
      pendingPack: Number(pending.pendingPack) || 0,
      pendingPickup: Number(pending.pendingPickup) || 0,
      shipping: Number(pending.shipping) || 0,
      returnPending: Number(pending.returnPending) || 0,
    },
    chart: Array.isArray(raw.chart)
      ? raw.chart.map((day) => ({
          key: String(day?.key || ''),
          label: String(day?.label || ''),
          amount: Number(day?.amount) || 0,
          profit: Number.isFinite(Number(day?.profit)) ? Number(day.profit) : 0,
        }))
      : [],
    topProducts: Array.isArray(raw.topProducts) ? raw.topProducts : [],
    inventory: {
      lowStockThreshold: Number(raw.inventory?.lowStockThreshold) || 5,
      lowStockProducts: Array.isArray(raw.inventory?.lowStockProducts) ? raw.inventory!.lowStockProducts! : [],
    },
  };
}

interface DashboardProps {
  orders: Order[];
  products: Product[];
  onTabChange?: (
    tab: string,
    options?: {
      ordersSubTab?:
        | 'pending_confirm'
        | 'unprocessed'
        | 'processed'
        | 'shipping'
        | 'cancel_returns';
    },
  ) => void;
  onEditProductShortcut?: (productId: string) => void;
  onUpdateProduct?: (
    updated: Product,
    opts?: { save?: boolean },
  ) => Promise<void | { success?: boolean; error?: string }>;
  onNavigateToImport?: (productId: string) => void;
  rtsCount?: number;
  systemFees?: SystemFee[];
}

export default function Dashboard({
  orders,
  products,
  onTabChange,
  onEditProductShortcut,
  onUpdateProduct,
  onNavigateToImport,
  rtsCount: rtsCountProp,
  systemFees = [],
}: DashboardProps) {
  const [dateRange, setDateRange] = useState<DashboardDateRange>('last_7_days');
  const [data, setData] = useState<DashboardData | null>(null);
  const [rtsCountApi, setRtsCountApi] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [usingFallback, setUsingFallback] = useState(false);
  /** Draft số lượng theo product id — sửa inline trong widget. */
  const [stockDrafts, setStockDrafts] = useState<Record<string, string>>({});
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ ok: boolean; message: string } | null>(null);
  const ordersRef = useRef(orders);
  const productsRef = useRef(products);
  const systemFeesRef = useRef(systemFees);
  ordersRef.current = orders;
  productsRef.current = products;
  systemFeesRef.current = systemFees;

  const showToast = useCallback((message: string, ok = true) => {
    setToast({ ok, message });
    window.setTimeout(() => setToast(null), 4000);
  }, []);

  const applyFallback = useCallback((range: DashboardDateRange) => {
    const stats = computeDashboardStats(
      ordersRef.current,
      productsRef.current,
      range,
      systemFeesRef.current,
    );
    console.log('[Dashboard] Client fallback stats:', stats);
    setData(normalizeDashboardPayload(stats as unknown as DashboardData));
    setUsingFallback(true);
    setError(null);
  }, []);

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
        if (ordersRef.current.length > 0 || productsRef.current.length > 0) {
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
        if (ordersRef.current.length > 0 || productsRef.current.length > 0) {
          applyFallback(range);
          return;
        }
        setError(payload.message || payload.error || `Lỗi HTTP ${res.status}`);
        setData(null);
        return;
      }

      setData(normalizeDashboardPayload(payload));
      setUsingFallback(false);
    } catch (err) {
      if (ordersRef.current.length > 0 || productsRef.current.length > 0) {
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
  }, [applyFallback]);

  useEffect(() => {
    fetchDashboard(dateRange);
  }, [dateRange, fetchDashboard]);

  useEffect(() => {
    const token = localStorage.getItem('admin_token');
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/orders/counter?t=${Date.now()}`, {
          cache: 'no-store',
          headers: { Authorization: `Bearer ${token}` },
        });
        const json = await res.json().catch(() => ({} as Record<string, unknown>));
        if (cancelled) return;
        const rts = Number(
          (json as { counters?: { rts?: number } })?.counters?.rts ??
            (json as { counts?: Record<string, number> })?.counts?.failed_delivery ??
            (json as { counts?: Record<string, number> })?.counts?.cancel_returns_rts,
        );
        if (Number.isFinite(rts)) setRtsCountApi(rts);
      } catch {
        /* fallback: orders / dashboardStats */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshInventoryList = useCallback(() => {
    if (usingFallback) {
      applyFallback(dateRange);
    } else {
      fetchDashboard(dateRange);
    }
  }, [usingFallback, applyFallback, dateRange, fetchDashboard]);

  const findProductRow = useCallback(
    (productId: string): Product | undefined => {
      for (const p of products) {
        if (p.id === productId) return p;
        const child = getProductChildren(p).find((c) => c.id === productId);
        if (child) return child;
      }
      return undefined;
    },
    [products],
  );

  const handleInlineStockUpdate = useCallback(
    async (item: { id: string; title: string; sku: string; stock: number }) => {
      const raw = stockDrafts[item.id] ?? String(item.stock);
      const qty = Math.round(Number(raw));
      if (!Number.isFinite(qty) || qty < 0) {
        showToast('Vui lòng nhập số lượng hợp lệ (≥ 0).', false);
        return;
      }

      const token = localStorage.getItem('admin_token');
      if (!token) {
        showToast('Chưa đăng nhập.', false);
        return;
      }

      setUpdatingId(item.id);
      try {
        // 1) Lưu kho nội bộ — PATCH /api/products/:id (đã có sẵn, không phụ thuộc phân trang FE).
        const patchRes = await fetch(`/api/products/${encodeURIComponent(item.id)}`, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ stock: qty }),
        });
        const patchData = await patchRes.json().catch(() => ({} as Record<string, unknown>));
        if (!patchRes.ok || patchData?.success === false) {
          showToast(
            String(patchData?.error || patchData?.message || `Lưu tồn kho thất bại (HTTP ${patchRes.status}).`),
            false,
          );
          return;
        }

        // Đồng bộ state FE nếu SKU đang nằm trong trang sản phẩm hiện tại.
        const localRow = findProductRow(item.id);
        if (localRow && onUpdateProduct) {
          void onUpdateProduct({ ...localRow, stock: qty }, { save: false });
        }

        // 2) Đồng bộ lên sàn — POST /api/products/sync-shopee (đã có sẵn).
        const syncRes = await fetch('/api/products/sync-shopee', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(buildShopeeSyncPayload(item.id)),
        });
        const syncData = await syncRes.json().catch(() => ({} as Record<string, unknown>));
        if (!syncRes.ok || syncData?.success === false) {
          showToast(
            String(
              syncData?.error ||
                syncData?.message ||
                syncData?.shopeeMessage ||
                `Đã lưu kho nhưng đồng bộ sàn thất bại (HTTP ${syncRes.status}).`,
            ),
            false,
          );
          refreshInventoryList();
          return;
        }

        showToast(`Đã cập nhật tồn "${item.sku || item.title}" = ${qty} và đồng bộ sàn.`, true);

        setData((prev) => {
          if (!prev) return prev;
          const threshold = prev.inventory.lowStockThreshold || 5;
          const nextList = prev.inventory.lowStockProducts
            .map((row) => (row.id === item.id ? { ...row, stock: qty } : row))
            .filter((row) => row.stock < threshold);
          return {
            ...prev,
            inventory: { ...prev.inventory, lowStockProducts: nextList },
          };
        });
        setStockDrafts((prev) => {
          const next = { ...prev };
          const threshold = data?.inventory.lowStockThreshold ?? 5;
          if (qty >= threshold) delete next[item.id];
          else next[item.id] = String(qty);
          return next;
        });

        refreshInventoryList();
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Cập nhật tồn kho thất bại.', false);
      } finally {
        setUpdatingId(null);
      }
    },
    [
      stockDrafts,
      findProductRow,
      onUpdateProduct,
      showToast,
      refreshInventoryList,
      data?.inventory.lowStockThreshold,
    ],
  );

  const lowStockThreshold = data?.inventory.lowStockThreshold ?? 5;
  const lowStockProducts = useMemo(() => {
    const resolveImage = (id: string) => {
      const prod = findProductRow(id);
      return prod?.avatarUrl || prod?.imageUrl || null;
    };

    const fromApi = data?.inventory.lowStockProducts;
    const fromClient = () => {
      const flat: { id: string; title: string; sku: string; stock: number; imageUrl?: string | null }[] = [];
      for (const p of products) {
        const children = getProductChildren(p);
        const rows = children.length > 0 ? children : [p];
        for (const row of rows) {
          const stock = Number(row.stock) || 0;
          if (stock < lowStockThreshold) {
            flat.push({
              id: row.id,
              title: row.title || row.sku || row.id,
              sku: row.sku || '',
              stock,
              imageUrl: row.avatarUrl || row.imageUrl || null,
            });
          }
        }
        if (flat.length >= 200) break;
      }
      return flat.sort((a, b) => a.stock - b.stock);
    };

    // Ưu tiên API (đã query toàn kho disk/Mongo, không phụ thuộc phân trang FE).
    // Client fallback chỉ khi computeDashboardStats / chưa có payload inventory.
    const base =
      Array.isArray(fromApi) && !usingFallback
        ? fromApi
        : fromApi && fromApi.length > 0
          ? fromApi
          : fromClient();

    return base
      .map((item) => ({
        ...item,
        imageUrl: item.imageUrl ?? resolveImage(item.id),
      }))
      .sort((a, b) => a.stock - b.stock);
  }, [data, products, lowStockThreshold, usingFallback, findProductRow]);

  // Đồng bộ draft input khi danh sách low-stock thay đổi.
  useEffect(() => {
    setStockDrafts((prev) => {
      const next: Record<string, string> = {};
      for (const item of lowStockProducts) {
        next[item.id] = prev[item.id] !== undefined ? prev[item.id] : String(item.stock);
      }
      return next;
    });
  }, [lowStockProducts]);

  const rtsFromOrders = useMemo(
    () => orders.filter((o) => isRtsOrder(o)).length,
    [orders],
  );
  const rtsCount =
    rtsCountApi ??
    (typeof rtsCountProp === 'number' && rtsCountProp > 0 ? rtsCountProp : null) ??
    (usingFallback ? Number(data?.pendingOrders.returnPending) || 0 : rtsFromOrders);

  const chartTotalRevenue = useMemo(
    () => (data?.chart || []).reduce((sum, day) => sum + (Number(day.amount) || 0), 0),
    [data?.chart],
  );
  const chartTotalProfit = useMemo(() => {
    const fromKpi = Number(data?.kpi?.profit);
    if (Number.isFinite(fromKpi)) return fromKpi;
    return (data?.chart || []).reduce((sum, day) => sum + (Number(day.profit) || 0), 0);
  }, [data?.kpi?.profit, data?.chart]);

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
        { key: 'returnPending', title: 'Giao không thành công (RTS)', count: rtsCount, icon: Undo2, color: 'text-purple-600', bg: 'bg-purple-50' },
      ]
    : [];
  const pendingCardTargetTab: Record<string, 'pending_confirm' | 'unprocessed' | 'processed' | 'shipping' | 'cancel_returns'> = {
    pendingApproval: 'pending_confirm',
    pendingPayment: 'pending_confirm',
    pendingPack: 'unprocessed',
    pendingPickup: 'processed',
    shipping: 'shipping',
    returnPending: 'cancel_returns',
  };

  const maxChart = Math.max(...(data?.chart.map((c) => c.amount) || [1]), 1);

  return (
    <div className="space-y-4" id="dashboard-tab">
      <div className="flex items-center justify-end gap-2">
        <Calendar className="w-4 h-4 text-gray-400 shrink-0" />
        <select
          value={dateRange}
          onChange={(e) => setDateRange(e.target.value as DashboardDateRange)}
          className="px-3 py-2 min-h-10 bg-white border border-gray-200 rounded-xl text-sm font-semibold text-gray-700 outline-none cursor-pointer focus:border-blue-400 w-full sm:w-auto sm:min-w-[160px]"
        >
          {DATE_RANGE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
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
                    onClick={() => {
                      if (card.key === 'returnPending') {
                        try {
                          sessionStorage.setItem('omni_cancel_tab', 'failed_delivery');
                        } catch {
                          /* ignore */
                        }
                      }
                      onTabChange?.('orders', {
                        ordersSubTab: pendingCardTargetTab[card.key],
                      });
                    }}
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

            <div className="flex items-end justify-between gap-2 sm:gap-3 h-64 border-b border-gray-100 pb-3 overflow-x-auto overflow-y-visible">
              {(data?.chart || []).map((day) => {
                const heightPct = (day.amount / maxChart) * 100;
                const barHeight = day.amount > 0 ? Math.max(heightPct, 8) : 4;
                return (
                  <div key={day.key} className="flex-1 min-w-[44px] flex flex-col items-center gap-1.5">
                    <span className="text-[9px] leading-tight font-bold text-gray-700 text-center whitespace-nowrap">
                      {formatVnd(day.amount)}
                    </span>
                    <span className="text-[9px] leading-tight font-bold text-green-600 text-center whitespace-nowrap">
                      {formatVnd(day.profit)}
                    </span>
                    <div className="w-full flex justify-center items-end h-44">
                      <div
                        className="w-full max-w-[40px] bg-blue-500 hover:bg-blue-600 rounded-t-lg transition-all duration-300"
                        style={{ height: `${barHeight}%` }}
                        title={`${day.label}: DT ${formatVnd(day.amount)} đ | LN ${formatVnd(day.profit)} đ`}
                      />
                    </div>
                    <span className="text-[10px] font-semibold text-gray-600 font-mono text-center">{day.label}</span>
                  </div>
                );
              })}
            </div>
            <p className="mt-4 text-center text-sm font-extrabold text-gray-900">
              Tổng doanh thu: {formatVnd(chartTotalRevenue)} đ
            </p>
            <p className="mt-1 text-center text-sm text-green-600 font-bold">
              Tổng lợi nhuận: {formatVnd(chartTotalProfit)} đ
            </p>
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

            <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-xs flex flex-col min-h-0">
              <h3 className="font-bold text-gray-900 text-base flex items-center gap-2 mb-1">
                <Warehouse className="w-5 h-5 text-indigo-500" />
                Thông Tin Kho
              </h3>
              <p className="text-[11px] text-gray-400 mb-4">
                Sản phẩm tồn &lt; {lowStockThreshold} cái — sửa số &amp; cập nhật thẳng lên sàn
              </p>

              <div className="max-h-72 overflow-y-auto rounded-xl border border-gray-100 divide-y divide-gray-50">
                {lowStockProducts.length === 0 ? (
                  <p className="text-sm text-gray-400 text-center py-10 px-4">
                    Không có sản phẩm nào dưới định mức
                  </p>
                ) : (
                  lowStockProducts.map((item) => {
                    const busy = updatingId === item.id;
                    return (
                      <div
                        key={item.id}
                        className="flex flex-col gap-2 px-3 py-2.5 hover:bg-rose-50/60 transition-colors"
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          {item.imageUrl ? (
                            <img
                              src={item.imageUrl}
                              alt=""
                              className="w-9 h-9 rounded-lg object-cover border border-gray-100 shrink-0"
                              referrerPolicy="no-referrer"
                            />
                          ) : (
                            <div
                              className="w-9 h-9 rounded-lg bg-gray-100 border border-gray-200 flex items-center justify-center shrink-0"
                              title="Không có ảnh"
                            >
                              <ImageOff className="w-3.5 h-3.5 text-gray-400" />
                            </div>
                          )}
                          <button
                            type="button"
                            onClick={() => onEditProductShortcut?.(item.id)}
                            className="flex-1 min-w-0 text-left"
                          >
                            <p className="text-[13px] font-medium text-gray-800 line-clamp-1 hover:text-rose-700">
                              {item.title}
                            </p>
                            <p className="text-[10px] font-mono text-gray-400 truncate">
                              {item.sku || '—'} · Tồn: {item.stock}
                            </p>
                          </button>
                        </div>

                        <div className="flex items-center gap-1.5 pl-[2.75rem] sm:pl-0 sm:justify-end">
                          <input
                            type="number"
                            min={0}
                            step={1}
                            disabled={busy}
                            value={stockDrafts[item.id] ?? String(item.stock)}
                            onChange={(e) =>
                              setStockDrafts((prev) => ({ ...prev, [item.id]: e.target.value }))
                            }
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') void handleInlineStockUpdate(item);
                            }}
                            className="w-20 shrink-0 border border-gray-200 rounded-lg px-2 py-1.5 text-sm font-semibold text-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400 disabled:opacity-60"
                            aria-label={`Số lượng mới cho ${item.sku || item.title}`}
                          />
                          <button
                            type="button"
                            disabled={busy}
                            title="Lưu tồn kho và đồng bộ lên sàn"
                            onClick={() => void handleInlineStockUpdate(item)}
                            className="inline-flex items-center justify-center gap-1 min-h-9 px-2.5 py-1.5 text-[11px] font-bold rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-60 transition-colors shrink-0"
                          >
                            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                            Cập nhật
                          </button>
                          <button
                            type="button"
                            title="Nhập hàng cho sản phẩm này"
                            disabled={busy}
                            onClick={() => onNavigateToImport?.(item.id)}
                            className="inline-flex items-center justify-center gap-1 min-h-9 px-2 py-1.5 text-[11px] font-semibold rounded-lg border border-gray-200 bg-white text-gray-600 hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-700 transition-all shrink-0"
                          >
                            <Truck className="w-3.5 h-3.5" />
                            Nhập
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </>
      ) : null}

      {toast ? (
        <div
          className={`fixed bottom-6 right-6 z-[90] max-w-sm px-4 py-3 rounded-xl shadow-lg border text-sm font-medium flex items-start gap-2 ${
            toast.ok
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-rose-50 border-rose-200 text-rose-800'
          }`}
          role="status"
        >
          {toast.ok ? (
            <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
          ) : (
            <XCircle className="w-4 h-4 mt-0.5 shrink-0" />
          )}
          <span>{toast.message}</span>
        </div>
      ) : null}
    </div>
  );
}
