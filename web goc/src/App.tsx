import React, { useState, useEffect, useRef } from 'react';
import { Product, Expense, Order, ChannelSettings, SyncLog, Supplier, ImportTransaction, BulkUpdatePayload, BulkSaveProductUpdate, ConnectedShop, getProductChildren } from './types';
import { 
  INITIAL_SYNC_LOGS,
} from './data';
import Dashboard from './components/Dashboard';
import ProductList from './components/ProductList';
import InventoryAudit from './components/InventoryAudit';
import BulkEditor from './components/BulkEditor';
import Financials from './components/Financials';
import SettingsView from './components/Settings';
import SupplierManager from './components/SupplierManager';
import ImportManager from './components/ImportManager';
import OrderManager from './components/OrderManager';
import OrderPicking from './components/OrderPicking';
import PublishManager from './components/PublishManager';
import LoginPage from './components/LoginPage';
import ErrorBoundary from './components/ErrorBoundary';
import BrandLogo, { BrandHeader } from './components/BrandLogo';
import { APP_TITLE } from './config/brand';
import { CATALOG_PURGE_FLAG, purgeLegacyCatalogCache } from './utils/catalogStorage';
import { sanitizeOrders } from './utils/sanitizeOrder';
import { safeGetItem, safeGetJson, safeRemoveItem, safeSetItem } from './utils/safeStorage';
import { parseJsonResponse } from './utils/apiClient';
import { clearLegacyOrdersLocalStorage, clearOrdersCache, saveOrdersCache } from './utils/orderCache';
import { 
  LayoutDashboard, 
  Package, 
  Sparkles, 
  Coins, 
  Settings, 
  HelpCircle,
  RefreshCw,
  ShoppingBag,
  Users,
  ArrowDownToLine,
  ClipboardList,
  Globe,
  LogOut,
  Barcode,
  Menu,
  X,
  ScanLine,
  ShoppingBasket,
  Scale,
  PackageCheck,
} from 'lucide-react';
import type { OrdersSubTabId } from './components/OrderManager';

const MAIN_NAV_TABS = new Set([
  'dashboard',
  'products',
  'publish',
  'orders',
  'picking',
  'bulk',
  'suppliers',
  'imports',
  'financials',
  'settings',
]);

const ORDERS_SUB_TAB_IDS = new Set<string>([
  'all',
  'pending_verification',
  'pending_confirm',
  'unprocessed',
  'processed',
  'handed_over_carrier',
  'shipping',
  'cancel_returns',
  'received_cancel_returns',
  'order_products',
]);

/** Alias URL thân thiện → id tab nội bộ (vd: ?tab=da-giao-dvvc). */
const ORDERS_SUB_TAB_ALIASES: Record<string, OrdersSubTabId> = {
  'da-giao-dvvc': 'handed_over_carrier',
  'handed_over_carrier': 'handed_over_carrier',
  'cho-xac-nhan': 'pending_confirm',
  'cho-lay-hang': 'unprocessed',
  'da-xu-ly': 'processed',
  'dang-giao': 'shipping',
  'don-huy-hoan': 'cancel_returns',
  'da-nhan-huy-hoan': 'received_cancel_returns',
};

function normalizeOrdersSubTab(raw: string | null | undefined): OrdersSubTabId | null {
  if (!raw) return null;
  const key = String(raw).trim();
  if (!key) return null;
  if (ORDERS_SUB_TAB_ALIASES[key]) return ORDERS_SUB_TAB_ALIASES[key];
  if (key === 'pending_verification') return 'pending_confirm';
  if (ORDERS_SUB_TAB_IDS.has(key)) return key as OrdersSubTabId;
  return null;
}

