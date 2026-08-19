import { Order, Product, SystemFee } from '../types';
import type { DashboardDateRange } from '../components/Dashboard';
import { calculateProfitWithSystemFees } from './profitCalculator';
import { getOrderTotalImportCost } from './orderImportCost';
import {
  matchesProcessedPickupTab,
  matchesShippingTab,
  matchesUnprocessedPickupTab,
} from './orderHandover';

export interface DashboardStats {
  dateRange: string;
  dateRangeLabel: string;
  startDate: string;
  endDate: string;
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
    lowStockProducts: { id: string; title: string; sku: string; stock: number }[];
  };
}

const RANGE_LABELS: Record<DashboardDateRange, string> = {
  today: 'Hôm nay',
  last_7_days: '7 ngày qua',
  this_month: 'Tháng này',
  last_month: 'Tháng trước',
  this_quarter: 'Quý này',
  this_year: 'Năm nay',
};

/** Khớp OrderManager tab failed_delivery: is_rts / RTS / failed_delivery. */
export function isRtsOrder(order: Order): boolean {
  if (order.is_rts === true) return true;
  if (order.shopee_cancel_return_kind === 'failed_delivery') return true;
  return String(order.sub_status || '').toUpperCase() === 'RTS';
}

/** Khớp isPendingConfirmOrder (OrderManager) — dùng chung cho ô Chờ duyệt. */
function isPendingConfirmOrder(order: Order): boolean {
  const raw = String(order.shopee_order_status || '').toUpperCase();
  if (
    raw === 'READY_TO_SHIP' ||
    raw === 'RETRY_SHIP' ||
    raw === 'PROCESSED' ||
    raw === 'SHIPPED' ||
    raw === 'TO_CONFIRM_RECEIVE' ||
    raw === 'COMPLETED' ||
    raw === 'CANCELLED' ||
    raw === 'IN_CANCEL' ||
    raw === 'TO_RETURN'
  ) {
    return false;
  }
  if (
    order.status === 'unprocessed' ||
    order.status === 'processed' ||
    order.status === 'shipping' ||
    order.status === 'completed' ||
    order.status === 'cancelled' ||
    order.status === 'return_pending' ||
    order.status === 'return_received'
  ) {
    return false;
  }
  if (matchesProcessedPickupTab(order) || matchesUnprocessedPickupTab(order)) return false;
  if (order.status === 'pending_confirm' || order.status === 'pending_verification') return true;
  return (
    raw === 'UNPAID' ||
    raw === 'PENDING' ||
    raw === 'IN_REVIEW' ||
    raw === 'FRAUD_CHECK' ||
    raw === 'INVOICE_PENDING'
  );
}

function toDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseOrderDate(dateStr: string): Date {
  const raw = String(dateStr || '').trim();
  if (!raw) return new Date(NaN);
  const datePart = raw.split('T')[0];
  const [y, m, d] = datePart.split('-').map(Number);
  if (!y || !m || !d) return new Date(NaN);
  return new Date(y, m - 1, d);
}

function getDateRange(rangeKey: DashboardDateRange) {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);

  switch (rangeKey) {
    case 'today': {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      return { start, end };
    }
    case 'this_month':
      return { start: new Date(y, m, 1), end };
    case 'last_month':
      return {
        start: new Date(y, m - 1, 1),
        end: new Date(y, m, 0, 23, 59, 59, 999),
      };
    case 'this_quarter': {
      const qStart = Math.floor(m / 3) * 3;
      return { start: new Date(y, qStart, 1), end };
    }
    case 'this_year':
      return { start: new Date(y, 0, 1), end };
    case 'last_7_days':
    default: {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      start.setDate(start.getDate() - 6);
      return { start, end };
    }
  }
}

function isDateInRange(dateStr: string, start: Date, end: Date): boolean {
  const d = parseOrderDate(dateStr);
  if (Number.isNaN(d.getTime())) return false;
  const s = new Date(start);
  s.setHours(0, 0, 0, 0);
  const e = new Date(end);
  e.setHours(23, 59, 59, 999);
  return d >= s && d <= e;
}

function isDashboardOrder(order: Order): boolean {
  const sn = String(order.orderSn || order.id || '');
  if (!sn) return false;
  const hasAmount = Number(order.totalAmount) > 0;
  const hasItems = Array.isArray(order.items) && order.items.length > 0;
  if (!hasAmount && !hasItems && sn.startsWith('260709')) return false;
  return true;
}

