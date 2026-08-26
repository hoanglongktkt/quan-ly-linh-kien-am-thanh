import {
  toDateKey,
  getDashboardDateRange,
  buildDashboardChart,
} from "../utils/dashboard.js";

/** Deps Mongo từ server.ts / mongoStore. */
let deps = {
  isMongoReady: () => false,
  withLocalDbTimeout: async (promise) => promise,
  getDashboardStatsFromStore: async () => ({
    totalOrdersInDb: 0,
    dashboardOrdersCount: 0,
    ordersInRangeCount: 0,
    revenue: 0,
    profit: 0,
    newOrders: 0,
    returns: 0,
    cancelled: 0,
    pendingOrders: {},
    dailyRevenue: [],
    topProducts: [],
  }),
  getLowStockProductsFromStore: async () => [],
  loadProductsByIdsFromStore: async () => [],
  loadChannelSettings: () => ({ systemFees: [] }),
};

export function initDashboardController(partial) {
  deps = { ...deps, ...partial };
}

/** GET /api/dashboard */
export async function getDashboard(req, res) {
  try {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    const dateRange = String(req.query.date_range || "last_7_days");
    const range = getDashboardDateRange(dateRange);
    const startKey = toDateKey(range.start);
    const endKey = toDateKey(range.end);

    const LOW_STOCK_THRESHOLD = 5;

    if (!deps.isMongoReady()) {
      // Kho gốc có thể đang disk — vẫn trả low-stock dù Mongo orders chưa sẵn.
      let lowStockProducts = [];
      try {
        const lowStockRows = await deps.withLocalDbTimeout(
          deps.getLowStockProductsFromStore(LOW_STOCK_THRESHOLD, 50),
          8000,
          "dashboard_low_stock",
        );
        lowStockProducts = (Array.isArray(lowStockRows) ? lowStockRows : []).map((p) => ({
          id: p.id,
          title: p.title || p.sku || p.id,
          sku: p.sku,
          stock: p.stock,
          imageUrl: p.image || null,
        }));
      } catch (err) {
        console.warn("[Dashboard API] low-stock (mongo not ready):", err?.message || err);
      }
      return res.status(200).json({
        dateRange: range.key,
        dateRangeLabel: range.label,
        startDate: startKey,
        endDate: endKey,
        meta: { totalOrdersInDb: 0, dashboardOrders: 0, ordersInRange: 0 },
        kpi: { revenue: 0, profit: 0, newOrders: 0, returns: 0, cancelled: 0 },
        pendingOrders: {
          pendingApproval: 0,
          pendingPayment: 0,
          pendingPack: 0,
          pendingPickup: 0,
          shipping: 0,
          returnPending: 0,
        },
        chart: [],
        topProducts: [],
        inventory: { lowStockThreshold: LOW_STOCK_THRESHOLD, lowStockProducts },
        message: "mongodb_not_ready",
      });
    }

    const channelSettings = deps.loadChannelSettings() || {};
    const systemFees = Array.isArray(channelSettings.systemFees) ? channelSettings.systemFees : [];

    const [stats, lowStockRows] = await Promise.all([
      deps.withLocalDbTimeout(deps.getDashboardStatsFromStore(startKey, endKey, systemFees), 8000, "dashboard_stats"),
      deps.withLocalDbTimeout(
        deps.getLowStockProductsFromStore(LOW_STOCK_THRESHOLD, 50),
        8000,
        "dashboard_low_stock",
      ),
    ]);

    const wantedProductIds = stats.topProducts.map((p) => p.productId).filter(Boolean);
    const topProductDocs = wantedProductIds.length
      ? await deps.withLocalDbTimeout(
          deps.loadProductsByIdsFromStore(wantedProductIds, []),
          8000,
          "dashboard_top_products",
        )
      : [];

    const topProducts = stats.topProducts.map((entry, idx) => {
      const prod = topProductDocs.find((p) => p.id === entry.productId);
      return {
        rank: idx + 1,
        productId: entry.productId,
        title: prod?.title || entry.title || entry.productId,
        sku: prod?.sku || "—",
        imageUrl: prod?.avatarUrl || prod?.imageUrl || entry.image || null,
        quantitySold: entry.quantitySold,
      };
    });

    const lowStockProducts = lowStockRows.map((p) => ({
      id: p.id,
      title: p.title || p.sku || p.id,
      sku: p.sku,
      stock: p.stock,
      imageUrl: p.image || null,
    }));

    const chart = buildDashboardChart(stats.dailyRevenue, range);

    return res.json({
      dateRange: range.key,
      dateRangeLabel: range.label,
      startDate: startKey,
      endDate: endKey,
      meta: {
        totalOrdersInDb: stats.totalOrdersInDb,
        dashboardOrders: stats.dashboardOrdersCount,
        ordersInRange: stats.ordersInRangeCount,
      },
      kpi: {
        revenue: stats.revenue,
        profit: Number.isFinite(Number(stats.profit)) ? Number(stats.profit) : 0,
        newOrders: stats.newOrders,
        returns: stats.returns,
        cancelled: stats.cancelled,
      },
      pendingOrders: stats.pendingOrders,
      chart,
      topProducts,
      inventory: {
        lowStockThreshold: LOW_STOCK_THRESHOLD,
        lowStockProducts,
      },
    });
  } catch (error) {
    console.error("[Dashboard API] Error:", error);
    return res.status(500).json({
      error: "dashboard_query_failed",
      message: error?.message || "Không thể tải dữ liệu dashboard.",
    });
  }
}
