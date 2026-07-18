import { Order, Product } from '../types';
import type { DashboardDateRange } from '../components/Dashboard';

export interface DashboardStats {
  dateRange: string;
  dateRangeLabel: string;
  startDate: string;
  endDate: string;
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

function buildChart(orders: Order[], rangeKey: DashboardDateRange, start: Date, end: Date) {
  const buckets = new Map<string, { key: string; label: string; amount: number }>();

  if (rangeKey === 'this_year' || rangeKey === 'this_quarter') {
    const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
    const endMonth = new Date(end.getFullYear(), end.getMonth(), 1);
    while (cursor <= endMonth) {
      const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`;
      buckets.set(key, { key, label: `T${cursor.getMonth() + 1}`, amount: 0 });
      cursor.setMonth(cursor.getMonth() + 1);
    }
  } else {
    const cursor = new Date(start);
    cursor.setHours(0, 0, 0, 0);
    const endDay = new Date(end);
    endDay.setHours(0, 0, 0, 0);
    while (cursor <= endDay) {
      const key = toDateKey(cursor);
      buckets.set(key, {
        key,
        label: `${String(cursor.getDate()).padStart(2, '0')}/${String(cursor.getMonth() + 1).padStart(2, '0')}`,
        amount: 0,
      });
      cursor.setDate(cursor.getDate() + 1);
    }
  }

  for (const order of orders) {
    const dateStr = String(order.date || '').split('T')[0];
    let bucketKey = dateStr;
    if (rangeKey === 'this_year' || rangeKey === 'this_quarter') {
      const d = parseOrderDate(dateStr);
      bucketKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }
    const bucket = buckets.get(bucketKey);
    if (bucket) bucket.amount += Number(order.totalAmount) || 0;
  }

  return Array.from(buckets.values());
}

export function computeDashboardStats(
  orders: Order[],
  products: Product[],
  rangeKey: DashboardDateRange
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

  return {
    dateRange: rangeKey,
    dateRangeLabel: RANGE_LABELS[rangeKey],
    startDate: toDateKey(start),
    endDate: toDateKey(end),
    kpi: {
      revenue: revenueOrders.reduce((s, o) => s + (Number(o.totalAmount) || 0), 0),
      newOrders: inRange.filter((o) => o.status === 'pending_verification' || o.status === 'pending_confirm' || o.status === 'unprocessed').length,
      returns: inRange.filter((o) => o.status === 'return_pending' || o.status === 'return_received').length,
      cancelled: inRange.filter((o) => o.status === 'cancelled').length,
    },
    pendingOrders: {
      pendingApproval: eligible.filter((o) => o.status === 'pending_verification' || o.status === 'pending_confirm').length,
      pendingPayment: eligible.filter((o) => o.status === 'pending_confirm' && o.channel === 'manual').length,
      pendingPack: eligible.filter((o) => o.status === 'unprocessed' && !o.isPrepared).length,
      pendingPickup: eligible.filter(
        (o) => (o.status === 'unprocessed' && o.isPrepared) || o.status === 'processed'
      ).length,
      shipping: eligible.filter((o) => o.status === 'shipping').length,
      returnPending: eligible.filter((o) => o.status === 'return_pending').length,
    },
    chart: buildChart(revenueOrders, rangeKey, start, end),
    topProducts,
    inventory: {
      lowStockThreshold: LOW,
      lowStockProducts,
    },
  };
}