function buildChart(
  orders: Order[],
  products: Product[],
  systemFees: SystemFee[],
  rangeKey: DashboardDateRange,
  start: Date,
  end: Date,
) {
  const buckets = new Map<string, { key: string; label: string; amount: number; profit: number }>();

  if (rangeKey === 'this_year' || rangeKey === 'this_quarter') {
    const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
    const endMonth = new Date(end.getFullYear(), end.getMonth(), 1);
    let monthGuard = 0;
    while (cursor <= endMonth) {
      if (monthGuard++ >= 24) break;
      const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`;
      buckets.set(key, { key, label: `T${cursor.getMonth() + 1}`, amount: 0, profit: 0 });
      cursor.setMonth(cursor.getMonth() + 1);
    }
  } else {
    const cursor = new Date(start);
    cursor.setHours(0, 0, 0, 0);
    const endDay = new Date(end);
    endDay.setHours(0, 0, 0, 0);
    let dayGuard = 0;
    while (cursor <= endDay) {
      if (dayGuard++ >= 400) break;
      const key = toDateKey(cursor);
      buckets.set(key, {
        key,
        label: `${String(cursor.getDate()).padStart(2, '0')}/${String(cursor.getMonth() + 1).padStart(2, '0')}`,
        amount: 0,
        profit: 0,
      });
      cursor.setDate(cursor.getDate() + 1);
    }
  }

  for (let i = 0; i < Math.min(orders.length, 50000); i++) {
    const order = orders[i];
    const dateStr = String(order.date || '').split('T')[0];
    let bucketKey = dateStr;
    if (rangeKey === 'this_year' || rangeKey === 'this_quarter') {
      const d = parseOrderDate(dateStr);
      bucketKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }
    const bucket = buckets.get(bucketKey);
    if (bucket) {
      const amount = Number(order.totalAmount) || 0;
      const importCost = getOrderTotalImportCost(order, products);
      bucket.amount += amount;
      bucket.profit += calculateProfitWithSystemFees(amount, importCost, systemFees);
    }
  }

  return Array.from(buckets.values());
}

export function computeDashboardStats(
  orders: Order[],
  products: Product[],
  rangeKey: DashboardDateRange,
  systemFees: SystemFee[] = [],
): DashboardStats {
  const { start, end } = getDateRange(rangeKey);
  const eligible = orders.filter(isDashboardOrder);
  const inRange = eligible.filter((o) => isDateInRange(String(o.date || ''), start, end));
  const revenueOrders = inRange.filter(
    (o) => o.status !== 'cancelled' && Number(o.totalAmount) > 0
  );

  const productSales = new Map<string, number>();
  for (const order of revenueOrders) {
    for (const item of order.items || []) {
      const pid = String(item.productId || '');
      if (!pid) continue;
      productSales.set(pid, (productSales.get(pid) || 0) + Math.max(0, Number(item.quantity) || 0));
    }
  }

  const topProducts = Array.from(productSales.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([productId, quantitySold], idx) => {
      const prod = products.find((p) => p.id === productId);
      let title = prod?.title;
      let imageUrl = prod?.avatarUrl || prod?.imageUrl || null;
      if (!title) {
        for (const order of revenueOrders) {
          const hit = order.items?.find((i) => String(i.productId) === productId);
          if (hit?.productTitle) {
            title = hit.productTitle;
            imageUrl = imageUrl || hit.productImage || null;
            break;
          }
        }
      }
      return {
        rank: idx + 1,
        productId,
        title: title || productId,
        sku: prod?.sku || '—',
        imageUrl: imageUrl || null,
        quantitySold,
      };
    });

  const LOW = 5;
  const lowStockProducts = products
    .filter((p) => (Number(p.stock) || 0) < LOW)
    .map((p) => ({
      id: p.id,
      title: p.title || p.sku || p.id,
      sku: p.sku || '',
      stock: Number(p.stock) || 0,
    }))
    .sort((a, b) => a.stock - b.stock);

  const chart = buildChart(revenueOrders, products, systemFees, rangeKey, start, end);
  const totalProfit = chart.reduce((sum, day) => sum + (Number(day.profit) || 0), 0);

  return {
    dateRange: rangeKey,
    dateRangeLabel: RANGE_LABELS[rangeKey],
    startDate: toDateKey(start),
    endDate: toDateKey(end),
    kpi: {
      revenue: revenueOrders.reduce((s, o) => s + (Number(o.totalAmount) || 0), 0),
      profit: totalProfit,
      newOrders: inRange.filter((o) => o.status === 'pending_verification' || o.status === 'pending_confirm' || o.status === 'unprocessed').length,
      returns: inRange.filter((o) => o.status === 'return_pending' || o.status === 'return_received').length,
      cancelled: inRange.filter((o) => o.status === 'cancelled').length,
    },
    pendingOrders: {
      // Cùng matcher với OrderManager / GET /api/orders?tab=…
      pendingApproval: eligible.filter((o) => isPendingConfirmOrder(o)).length,
      pendingPayment: eligible.filter((o) => isPendingConfirmOrder(o) && o.channel === 'manual').length,
      pendingPack: eligible.filter(
        (o) => matchesUnprocessedPickupTab(o) && !isPendingConfirmOrder(o),
      ).length,
      pendingPickup: eligible.filter(
        (o) => matchesProcessedPickupTab(o) && !isPendingConfirmOrder(o),
      ).length,
      // Cùng matchesShippingTab với OrderManager — loại COMPLETED/CANCELLED/TO_RETURN/RTS.
      shipping: eligible.filter((o) => matchesShippingTab(o)).length,
      returnPending: eligible.filter((o) => isRtsOrder(o)).length,
    },
    chart,
    topProducts,
    inventory: {
      lowStockThreshold: LOW,
      lowStockProducts,
    },
  };
}