function readSessionTab(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSessionTab(key: string, value: string) {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

function resolveOrdersSubTabFromUrl(): OrdersSubTabId | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const fromQuery =
    normalizeOrdersSubTab(params.get('ordersTab')) ||
    normalizeOrdersSubTab(params.get('subtab')) ||
    normalizeOrdersSubTab(params.get('tab'));
  if (fromQuery) return fromQuery;
  return normalizeOrdersSubTab(readSessionTab('omni_orders_subtab'));
}

function resolveTabFromPath(): string {
  if (typeof window === 'undefined') return 'dashboard';
  const path = window.location.pathname.replace(/\/$/, '') || '/';
  if (path === '/picking') return 'picking';

  const params = new URLSearchParams(window.location.search);
  const qTab = params.get('tab');
  // ?tab=da-giao-dvvc (alias sub-tab) → mở màn Quản lý đơn
  if (qTab && normalizeOrdersSubTab(qTab) && !MAIN_NAV_TABS.has(qTab)) {
    return 'orders';
  }
  if (qTab && MAIN_NAV_TABS.has(qTab)) return qTab;
  if (params.get('ordersTab') || params.get('subtab')) return 'orders';

  const stored = readSessionTab('omni_active_tab');
  if (stored && MAIN_NAV_TABS.has(stored)) return stored;

  return 'dashboard';
}

function buildNavUrl(tab: string, ordersSubTab?: string | null): string {
  if (tab === 'picking') return '/picking';
  const params = new URLSearchParams();
  params.set('tab', tab);
  if (tab === 'orders' && ordersSubTab) {
    params.set('ordersTab', ordersSubTab);
  }
  const qs = params.toString();
  return qs ? `/?${qs}` : '/';
}

const DEMO_SHOP_INTERNAL_IDS = new Set(['shop-shopee-1', 'shop-shopee-2', 'shop-tiktok-1', 'shop-woo-1']);

/** Chỉ lọc shop seed demo cũ — không lọc theo shopId thật (VD: 4127421). */
function stripLegacyDemoShops(shops: ConnectedShop[] = []) {
  return shops.filter((s) => {
    if (DEMO_SHOP_INTERNAL_IDS.has(s.id)) return false;
    if (s.shopName === 'LTAT' || s.shopName.includes('thongtinsolutions')) return false;
    if (s.wooUrl?.includes('thongtinsolutions.com')) return false;
    if (s.apiKey?.includes('demo')) return false;
    return true;
  });
}

function mergeChannelSettings(raw: Partial<ChannelSettings> | null | undefined): ChannelSettings {
  return {
    ...emptyChannelSettings(),
    ...raw,
    shops: Array.isArray(raw?.shops) ? raw.shops : [],
  };
}

function emptyChannelSettings(): ChannelSettings {
  return {
    shopeeConnected: false,
    shopeeShopId: '',
    shopeeApiKey: '',
    tiktokConnected: false,
    tiktokShopId: '',
    tiktokApiKey: '',
    shopeeDefaultFeeRate: 12,
    packagingCostPerOrder: 0,
    shops: [],
  };
}

function mergeShopLists(primary: ConnectedShop[] = [], secondary: ConnectedShop[] = []): ConnectedShop[] {
  const map = new Map<string, ConnectedShop>();
  for (const s of primary) {
    map.set(`${s.platform}:${String(s.shopId)}`, s);
  }
  for (const s of secondary) {
    const key = `${s.platform}:${String(s.shopId)}`;
    if (!map.has(key)) map.set(key, s);
  }
  return [...map.values()];
}

export default function App() {
  // Authentication States
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [adminUser, setAdminUser] = useState<string>('');
  const [authChecking, setAuthChecking] = useState<boolean>(true);

  // 1. Initialize State — chỉ lấy live data từ Database.
  const [products, setProducts] = useState<Product[]>([]);
  const [productsMeta, setProductsMeta] = useState({
    page: 1,
    pageSize: 50,
    total: 0,
    totalPages: 1,
    hasMore: false,
  });

  const [expenses, setExpenses] = useState<Expense[]>([]);

  const [orders, setOrders] = useState<Order[]>([]);
  const [ordersLoading, setOrdersLoading] = useState<boolean>(false);
  const [productsLoading, setProductsLoading] = useState<boolean>(false);
  /** Làm mới ngầm khi quay lại tab trình duyệt — không trigger Shopee sync. */
  const [backgroundRefreshing, setBackgroundRefreshing] = useState(false);
  const lastFocusRefreshAtRef = useRef(0);

  const [logs, setLogs] = useState<SyncLog[]>(() =>
    safeGetJson('omni_logs', INITIAL_SYNC_LOGS),
  );

  const [settings, setSettings] = useState<ChannelSettings>(() => {
    const saved = safeGetJson<ChannelSettings | null>('omni_settings', null);
    if (!saved) return emptyChannelSettings();
    try {
      return mergeChannelSettings({
        ...saved,
        shops: stripLegacyDemoShops(saved.shops ?? []),
      });
    } catch {
      return emptyChannelSettings();
    }
  });

  const channelSettingsFetchRef = useRef<AbortController | null>(null);
  const channelSettingsSaveAtRef = useRef(0);

  const [suppliers, setSuppliers] = useState<Supplier[]>([]);

  const [imports, setImports] = useState<ImportTransaction[]>([]);

  const [highlightProductId, setHighlightProductId] = useState<string | null>(null);
  const [importPrefillProductId, setImportPrefillProductId] = useState<string | null>(null);

  // Active navigation tab — khôi phục từ URL (?tab=) hoặc sessionStorage khi F5
  const [activeTab, setActiveTab] = useState(() => resolveTabFromPath());
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [focusScanner, setFocusScanner] = useState<boolean>(false);
  const [ordersSubTabHint, setOrdersSubTabHint] = useState<OrdersSubTabId | null>(() =>
    resolveOrdersSubTabFromUrl(),
  );
  // Mobile: tab 'products' có 2 màn — Kiểm hàng (audit) và Danh sách sản phẩm (list).
  const [mobileProductsView, setMobileProductsView] = useState<'audit' | 'list'>('audit');
  
  // Selected products for bulk editing
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  useEffect(() => {
    const onPopState = () => {
      const nextTab = resolveTabFromPath();
      setActiveTab(nextTab);
      setOrdersSubTabHint(nextTab === 'orders' ? resolveOrdersSubTabFromUrl() : null);
      setFocusScanner(false);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // Chuẩn hóa URL khi F5 vào tab đã lưu (vd: ?tab=da-giao-dvvc → ?tab=orders&ordersTab=handed_over_carrier)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const path = window.location.pathname.replace(/\/$/, '') || '/';
    if (path === '/picking') {
      writeSessionTab('omni_active_tab', 'picking');
      return;
    }
    const sub = activeTab === 'orders' ? ordersSubTabHint || resolveOrdersSubTabFromUrl() : null;
    const nextUrl = buildNavUrl(activeTab, sub);
    const cur = `${window.location.pathname}${window.location.search}`;
    if (cur !== nextUrl) {
      window.history.replaceState({ tab: activeTab, ordersTab: sub }, '', nextUrl);
    }
    writeSessionTab('omni_active_tab', activeTab);
    if (sub) writeSessionTab('omni_orders_subtab', sub);
  }, []);

  // Đơn hàng: RAM (React state) + IndexedDB cache — không dùng localStorage.
  useEffect(() => {
    clearLegacyOrdersLocalStorage();
  }, []);

  useEffect(() => {
    const trimmed = logs.length > 200 ? logs.slice(-200) : logs;
    safeSetItem('omni_logs', JSON.stringify(trimmed));
  }, [logs]);

  useEffect(() => {
    safeSetItem('omni_settings', JSON.stringify(settings));
  }, [settings]);

  // Token Verification on Mount
  useEffect(() => {
    const verifyToken = async () => {
      const token = localStorage.getItem('admin_token');
      if (!token) {
        setIsAuthenticated(false);
        setAuthChecking(false);
        return;
      }

      try {
        const response = await fetch('/api/auth/verify', {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${token}`,
          },
        });

        if (response.ok) {
          const data = await response.json();
          setIsAuthenticated(true);
          setAdminUser(data.username);
        } else {
          safeRemoveItem('admin_token');
          setIsAuthenticated(false);
        }
      } catch (err) {
        console.error("Auth verification error:", err);
        safeRemoveItem('admin_token');
        setIsAuthenticated(false);
      } finally {
        setAuthChecking(false);
      }
    };

    verifyToken();
  }, []);

  // Fetch the real, backend-synced order list (Shopee webhook data) once authenticated.
  const fetchOrders = async (opts?: { silent?: boolean; bustCache?: boolean }) => {
    const token = localStorage.getItem('admin_token');
    if (!token) return;

    const silent = Boolean(opts?.silent);
    const bustCache = opts?.bustCache !== false;
    if (!silent) setOrdersLoading(true);
    try {
      // Cache bust: timestamp + cache:no-store — tránh trình duyệt trả danh sách cũ (GHN kẹt tab).
      const path = bustCache ? `/api/orders?t=${Date.now()}` : '/api/orders';
      const requestUrl =
        path.startsWith('http://') || path.startsWith('https://')
          ? path
          : `${window.location.origin}${path}`;
      if (
        typeof window !== 'undefined' &&
        /quanly\.linhkienamthanh\.net|linhkienamthanh\.net|vercel\.app/i.test(window.location.hostname)
      ) {
        console.warn(
          '⚠️ Đang mở PRODUCTION/REMOTE — /api/orders sẽ lấy data server thật, không phải DB local đã xóa. Dùng http://localhost:3000 để test purge local.',
        );
      }
      const response = await fetch(path, {
        method: 'GET',
        cache: 'no-store',
        headers: {
          Authorization: `Bearer ${token}`,
          'Cache-Control': 'no-cache',
          Pragma: 'no-cache',
        },
      });
      if (response.ok) {
        const data: Order[] = await response.json();
        console.log('🛑 DATA ĐƯỢC LẤY TỪ URL:', requestUrl, '- SỐ LƯỢNG:', Array.isArray(data) ? data.length : 0);
        const sanitized = sanitizeOrders(data);
        setOrders(sanitized);
        if (sanitized.length === 0) {
          void clearOrdersCache();
        } else {
          void saveOrdersCache(sanitized);
        }
      } else {
        console.log('🛑 DATA ĐƯỢC LẤY TỪ URL:', requestUrl, '- SỐ LƯỢNG: (HTTP', response.status, ')');
      }
    } catch (err) {
      console.error("Fetch orders error:", err);
    } finally {
      if (!silent) setOrdersLoading(false);
    }
  };

  useEffect(() => {
    // Chỉ dọn key legacy — không xóa persistence inventory mới.
    purgeLegacyCatalogCache();
  }, []);

  const fetchProducts = async (opts?: {
    page?: number;
    append?: boolean;
    pageSize?: number;
    forceRefresh?: boolean;
    silent?: boolean;
  }) => {
    const token = localStorage.getItem('admin_token');
    if (!token) return;

    const forceRefresh = !!opts?.forceRefresh;
    const page = Math.max(1, opts?.page ?? 1);
    const pageSize = Math.min(50, Math.max(1, opts?.pageSize ?? 50));
    const append = !!opts?.append;
    const silent = Boolean(opts?.silent);

    if (!silent) setProductsLoading(true);
    try {
      // Chỉ đọc trực tiếp DB Kho gốc, cấm fallback dữ liệu cũ.
      const response = await fetch(`/api/products?page=${page}&pageSize=${pageSize}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error('Không thể đọc dữ liệu Kho gốc từ Database.');

      const data = await response.json();
      if (Array.isArray(data)) {
        setProducts(data);
        setProductsMeta({ page: 1, pageSize: data.length, total: data.length, totalPages: 1, hasMore: false });
        return;
      }
      const list: Product[] = Array.isArray(data.products) ? data.products : [];
      setProducts((prev) => (append ? [...prev, ...list] : list));
      setProductsMeta({
        page: Number(data.page) || page,
        pageSize: Number(data.pageSize) || pageSize,
        total: Number(data.total) || list.length,
        totalPages: Number(data.totalPages) || 1,
        hasMore: !!data.hasMore,
      });
    } catch (err) {
      console.error('Fetch products error:', err);
      setProducts([]);
      setProductsMeta({ page: 1, pageSize, total: 0, totalPages: 1, hasMore: false });
    } finally {
      if (!silent) setProductsLoading(false);
    }
  };

  // Quay lại tab trình duyệt → làm mới danh sách từ DB nội bộ (KHÔNG gọi Shopee sync).
  useEffect(() => {
    if (!isAuthenticated) return;

    const FOCUS_REFRESH_COOLDOWN_MS = 12_000;

    const refreshFromLocalDb = async () => {
      if (document.visibilityState === 'hidden') return;
      const now = Date.now();
      if (now - lastFocusRefreshAtRef.current < FOCUS_REFRESH_COOLDOWN_MS) return;
      lastFocusRefreshAtRef.current = now;

      setBackgroundRefreshing(true);
      try {
        await fetchOrders({ silent: true });
        if (
          activeTab === 'products' ||
          activeTab === 'dashboard' ||
          activeTab === 'picking' ||
          activeTab === 'publish'
        ) {
          await fetchProducts({ page: 1, append: false, pageSize: 50, silent: true });
        }
      } finally {
        setBackgroundRefreshing(false);
      }
    };

    const onFocus = () => {
      void refreshFromLocalDb();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void refreshFromLocalDb();
    };

    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [isAuthenticated, activeTab]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const linked = params.get('shopee_linked');
    const oauthShopId = String(params.get('shop_id') || '').trim();
    const expectedShop = String(params.get('expected_shop') || '').trim();
    const savedShops = String(params.get('saved_shops') || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (linked === '0') {
      const err = params.get('error') || 'OAuth thất bại';
      alert(decodeURIComponent(err));
      window.history.replaceState({}, '', window.location.pathname + window.location.hash);
      return;
    }

    if (linked !== '1' || !oauthShopId) return;

    if (expectedShop && expectedShop !== oauthShopId) {
      alert(
        `Cảnh báo: Bạn yêu cầu OAuth shop ${expectedShop} nhưng Shopee trả về shop ${oauthShopId}.\n` +
          'Token đã lưu trên máy chủ — hãy kiểm tra Shop ID trong Cài đặt có khớp không.',
      );
      window.history.replaceState({}, '', window.location.pathname + window.location.hash);
      return;
    }

    alert(`OAuth Shopee thành công. Shop ID: ${oauthShopId}${savedShops.length ? ` (đã lưu: ${savedShops.join(', ')})` : ''}`);
    window.history.replaceState({}, '', window.location.pathname + window.location.hash);
  }, []);

  const apiAuthHeaders = (): Record<string, string> => {
    const token = localStorage.getItem('admin_token');
    return {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  };

  const persistChannelSettings = async (next: ChannelSettings): Promise<boolean> => {
    const token = localStorage.getItem('admin_token');
    if (!token) return false;
    channelSettingsFetchRef.current?.abort();
    const expectedShopIds = (next.shops ?? []).map((s) => String(s.shopId));
    try {
      const response = await fetch('/api/settings/channels', {
        method: 'PUT',
        headers: apiAuthHeaders(),
        body: JSON.stringify({ settings: next }),
      });
      const data = await parseJsonResponse<{ settings?: ChannelSettings; message?: string; error?: string; shopCount?: number }>(response);
      if (response.ok && data?.settings) {
        const merged = mergeChannelSettings(data.settings);
        const returnedIds = (merged.shops ?? []).map((s) => String(s.shopId));
        const missing = expectedShopIds.filter((id) => !returnedIds.includes(id));
        if (missing.length > 0) {
          console.error('[Channel Settings] Server thiếu shop sau khi lưu:', missing);
          return false;
        }
        channelSettingsSaveAtRef.current = Date.now();
        setSettings(merged);
        return true;
      }
      console.error('[Channel Settings] PUT failed:', data?.error || data?.message);
      return false;
    } catch (err) {
      console.error('[Channel Settings] PUT error:', err);
      return false;
    }
  };

  const fetchChannelSettings = async () => {
    const token = localStorage.getItem('admin_token');
    if (!token) return;
    channelSettingsFetchRef.current?.abort();
    const controller = new AbortController();
    channelSettingsFetchRef.current = controller;
    const fetchStartedAt = Date.now();
    try {
      const response = await fetch('/api/settings/channels', {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (channelSettingsSaveAtRef.current > fetchStartedAt) return;
      if (!response.ok) return;
      const data = await parseJsonResponse<{ settings?: ChannelSettings }>(response);
      if (controller.signal.aborted) return;
      if (channelSettingsSaveAtRef.current > fetchStartedAt) return;

      const serverMerged = mergeChannelSettings(data.settings);
      setSettings((prev) => ({
        ...serverMerged,
        shops: mergeShopLists(serverMerged.shops ?? [], prev.shops ?? []),
      }));

      const local = safeGetJson<ChannelSettings | null>('omni_settings', null);
      const localShops = stripLegacyDemoShops(local?.shops ?? []);
      if ((serverMerged.shops ?? []).length === 0 && localShops.length > 0) {
        await persistChannelSettings(mergeChannelSettings({ ...local, shops: localShops }));
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      console.error('Fetch channel settings error:', err);
    }
  };

  const formatPullErrors = (errors: any[]): string =>
    errors
      .map((e) => {
        const shop = e.shopId ? `Shop ${e.shopId}` : 'Hệ thống';
        const code = e.error ? ` [${e.error}]` : '';
        const msg = e.message || e.error || 'Lỗi không xác định';
        return `${shop}${code}: ${msg}`;
      })
      .join('; ');

  // Incremental / full sync — fire-and-forget: POST trả 202 ngay, KHÔNG chặn UI.
  // Poll + fetchOrders chạy ngầm (silent), user vẫn thao tác / đổi tab bình thường.
  const pullOrders = async (opts?: { type?: 'incremental' | 'full' }) => {
    const token = localStorage.getItem('admin_token');
    if (!token) return;

    const syncType = opts?.type === 'full' ? 'full' : 'incremental';
    const invalidServerResponseMessage =
      'Máy chủ đang bận hoặc phản hồi không hợp lệ. Vui lòng thử lại sau.';
    const readOrderSyncJson = async (response: Response): Promise<Record<string, any>> => {
      const contentType = response.headers.get('content-type') || '';
      const okHttp = response.ok || response.status === 202;
      if (!okHttp || !contentType.includes('application/json')) {
        try {
          const responsePreview = (await response.text()).slice(0, 200);
          console.error('[Orders Sync] Invalid server response:', {
            status: response.status,
            contentType,
            responsePreview,
          });
        } catch (readError) {
          console.error('[Orders Sync] Cannot read invalid server response:', readError);
        }
        throw new Error(invalidServerResponseMessage);
      }

      try {
        return await response.json();
      } catch (parseError) {
        console.error('[Orders Sync] Invalid JSON response:', parseError);
        throw new Error(invalidServerResponseMessage);
      }
    };

    const response = await fetch(`/api/orders/pull?type=${syncType}&t=${Date.now()}`, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
      },
      body: JSON.stringify({ type: syncType }),
    });
    const data = await readOrderSyncJson(response);

    if (data.skipped || (data.syncing && response.status !== 202 && !data.accepted)) {
      throw new Error(String(data.message || 'Đang có tiến trình đồng bộ chạy'));
    }
    if (data.warning && !data.accepted && response.status !== 202) {
      throw new Error(String(data.warning));
    }

    const startedBackground =
      response.status === 202 ||
      data.accepted === true ||
      /sync started in background|đồng bộ ngầm/i.test(String(data.message || ''));

    if (startedBackground) {
      // Không await — làm mới danh sách ngầm khi sync xong, không overlay.
      void (async () => {
        const pollMs = syncType === 'full' ? 8_000 : 5_000;
        const maxPolls = syncType === 'full' ? 40 : 24;
        for (let i = 0; i < maxPolls; i++) {
          await new Promise((r) => setTimeout(r, pollMs));
          await fetchOrders({ silent: true, bustCache: true });
          try {
            const statusRes = await fetch(`/api/orders/pull/status?t=${Date.now()}`, {
              cache: 'no-store',
              headers: {
                Authorization: `Bearer ${token}`,
                'Cache-Control': 'no-cache',
                Pragma: 'no-cache',
              },
            });
            if (statusRes.ok) {
              const status = await statusRes.json();
              if (!status.syncing) break;
            }
          } catch {
            /* bỏ qua lỗi status */
          }
        }
        await fetchOrders({ silent: true, bustCache: true });
      })();
      return;
    }

    const pulled = Number(data.pulled) || 0;
    const pullErrors = Array.isArray(data.errors) ? data.errors : [];
    if (pullErrors.length > 0 && pulled === 0) {
      throw new Error(formatPullErrors(pullErrors));
    }
    void fetchOrders({ silent: true, bustCache: true });
    if (pullErrors.length > 0) {
      console.warn('[Orders Pull] partial errors:', formatPullErrors(pullErrors));
    }
  };

  // Persist status/tracking changes made in the UI back to the real orders database.
  const handleUpdateOrders = (updatedOrders: Order[], opts?: { persist?: boolean }) => {
    const sanitized = sanitizeOrders(updatedOrders);
    const previousById = new Map(orders.map(o => [o.id, o]));
    setOrders(sanitized);
    void saveOrdersCache(sanitized);

    // Handover/API đã persist JSON+Mongo — chỉ cập nhật state, tránh PATCH full order ghi đè lệch.
    if (opts?.persist === false) return;

    const token = localStorage.getItem('admin_token');
    if (!token) return;

    sanitized.forEach(order => {
      const prev = previousById.get(order.id);
      if (!prev || JSON.stringify(prev) === JSON.stringify(order)) return;

      fetch(`/api/orders/${encodeURIComponent(order.id)}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(order),
      }).catch(err => console.error(`Sync order ${order.id} error:`, err));
    });
  };

  const handleLoginSuccess = (token: string, username: string) => {
    safeSetItem('admin_token', token);
    setIsAuthenticated(true);
    setAdminUser(username);
  };

  const handleLogout = () => {
    safeRemoveItem('admin_token');
    setIsAuthenticated(false);
    setAdminUser('');
    setActiveTab('dashboard');
    setFocusScanner(false);
    writeSessionTab('omni_active_tab', 'dashboard');
    window.history.replaceState({ tab: 'dashboard' }, '', '/?tab=dashboard');
  };

  // 3. Actions handlers
  const handleAddProduct = async (prod: Product) => {
    const token = localStorage.getItem('admin_token');
    if (token) {
      try {
        const response = await fetch('/api/products', {
          method: 'POST',
          headers: apiAuthHeaders(),
          body: JSON.stringify(prod),
        });
        if (response.ok) {
          const saved = await response.json();
          // Hiển thị ngay từ phản hồi server sau khi lưu DB.
          if (Array.isArray(saved?.localInventory)) {
            setProducts(saved.localInventory);
            prod = {
              id: saved.id,
              title: saved.title,
              sku: saved.sku,
              stock: saved.stock,
              importPrice: saved.importPrice,
              sellingPrice: saved.sellingPrice,
              channels: saved.channels,
              category: saved.category,
              description: saved.description,
              imageUrl: saved.imageUrl,
              status: saved.status,
              shopeeId: saved.shopeeId,
              shopeeItemId: saved.shopeeItemId,
              shopeeModelId: saved.shopeeModelId,
              modelName: saved.modelName,
              weight: saved.weight,
              tiktokId: saved.tiktokId,
              wooId: saved.wooId,
              lastSynced: saved.lastSynced,
            } as Product;
          } else {
            setProducts((prev) => [saved, ...prev]);
            prod = saved;
          }
        } else {
          setProducts((prev) => [prod, ...prev]);
        }
      } catch {
        setProducts((prev) => [prod, ...prev]);
      }
    } else {
      setProducts((prev) => [prod, ...prev]);
    }

    const channelsLabel = prod.channels.map((c) => c.toUpperCase()).join(' & ') || 'Hệ thống nội bộ';
    handleAddLog({
      id: `log-${Date.now()}`,
      timestamp: new Date().toISOString(),
      channel: prod.channels.length > 0 ? prod.channels[0] : 'all',
      type: 'publish',
      status: 'success',
      message: `Đã khởi tạo và đăng thành công sản phẩm mới [${prod.title}] lên ${channelsLabel}`,
    });
  };

  const handleUpdateProduct = async (updated: Product, opts?: { save?: boolean }) => {
    setProducts((prev) =>
      prev.map((p) => {
        if (p.id === updated.id) return updated;
        const children = getProductChildren(p);
        if (!children.some((c) => c.id === updated.id)) return p;
        const nextChildren = children.map((c) => (c.id === updated.id ? updated : c));
        const totalStock = nextChildren.reduce((s, c) => s + (Number(c.stock) || 0), 0);
        return { ...p, children: nextChildren, stock: totalStock };
      })
    );
    if (!opts?.save) return { success: true };

    const token = localStorage.getItem('admin_token');
    if (!token) return { success: false, error: 'Chưa đăng nhập.' };

    try {
      const response = await fetch(`/api/products/${encodeURIComponent(updated.id)}`, {
        method: 'PATCH',
        headers: apiAuthHeaders(),
        body: JSON.stringify({
          title: updated.title,
          sku: updated.sku,
          barcode: updated.barcode,
          stock: updated.stock,
          sellingPrice: updated.sellingPrice,
          wholesalePrice: updated.wholesalePrice,
          importPrice: updated.importPrice,
          weight: updated.weight,
          unit: updated.unit,
          status: updated.status,
          channels: updated.channels,
          shopeeId: updated.shopeeId,
          shopeeItemId: updated.shopeeItemId,
          shopeeModelId: updated.shopeeModelId,
          tiktokId: updated.tiktokId,
          wooId: updated.wooId,
        }),
      });
      const data = await parseJsonResponse(response);
      if (!response.ok || data?.success === false) {
        const error =
          data?.error || data?.message || data?.shopeeMessage || `Lỗi cập nhật sản phẩm (HTTP ${response.status})`;
        return {
          success: false,
          error,
          shopeeSynced: false,
          shopeeMessage: data?.shopeeMessage || error,
        };
      }

      let syncResult = data;
      if (!data?.shopeeSynced) {
        const syncResponse = await fetch('/api/products/sync-shopee', {
          method: 'POST',
          headers: apiAuthHeaders(),
          body: JSON.stringify({ productIds: [updated.id] }),
        });
        syncResult = await parseJsonResponse(syncResponse);
        if (!syncResponse.ok || syncResult?.success === false) {
          const error =
            syncResult?.error ||
            syncResult?.message ||
            `Lưu kho thành công nhưng đồng bộ Shopee thất bại (HTTP ${syncResponse.status})`;
          return {
            success: false,
            error,
            shopeeSynced: false,
            shopeeMessage: error,
          };
        }
      }

      if (data?.id) {
        setProducts((prev) =>
          prev.map((p) => {
            if (p.id === data.id) return { ...p, ...data };
            const children = getProductChildren(p);
            if (!children.some((c) => c.id === data.id)) return p;
            const nextChildren = children.map((c) => (c.id === data.id ? { ...c, ...data } : c));
            const totalStock = nextChildren.reduce((s, c) => s + (Number(c.stock) || 0), 0);
            return { ...p, children: nextChildren, stock: totalStock };
          })
        );
      }
      return {
        success: true,
        shopeeSynced: true,
        shopeeMessage:
          syncResult?.shopeeMessage ||
          syncResult?.message ||
          'Đồng bộ Shopee thành công!',
      };
    } catch (err: any) {
      console.error('Update product error:', err);
      return { success: false, error: err?.message || 'Lỗi cập nhật sản phẩm.' };
    }
  };

  const handleDeleteProduct = async (id: string) => {
    // Confirm được gọi từ UI (nhóm Parent) hoặc tại đây cho xóa đơn lẻ
    const token = localStorage.getItem('admin_token');
    if (token) {
      try {
        await fetch(`/api/products/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch (err) {
        console.error('Delete product error:', err);
      }
    }
    setProducts((prev) =>
      prev
        .map((p) => {
          const children = Array.isArray(p.children) ? p.children : p.children_models;
          if (!children?.length) return p;
          if (!children.some((c) => c.id === id)) return p;
          const nextChildren = children.filter((c) => c.id !== id);
          if (nextChildren.length === 0) return null;
          const totalStock = nextChildren.reduce((s, c) => s + (Number(c.stock) || 0), 0);
          return { ...p, children: nextChildren, stock: totalStock };
        })
        .filter((p): p is Product => p != null && p.id !== id)
    );
    setSelectedIds((prev) => prev.filter((item) => item !== id));
  };

  const handleUpdateBulk = (updatedProducts: Product[]) => {
    setProducts(prev => {
      const map = new Map(prev.map(p => [p.id, p]));
      updatedProducts.forEach(up => map.set(up.id, up));
      return Array.from(map.values());
    });
  };

  const handleBulkUpdateApi = async (payload: BulkUpdatePayload): Promise<boolean> => {
    const token = localStorage.getItem('admin_token');
    if (!token) return false;
    try {
      const response = await fetch('/api/products/bulk-update', {
        method: 'POST',
        headers: apiAuthHeaders(),
        body: JSON.stringify(payload),
      });
      if (!response.ok) return false;
      const data = await response.json();
      if (Array.isArray(data.products)) setProducts(data.products);
      return true;
    } catch (err) {
      console.error('Bulk update products error:', err);
      return false;
    }
  };

  const handleSyncItemVariants = async (itemId: string): Promise<Product[] | null> => {
    const token = localStorage.getItem('admin_token');
    if (!token) throw new Error('Chưa đăng nhập');

    const shopeeShop = settings.shops?.find(s => s.platform === 'shopee' && s.connected);
    const response = await fetch('/api/shopee/products/sync-item-variants', {
      method: 'POST',
      headers: apiAuthHeaders(),
      body: JSON.stringify({ itemId, shopId: shopeeShop?.shopId }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data?.message || data?.error || 'Tải SKU phân loại thất bại');
    }
    if (Array.isArray(data.products)) {
      setProducts(data.products);
      return data.products;
    }
    await fetchProducts();
    return null;
  };

  const handleBulkSaveProducts = async (updates: BulkSaveProductUpdate[]): Promise<boolean> => {
    const token = localStorage.getItem('admin_token');
    if (!token) return false;

    try {
      const response = await fetch('/api/products/bulk-save', {
        method: 'POST',
        headers: apiAuthHeaders(),
        body: JSON.stringify({ updates }),
      });
      if (!response.ok) return false;
      const data = await response.json();
      if (Array.isArray(data.products)) {
        setProducts(data.products);
      }
      return true;
    } catch (err) {
      console.error('Bulk save products error:', err);
      return false;
    }
  };

  const handleReplaceProducts = async (newProducts: Product[]) => {
    const token = localStorage.getItem('admin_token');
    if (token) {
      try {
        const response = await fetch('/api/products/replace', {
          method: 'PUT',
          headers: apiAuthHeaders(),
          body: JSON.stringify({ products: newProducts }),
        });
        if (response.ok) {
          const data = await response.json();
          setProducts(data.products || newProducts);
          return;
        }
      } catch (err) {
        console.error('Replace products error:', err);
      }
    }
    setProducts(newProducts);
  };

  const fetchExpenses = async () => {
    const token = localStorage.getItem('admin_token');
    if (!token) return;
    try {
      const response = await fetch('/api/expenses', {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.ok) {
        setExpenses(await response.json());
      }
    } catch (err) {
      console.error('Fetch expenses error:', err);
    }
  };

  const handleAddExpense = async (exp: Expense) => {
    const token = localStorage.getItem('admin_token');
    if (token) {
      try {
        const response = await fetch('/api/expenses', {
          method: 'POST',
          headers: apiAuthHeaders(),
          body: JSON.stringify(exp),
        });
        if (response.ok) {
          const data = await response.json();
          if (Array.isArray(data.expenses)) {
            setExpenses(data.expenses);
            return;
          }
        }
      } catch (err) {
        console.error('Add expense error:', err);
      }
    }
    setExpenses((prev) => [exp, ...prev]);
  };

  const handleDeleteExpense = async (id: string) => {
    if (!confirm('Xóa bản ghi chi phí này?')) return;
    const token = localStorage.getItem('admin_token');
    if (token) {
      try {
        const response = await fetch(`/api/expenses/${id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        });
        if (response.ok) {
          const data = await response.json();
          if (Array.isArray(data.expenses)) {
            setExpenses(data.expenses);
            return;
          }
        }
      } catch (err) {
        console.error('Delete expense error:', err);
      }
    }
    setExpenses((prev) => prev.filter((e) => e.id !== id));
  };

  const handleAddLog = (log: SyncLog) => {
    setLogs(prev => [log, ...prev]);
  };

  const handleClearLogs = () => {
    if (confirm('Xóa toàn bộ nhật ký đồng bộ hiện tại?')) {
      setLogs([]);
    }
  };

  const fetchSuppliers = async () => {
    const token = localStorage.getItem('admin_token');
    if (!token) return;
    try {
      const response = await fetch('/api/suppliers', {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.ok) {
        setSuppliers(await response.json());
      }
    } catch (err) {
      console.error('Fetch suppliers error:', err);
    }
  };

  const handleAddSupplier = async (payload: {
    name: string;
    supplierCode: string;
    status: 'active' | 'inactive';
  }) => {
    const token = localStorage.getItem('admin_token');
    if (!token) return false;
    try {
      const response = await fetch('/api/suppliers', {
        method: 'POST',
        headers: apiAuthHeaders(),
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (response.ok && Array.isArray(data.suppliers)) {
        setSuppliers(data.suppliers);
        return true;
      }
      alert(data.error === 'supplier_code_duplicate'
        ? 'Mã nhà cung cấp đã tồn tại!'
        : 'Tạo nhà cung cấp thất bại.');
      return false;
    } catch (err) {
      console.error('Add supplier error:', err);
      return false;
    }
  };

  const handleUpdateSupplier = async (updated: Supplier) => {
    const token = localStorage.getItem('admin_token');
    if (!token) return false;
    try {
      const response = await fetch(`/api/suppliers/${encodeURIComponent(updated.id)}`, {
        method: 'PUT',
        headers: apiAuthHeaders(),
        body: JSON.stringify(updated),
      });
      const data = await response.json();
      if (response.ok && Array.isArray(data.suppliers)) {
        setSuppliers(data.suppliers);
        return true;
      }
      alert(data.error === 'supplier_code_duplicate'
        ? 'Mã nhà cung cấp đã tồn tại!'
        : 'Cập nhật nhà cung cấp thất bại.');
      return false;
    } catch (err) {
      console.error('Update supplier error:', err);
      return false;
    }
  };

  const handleDeleteSupplier = async (id: string) => {
    const token = localStorage.getItem('admin_token');
    if (!token) return false;
    try {
      const response = await fetch(`/api/suppliers/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: apiAuthHeaders(),
      });
      const data = await response.json();
      if (response.ok && Array.isArray(data.suppliers)) {
        setSuppliers(data.suppliers);
        return true;
      }
      if (data.error === 'supplier_has_debt') {
        alert('Không thể xóa nhà cung cấp này vì vẫn đang còn công nợ chưa tất toán!');
      }
      return false;
    } catch (err) {
      console.error('Delete supplier error:', err);
      return false;
    }
  };

  const fetchImports = async () => {
    const token = localStorage.getItem('admin_token');
    if (!token) return;
    try {
      const response = await fetch('/api/imports', {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.ok) {
        setImports(await response.json());
      }
    } catch (err) {
      console.error('Fetch imports error:', err);
    }
  };

  useEffect(() => {
    if (!isAuthenticated) return;

    const bootstrapCatalog = async () => {
      purgeLegacyCatalogCache();

      // Không hydrate IndexedDB cũ trước API — tránh hiện đơn bóng ma sau purge.
      await clearOrdersCache();

      if (safeGetItem(CATALOG_PURGE_FLAG) !== '1') {
        try {
          const res = await fetch('/api/catalog/wipe-all', {
            method: 'POST',
            headers: apiAuthHeaders(),
          });
          if (res.ok) {
            safeSetItem(CATALOG_PURGE_FLAG, '1');
          }
        } catch (err) {
          console.warn('[Catalog] wipe-all skipped:', err);
        }
        purgeLegacyCatalogCache();
      }

      fetchOrders();
      // F5: ưu tiên localStorage; chỉ gọi server khi chưa có cache.
      void fetchProducts({ page: 1, append: false, pageSize: 50, forceRefresh: false });
      fetchSuppliers();
      fetchImports();
      fetchExpenses();
      fetchChannelSettings();
      syncShopeeOAuthShopIds();
    };

    const syncShopeeOAuthShopIds = async () => {
      const token = localStorage.getItem('admin_token');
      if (!token) return;
      try {
        const res = await fetch('/api/shopee/oauth-shops', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const data = await res.json();
        const shopIds: string[] = Array.isArray(data.shopIds) ? data.shopIds.map(String) : [];
        if (!shopIds.length) return;

        setSettings((prev) => {
          const shops = [...(prev.shops || [])];
          const shopeeShops = shops.filter((s) => s.platform === 'shopee');
          const unmatchedTokens = shopIds.filter(
            (id) => !shopeeShops.some((s) => String(s.shopId) === id),
          );
          const unmatchedShops = shopeeShops.filter(
            (s) => !shopIds.includes(String(s.shopId)),
          );
          if (unmatchedTokens.length === 1 && unmatchedShops.length === 1) {
            const target = unmatchedShops[0];
            return {
              ...prev,
              shops: shops.map((s) =>
                s.id === target.id
                  ? {
                      ...s,
                      shopId: unmatchedTokens[0],
                      connected: true,
                      lastSynced: new Date().toISOString(),
                    }
                  : s,
              ),
            };
          }
          return prev;
        });
      } catch {
        /* ignore */
      }
    };

    void bootstrapCatalog();
  }, [isAuthenticated]);

  const handleAddImport = async (transaction: ImportTransaction) => {
    const token = localStorage.getItem('admin_token');
    let savedProduct: Product | null = null;
    if (token) {
      try {
        const response = await fetch('/api/imports', {
          method: 'POST',
          headers: apiAuthHeaders(),
          body: JSON.stringify({
            ...transaction,
            warehouseId: 'KhoGoc',
            productSku: transaction.productSku,
          }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(data.error || 'Lưu phiếu nhập thất bại');
        }
        if (Array.isArray(data.imports)) {
          setImports(data.imports);
        } else {
          setImports((prev) => [transaction, ...prev]);
        }
        if (data.product && data.product.id) {
          savedProduct = data.product as Product;
        }
      } catch (err) {
        console.error('Save import error:', err);
        alert(`Không lưu được phiếu nhập: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    } else {
      setImports((prev) => [transaction, ...prev]);
    }

    // Cập nhật UI từ product server trả về (đã cộng tồn + đè importPrice) — không cộng đôi
    setProducts((prevProducts) =>
      prevProducts.map((p) => {
        if (savedProduct && p.id === savedProduct.id) {
          return { ...p, ...savedProduct, status: 'active' as const };
        }
        if (p.id === transaction.productId) {
          return {
            ...p,
            ...(savedProduct || {}),
            stock: savedProduct
              ? Number(savedProduct.stock)
              : (Number(p.stock) || 0) + transaction.quantity,
            importPrice: savedProduct
              ? Number(savedProduct.importPrice)
              : transaction.newImportPrice,
            status: 'active' as const,
          };
        }
        const children = getProductChildren(p);
        if (!children.some((c) => c.id === transaction.productId || (savedProduct && c.id === savedProduct.id))) {
          return p;
        }
        const targetId = savedProduct?.id || transaction.productId;
        const nextChildren = children.map((c) =>
          c.id === targetId || c.id === transaction.productId
            ? {
                ...c,
                ...(savedProduct && savedProduct.id === c.id ? savedProduct : {}),
                stock: savedProduct && savedProduct.id === c.id
                  ? Number(savedProduct.stock)
                  : (Number(c.stock) || 0) + transaction.quantity,
                importPrice: savedProduct && savedProduct.id === c.id
                  ? Number(savedProduct.importPrice)
                  : transaction.newImportPrice,
                status: 'active' as const,
              }
            : c
        );
        const totalStock = nextChildren.reduce((s, c) => s + (Number(c.stock) || 0), 0);
        return { ...p, children: nextChildren, stock: totalStock };
      })
    );

    // Đồng bộ lại từ Kho Gốc để màn hình chính (ProductList) thấy tồn/giá mới
    void fetchProducts({ forceRefresh: true, silent: true });

    const supplier = suppliers.find((s) => s.id === transaction.supplierId);
    if (supplier) {
      await handleUpdateSupplier({
        ...supplier,
        totalOrderValue: supplier.totalOrderValue + transaction.totalAmount,
        totalPaid: supplier.totalPaid + transaction.paidAmount,
        totalDebt: supplier.totalDebt + (transaction.totalAmount - transaction.paidAmount),
      });
    }

    handleAddLog({
      id: `log-${Date.now()}`,
      timestamp: new Date().toISOString(),
      channel: 'all',
      type: 'stock_sync',
      status: 'success',
      message: `Đã nhập sỉ thành công ${transaction.quantity} cái [${transaction.productTitle}] từ ${transaction.supplierName}.`,
    });
  };

  const navigateTab = (
    tab: string,
    opts?: { openScanner?: boolean; ordersSubTab?: OrdersSubTabId | null },
  ) => {
    setActiveTab(tab);
    setMobileDrawerOpen(false);
    setFocusScanner(tab === 'orders' && Boolean(opts?.openScanner));

    let nextOrdersSub: OrdersSubTabId | null = null;
    if (tab === 'orders') {
      // Ưu tiên URL/session (user vừa đổi sub-tab) hơn hint cũ từ menu
      nextOrdersSub =
        opts?.ordersSubTab ??
        resolveOrdersSubTabFromUrl() ??
        normalizeOrdersSubTab(readSessionTab('omni_orders_subtab')) ??
        ordersSubTabHint;
      setOrdersSubTabHint(nextOrdersSub);
    } else {
      setOrdersSubTabHint(null);
    }

    writeSessionTab('omni_active_tab', tab);
    if (tab === 'orders' && nextOrdersSub) {
      writeSessionTab('omni_orders_subtab', nextOrdersSub);
    }

    const nextUrl = buildNavUrl(tab, tab === 'orders' ? nextOrdersSub : null);
    window.history.pushState({ tab, ordersTab: nextOrdersSub }, '', nextUrl);
  };

  const handleEditProductShortcut = (productId: string) => {
    setHighlightProductId(productId);
    navigateTab('products');
  };

  const handleNavigateToImport = (productId: string) => {
    setImportPrefillProductId(productId);
    navigateTab('imports');
  };

  const navButtonClass = (tab: string) =>
    `w-full flex items-center gap-3 px-4 py-3 min-h-11 rounded-xl text-xs font-bold uppercase tracking-wider transition-all cursor-pointer ${
      activeTab === tab
        ? 'bg-blue-600 text-white font-extrabold shadow-sm'
        : 'hover:bg-slate-800 hover:text-white text-slate-400'
    }`;

  if (authChecking) {
    return (
      <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center p-4">
        <div className="animate-spin rounded-full h-10 w-10 border-t-2 border-b-2 border-blue-500"></div>
        <p className="text-slate-400 text-xs mt-4 font-bold tracking-wider uppercase font-sans">Đang kiểm tra bảo mật...</p>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LoginPage onLoginSuccess={handleLoginSuccess} />;
  }

  return (
    <div className="min-h-screen bg-gray-50/50 md:flex md:flex-row antialiased font-sans text-gray-900 selection:bg-blue-100 selection:text-blue-900">
      {backgroundRefreshing && (
        <div
          className="fixed top-3 right-3 z-[100] flex items-center gap-2 rounded-full bg-slate-900/90 text-white px-3 py-1.5 shadow-lg pointer-events-none"
          role="status"
          aria-live="polite"
        >
          <RefreshCw className="w-3.5 h-3.5 animate-spin shrink-0" />
          <span className="text-[11px] font-semibold tracking-wide">Đang làm mới...</span>
        </div>
      )}
      {/* Sidebar Navigation */}
      <aside className="sidebar-panel max-md:hidden md:flex md:w-64 md:flex-col shrink-0 sticky top-0 h-screen overflow-y-auto bg-slate-900 text-slate-300 border-r border-slate-800" id="sidebar-panel">
        {/* Brand Header */}
        <div className="p-6 border-b border-slate-800 shrink-0">
          <BrandHeader logoSize={48} />
        </div>

        {/* Navigation Items */}
        <nav className="flex-1 p-4 space-y-1 overflow-y-auto" id="sidebar-nav">
          <button
            onClick={() => navigateTab('dashboard')}
            className={navButtonClass('dashboard')}
          >
            <LayoutDashboard className="w-4 h-4 shrink-0" /> Tổng quan
          </button>

          <button
            onClick={() => navigateTab('products')}
            className={navButtonClass('products')}
          >
            <Package className="w-4 h-4 shrink-0" /> Kho & Sản phẩm
          </button>

          <button
            onClick={() => navigateTab('publish')}
            className={navButtonClass('publish')}
          >
            <Globe className="w-4 h-4 shrink-0" /> Đăng bán sỉ đa sàn
          </button>

          <button
            onClick={() => navigateTab('orders')}
            className={navButtonClass('orders')}
          >
            <ClipboardList className="w-4 h-4 shrink-0" /> Quản lý đơn hàng
          </button>

          <button
            onClick={() => navigateTab('orders', { ordersSubTab: 'received_cancel_returns' })}
            className={`w-full flex items-center gap-3 px-4 py-3 min-h-11 rounded-xl text-xs font-bold uppercase tracking-wider transition-all cursor-pointer ${
              activeTab === 'orders' && ordersSubTabHint === 'received_cancel_returns'
                ? 'bg-teal-600 text-white font-extrabold shadow-sm'
                : 'hover:bg-slate-800 hover:text-white text-slate-400'
            }`}
          >
            <PackageCheck className="w-4 h-4 shrink-0" /> Đã nhận đơn hủy, đơn hoàn
          </button>

          <button
            onClick={() => navigateTab('picking')}
            className={`${navButtonClass('picking')} max-md:hidden`}
          >
            <ScanLine className="w-4 h-4 shrink-0" /> Nhặt hàng
          </button>

          <button
            onClick={() => navigateTab('bulk')}
            className={navButtonClass('bulk')}
          >
            <Sparkles className="w-4 h-4 shrink-0" /> Sửa hàng loạt & AI
          </button>

          <button
            onClick={() => navigateTab('suppliers')}
            className={navButtonClass('suppliers')}
          >
            <Users className="w-4 h-4 shrink-0" /> Nhà Cung Cấp
          </button>

          <button
            onClick={() => navigateTab('imports')}
            className={navButtonClass('imports')}
          >
            <ArrowDownToLine className="w-4 h-4 shrink-0" /> Nhập Hàng
          </button>

          <button
            onClick={() => navigateTab('financials')}
            className={navButtonClass('financials')}
          >
            <Coins className="w-4 h-4 shrink-0" /> Chi Phí Bán Hàng
          </button>

          <button
            onClick={() => navigateTab('settings')}
            className={navButtonClass('settings')}
          >
            <Settings className="w-4 h-4 shrink-0" /> Cấu hình & Kết nối
          </button>

          <button
            onClick={() => {
              setMobileDrawerOpen(false);
              handleLogout();
            }}
            className="w-full flex items-center gap-3 px-4 py-3 min-h-11 rounded-xl text-xs font-bold uppercase tracking-wider transition-all cursor-pointer hover:bg-rose-950/40 hover:text-rose-400 text-slate-400 mt-4 border border-dashed border-slate-800/80 hover:border-rose-900/40"
          >
            <LogOut className="w-4 h-4 shrink-0 text-rose-500" /> Đăng xuất ({adminUser})
          </button>
        </nav>

        {/* Sidebar Footer */}
        <div className="p-4 border-t border-slate-800 text-center space-y-1.5 text-[10px] text-slate-500 font-medium shrink-0">
          <p>{APP_TITLE}</p>
          <p>© 2026 Linh Kiện Âm Thanh</p>
        </div>
      </aside>

      {/* Mobile drawer navigation */}
      {mobileDrawerOpen && (
        <>
          <button
            type="button"
            className="fixed inset-0 bg-black/50 z-60 md:hidden"
            aria-label="Đóng menu"
            onClick={() => setMobileDrawerOpen(false)}
          />
          <aside className="fixed inset-y-0 left-0 w-[min(100vw-3rem,18rem)] z-70 md:hidden flex flex-col bg-slate-900 text-slate-300 border-r border-slate-800 shadow-2xl">
            <div className="p-4 border-b border-slate-800 flex items-center justify-between gap-3">
              <BrandHeader />
              <button
                type="button"
                onClick={() => setMobileDrawerOpen(false)}
                className="min-h-11 min-w-11 flex items-center justify-center rounded-xl text-slate-400 hover:text-white hover:bg-slate-800"
                aria-label="Đóng menu"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
              <button onClick={() => navigateTab('dashboard')} className={navButtonClass('dashboard')}>
                <LayoutDashboard className="w-4 h-4 shrink-0" /> Tổng quan
              </button>
              <button onClick={() => navigateTab('products')} className={navButtonClass('products')}>
                <Package className="w-4 h-4 shrink-0" /> Kho & Sản phẩm
              </button>
              <button onClick={() => navigateTab('publish')} className={navButtonClass('publish')}>
                <Globe className="w-4 h-4 shrink-0" /> Đăng bán sỉ đa sàn
              </button>
              <button onClick={() => navigateTab('orders')} className={navButtonClass('orders')}>
                <ClipboardList className="w-4 h-4 shrink-0" /> Quản lý đơn hàng
              </button>
              <button
                onClick={() => navigateTab('orders', { ordersSubTab: 'received_cancel_returns' })}
                className={`w-full flex items-center gap-3 px-4 py-3 min-h-11 rounded-xl text-xs font-bold uppercase tracking-wider transition-all cursor-pointer ${
                  activeTab === 'orders' && ordersSubTabHint === 'received_cancel_returns'
                    ? 'bg-teal-600 text-white font-extrabold shadow-sm'
                    : 'hover:bg-slate-800 hover:text-white text-slate-400'
                }`}
              >
                <PackageCheck className="w-4 h-4 shrink-0" /> Đã nhận đơn hủy, đơn hoàn
              </button>
              <button onClick={() => navigateTab('orders', { openScanner: true })} className={`w-full flex items-center gap-3 px-4 py-3 min-h-11 rounded-xl text-xs font-bold uppercase tracking-wider transition-all cursor-pointer ${activeTab === 'orders' && focusScanner ? 'bg-blue-600 text-white' : 'hover:bg-slate-800 hover:text-white text-slate-400'}`}>
                <Barcode className="w-4 h-4 shrink-0" /> Quét mã vạch
              </button>
              <button onClick={() => navigateTab('bulk')} className={navButtonClass('bulk')}>
                <Sparkles className="w-4 h-4 shrink-0" /> Sửa hàng loạt & AI
              </button>
              <button onClick={() => navigateTab('suppliers')} className={navButtonClass('suppliers')}>
                <Users className="w-4 h-4 shrink-0" /> Nhà Cung Cấp
              </button>
              <button onClick={() => navigateTab('imports')} className={navButtonClass('imports')}>
                <ArrowDownToLine className="w-4 h-4 shrink-0" /> Nhập Hàng
              </button>
              <button onClick={() => navigateTab('financials')} className={navButtonClass('financials')}>
                <Coins className="w-4 h-4 shrink-0" /> Chi Phí Bán Hàng
              </button>
              <button onClick={() => navigateTab('settings')} className={navButtonClass('settings')}>
                <Settings className="w-4 h-4 shrink-0" /> Cấu hình & Kết nối
              </button>
              <button
                onClick={() => {
                  setMobileDrawerOpen(false);
                  handleLogout();
                }}
                className="w-full flex items-center gap-3 px-4 py-3 min-h-11 rounded-xl text-xs font-bold uppercase tracking-wider transition-all cursor-pointer hover:bg-rose-950/40 hover:text-rose-400 text-slate-400 mt-4 border border-dashed border-slate-800/80"
              >
                <LogOut className="w-4 h-4 shrink-0 text-rose-500" /> Đăng xuất
              </button>
            </nav>
          </aside>
        </>
      )}

      {/* Main Content Area */}
      <main className="md:flex-1 min-w-0 w-full">
        {/* Header toolbar */}
        <header className={`bg-white border-b border-gray-100 shadow-xs shrink-0 ${focusScanner ? 'max-md:hidden md:flex' : 'flex'}`}>
          <div className="app-main-container w-full px-4 md:px-6 py-3 md:py-4 flex items-center justify-between gap-3">
          <button
            type="button"
            className="md:hidden shrink-0 min-h-11 min-w-11 app-touch-target flex items-center justify-center rounded-xl border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 active:bg-gray-100"
            onClick={() => setMobileDrawerOpen(true)}
            aria-label="Mở menu điều hướng"
          >
            <Menu className="w-5 h-5" />
          </button>
          <div className="md:hidden shrink-0">
            <BrandLogo size={36} className="rounded-lg" />
          </div>
          <div className={`flex-1 min-w-0 ${activeTab === 'dashboard' || activeTab === 'picking' || activeTab === 'products' ? 'max-md:hidden' : ''}`}>
            <h2 className={`text-lg font-extrabold text-gray-900 tracking-tight ${activeTab === 'orders' ? 'om-orders-mobile-hide-page-title' : ''}`}>
              {activeTab === 'dashboard' && 'Bảng Điều Khiển Tổng Quan'}
              {activeTab === 'products' && 'Quản Lý Danh Sách Sản Phẩm'}
              {activeTab === 'publish' && 'Hệ Thống Đăng Bán Sản Phẩm Đa Kênh'}
              {activeTab === 'orders' &&
                (ordersSubTabHint === 'received_cancel_returns'
                  ? 'Đã nhận đơn hủy, đơn hoàn'
                  : 'Hệ Thống Quản Lý Đơn Hàng Đa Sàn')}
              {activeTab === 'picking' && 'Nhặt Hàng (Picking)'}
              {activeTab === 'bulk' && 'Chỉnh Sửa Hàng Loạt & Công Cụ AI'}
              {activeTab === 'suppliers' && 'Quản Lý Đối Tác Nhà Cung Cấp'}
              {activeTab === 'imports' && 'Quản Lý Nhập Hàng'}
              {activeTab === 'financials' && 'Chi Phí Bán Hàng'}
              {activeTab === 'settings' && 'Thiết Lập API Sàn Thương Mại'}
            </h2>
            {activeTab !== 'dashboard' && (
            <p className={`text-xs text-gray-400 ${activeTab === 'orders' ? 'om-orders-mobile-hide-page-desc' : ''}`}>
              {activeTab === 'products' && 'Quản lý giá nhập, giá bán lẻ, tồn kho và xuất bản kênh.'}
              {activeTab === 'publish' && 'Đăng bán sản phẩm lên nhiều gian hàng đồng thời, lồng khung hình sỉ hàng loạt và tối ưu tiêu đề chống spam bằng AI.'}
              {activeTab === 'orders' &&
                (ordersSubTabHint === 'received_cancel_returns'
                  ? 'Đối soát kiện hủy/hoàn đã nhận về kho (14 ngày gần nhất).'
                  : 'Quản lý 8 trạng thái đơn Shopee & TikTok, chuẩn bị hàng đóng gói và in vận đơn nhiệt.')}
              {activeTab === 'picking' && 'Quét mã đơn, tích sản phẩm đã nhặt và chuyển sang đóng gói.'}
              {activeTab === 'bulk' && 'Tăng giảm giá %, đặt tồn kho, tối ưu nội dung bằng AI hàng loạt.'}
              {activeTab === 'suppliers' && 'Quản lý thông tin liên hệ, công nợ sỉ và tiền độ thanh toán cho xưởng sỉ.'}
              {activeTab === 'imports' && 'Quản lý hóa đơn nhập đầu vào, theo dõi biến động % giá nhập hàng.'}
              {activeTab === 'financials' && 'Theo dõi chi phí hoạt động, cơ cấu quỹ và mô phỏng lợi nhuận sau phí sàn.'}
              {activeTab === 'settings' && 'Cập nhật mã gian hàng, API key và trỏ DNS về hosting riêng.'}
            </p>
            )}
          </div>

          <div className="max-md:hidden md:flex items-center gap-4 text-xs font-semibold shrink-0">
            {/* Shopee Connection badge */}
            <div className="flex items-center gap-1.5 bg-gray-50 border border-gray-100 px-3 py-1.5 rounded-xl">
              <span className={`w-2 h-2 rounded-full ${settings.shopeeConnected ? 'bg-emerald-500' : 'bg-gray-300'}`}></span>
              <span className="text-gray-600">Shopee</span>
            </div>

            {/* TikTok Connection badge */}
            <div className="flex items-center gap-1.5 bg-gray-50 border border-gray-100 px-3 py-1.5 rounded-xl">
              <span className={`w-2 h-2 rounded-full ${settings.tiktokConnected ? 'bg-emerald-500' : 'bg-gray-300'}`}></span>
              <span className="text-gray-600">TikTok Shop</span>
            </div>
          </div>
          </div>
        </header>

        {/* Active Tab rendering */}
        <div className={`app-main-container app-page-content app-scroll-list ${activeTab === 'picking' ? 'max-md:pt-1 max-md:px-2' : activeTab === 'products' ? 'max-md:pt-1 max-md:px-2' : 'max-md:pt-2 max-md:px-3'} p-4 md:p-6 pb-24 md:pb-6`}>
          {activeTab === 'dashboard' && (
            <ErrorBoundary label="Tổng quan">
              <Dashboard
                orders={orders}
                products={products}
                onTabChange={setActiveTab}
                onEditProductShortcut={handleEditProductShortcut}
                onUpdateProduct={handleUpdateProduct}
                onNavigateToImport={handleNavigateToImport}
              />
            </ErrorBoundary>
          )}

          {activeTab === 'products' && (
            <>
              <div className={`${mobileProductsView === 'audit' ? 'max-md:block' : 'max-md:hidden'} md:hidden`}>
                <InventoryAudit
                  products={products}
                  shopId={settings.shops?.find((s) => s.platform === 'shopee' && s.connected)?.shopId}
                  onRefreshProducts={fetchProducts}
                />
              </div>
              <div className={`${mobileProductsView === 'list' ? 'max-md:block' : 'max-md:hidden'} md:block`}>
                <ProductList
                  products={products}
                  onAddProduct={handleAddProduct}
                  onUpdateProduct={handleUpdateProduct}
                  onDeleteProduct={handleDeleteProduct}
                  onReplaceProducts={handleReplaceProducts}
                  onBulkSave={handleBulkSaveProducts}
                  onSyncItemVariants={handleSyncItemVariants}
                  onRefreshProducts={fetchProducts}
                  onProductsUpdated={(prods) => setProducts(prods)}
                  onBulkSelect={setSelectedIds}
                  selectedIds={selectedIds}
                  onTabChange={setActiveTab}
                  highlightProductId={highlightProductId}
                  onClearHighlight={() => setHighlightProductId(null)}
                  shops={settings.shops || []}
                  suppliers={suppliers}
                  onAddLog={handleAddLog}
                  productsLoading={productsLoading}
                  systemFees={settings.systemFees ?? []}
                  productsMeta={productsMeta}
                />
              </div>
            </>
          )}

          {activeTab === 'publish' && (
            <PublishManager 
              products={products}
              onUpdateProduct={handleUpdateProduct}
              onAddLog={handleAddLog}
              shops={settings.shops || []}
            />
          )}

          {activeTab === 'picking' && (
            <OrderPicking
              orders={orders}
              onUpdateOrders={handleUpdateOrders}
              onAddLog={handleAddLog}
            />
          )}

          {activeTab === 'orders' && (
            <ErrorBoundary label="Quản lý đơn hàng">
              <OrderManager 
              orders={orders}
              onUpdateOrders={handleUpdateOrders}
              onPullShopeeOrders={pullOrders}
              onFetchOrders={fetchOrders}
              ordersLoading={ordersLoading}
              shops={settings.shops || []}
              systemFees={settings.systemFees ?? []}
              onAddLog={handleAddLog}
              products={products}
              onUpdateProduct={handleUpdateProduct}
              focusScanner={focusScanner}
              initialOrdersSubTab={ordersSubTabHint}
              onOrdersSubTabChange={(tab) => {
                setOrdersSubTabHint(tab);
                writeSessionTab('omni_orders_subtab', tab);
              }}
              onCloseScanner={() => {
                // Chỉ đóng UI quét — giữ nguyên tab Quản lý đơn, không về trang chủ.
                setFocusScanner(false);
                navigateTab('orders', {
                  ordersSubTab: ordersSubTabHint ?? resolveOrdersSubTabFromUrl(),
                });
              }}
              onEndScanSession={() => {
                setFocusScanner(false);
                navigateTab('orders', {
                  ordersSubTab: ordersSubTabHint ?? resolveOrdersSubTabFromUrl(),
                });
              }}
            />
            </ErrorBoundary>
          )}

          {activeTab === 'bulk' && (
            <BulkEditor 
              products={products}
              selectedIds={selectedIds}
              shops={settings.shops || []}
              onUpdateBulk={handleUpdateBulk}
              onBulkUpdate={handleBulkUpdateApi}
              onAddLog={handleAddLog}
            />
          )}

          {activeTab === 'suppliers' && (
            <SupplierManager 
              suppliers={suppliers}
              onAddSupplier={handleAddSupplier}
              onUpdateSupplier={handleUpdateSupplier}
              onDeleteSupplier={handleDeleteSupplier}
            />
          )}

          {activeTab === 'imports' && (
            <ImportManager 
              imports={imports}
              suppliers={suppliers}
              onRefreshSuppliers={fetchSuppliers}
              onSuppliersUpdated={setSuppliers}
              products={products}
              onAddImport={handleAddImport}
              onEditProductShortcut={handleEditProductShortcut}
              initialProductId={importPrefillProductId}
              onInitialProductConsumed={() => setImportPrefillProductId(null)}
            />
          )}

          {activeTab === 'financials' && (
            <Financials 
              expenses={expenses}
              products={products}
              orders={orders}
              onAddExpense={handleAddExpense}
              onDeleteExpense={handleDeleteExpense}
              settings={settings}
              onUpdateSettings={persistChannelSettings}
            />
          )}

          {activeTab === 'settings' && (
            <SettingsView 
              settings={settings}
              onUpdateSettings={persistChannelSettings}
              logs={logs}
              onClearLogs={handleClearLogs}
            />
          )}
        </div>
      </main>

      {/* Mobile Bottom Navigation Bar */}
      <div className={`fixed bottom-0 left-0 right-0 bg-slate-900 border-t border-slate-800 z-50 max-md:flex md:hidden items-stretch justify-between py-1.5 px-1 shadow-xl safe-area-pb ${focusScanner ? 'max-md:hidden' : ''}`}>
        <button
          onClick={() => { setMobileProductsView('audit'); navigateTab('products'); }}
          type="button"
          className={`flex flex-1 flex-col items-center justify-center gap-0.5 min-h-12 px-1 py-2 app-touch-target cursor-pointer transition-all ${
            activeTab === 'products' && mobileProductsView === 'audit'
              ? 'text-blue-500 font-extrabold'
              : 'text-slate-400 hover:text-white font-medium'
          }`}
        >
          <Scale className="w-5 h-5" />
          <span className="text-[9px] uppercase tracking-wide font-extrabold">Kiểm hàng</span>
        </button>

        <button
          onClick={() => { setMobileProductsView('list'); navigateTab('products'); }}
          type="button"
          className={`flex flex-1 flex-col items-center justify-center gap-0.5 min-h-12 px-1 py-2 app-touch-target cursor-pointer transition-all ${
            activeTab === 'products' && mobileProductsView === 'list'
              ? 'text-blue-500 font-extrabold'
              : 'text-slate-400 hover:text-white font-medium'
          }`}
        >
          <Package className="w-5 h-5" />
          <span className="text-[9px] uppercase tracking-wide font-extrabold">Sản Phẩm</span>
        </button>

        <button
          onClick={() => navigateTab('orders')}
          type="button"
          className={`flex flex-1 flex-col items-center justify-center gap-0.5 min-h-12 px-1 py-2 app-touch-target cursor-pointer transition-all ${
            activeTab === 'orders' && !focusScanner
              ? 'text-blue-500 font-extrabold'
              : 'text-slate-400 hover:text-white font-medium'
          }`}
        >
          <ClipboardList className="w-5 h-5" />
          <span className="text-[9px] uppercase tracking-wide font-extrabold">Đơn hàng</span>
        </button>

        <button
          onClick={() => navigateTab('picking')}
          type="button"
          className={`flex flex-1 flex-col items-center justify-center gap-0.5 min-h-12 px-1 py-2 app-touch-target cursor-pointer transition-all ${
            activeTab === 'picking'
              ? 'text-emerald-400 font-extrabold'
              : 'text-slate-400 hover:text-white font-medium'
          }`}
        >
          <ShoppingBasket className="w-5 h-5" />
          <span className="text-[9px] uppercase tracking-wide font-extrabold">Nhặt hàng</span>
        </button>

        <button
          onClick={() => navigateTab('orders', { openScanner: true })}
          type="button"
          className={`flex flex-1 flex-col items-center justify-center gap-0.5 min-h-12 px-1 py-2 app-touch-target cursor-pointer transition-all ${
            activeTab === 'orders' && focusScanner
              ? 'text-blue-500 font-extrabold'
              : 'text-slate-400 hover:text-white font-medium'
          }`}
        >
          <Barcode className="w-5 h-5" />
          <span className="text-[9px] uppercase tracking-wide font-extrabold">Quét mã</span>
        </button>
      </div>
    </div>
  );
}
