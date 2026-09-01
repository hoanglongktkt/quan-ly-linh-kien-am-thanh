import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Product, Expense, Order, ChannelSettings, SyncLog, Supplier, ImportTransaction, BulkSaveProductUpdate, ConnectedShop, getProductChildren } from './types';
import { 
  INITIAL_SYNC_LOGS,
} from './data';
import Dashboard from './components/Dashboard';
import ProductList from './components/ProductList';
import InventoryAudit from './components/InventoryAudit';
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
import { purgeLegacyCatalogCache } from './utils/catalogStorage';
import { sanitizeOrders, sortOrdersByCreatedAtDesc, orderCreatedAtMs } from './utils/sanitizeOrder';
import { safeGetJson, safeRemoveItem, safeSetItem } from './utils/safeStorage';
import { parseJsonResponse } from './utils/apiClient';
import { decodeJwtPayload, isJwtLocallyValid } from './utils/jwtClient';
import { clearLegacyOrdersLocalStorage, loadOrdersCache, saveOrdersCache } from './utils/orderCache';
import { 
  LayoutDashboard, 
  Package, 
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
  CheckCircle2,
  Loader2,
} from 'lucide-react';
import type { OrdersSubTabId } from './components/OrderManager';
import {
  fetchScanBgStatus,
  ackScanBgNotifications,
  formatScanBgToast,
} from './utils/scanBgQueue';

/** Polling nhẹ — recursive setTimeout, không chồng request. */
const SCAN_BG_STATUS_POLL_MS = 15_000;

/** Gộp shallow fetch vào cache: cập nhật đơn cũ, prepend đơn mới.
 * - Không downgrade cờ bàn giao ĐVVC (true → false) khi fresh còn stale.
 * - Không downgrade SHIPPED/shipping → PROCESSED (tránh tab Đang giao bị kéo lùi). */
function mergeShallowOrders(cached: Order[], fresh: Order[]): Order[] {
  const keyOf = (o: Order) => String(o.id || o.orderSn || '').trim();
  const freshByKey = new Map<string, Order>();
  const newOrders: Order[] = [];
  const cachedKeys = new Set(cached.map((o) => keyOf(o)).filter(Boolean));

  for (const o of fresh) {
    const k = keyOf(o);
    if (!k) continue;
    freshByKey.set(k, o);
    if (!cachedKeys.has(k)) newOrders.push(o);
  }

  const lifecycleRank = (o: Order): number => {
    const raw = String(o.shopee_order_status || '').toUpperCase();
    const st = String(o.status || '');
    if (raw === 'COMPLETED' || st === 'completed') return 100;
    if (raw === 'SHIPPED' || raw === 'TO_CONFIRM_RECEIVE' || st === 'shipping') return 90;
    if (
      raw === 'CANCELLED' ||
      raw === 'IN_CANCEL' ||
      raw === 'TO_RETURN' ||
      st === 'cancelled' ||
      st === 'return_pending' ||
      st === 'return_received'
    ) {
      return 80;
    }
    if (raw === 'PROCESSED' || st === 'processed') return 50;
    if (raw === 'READY_TO_SHIP' || raw === 'RETRY_SHIP' || st === 'unprocessed') return 40;
    return 0;
  };

  const preferProgress = (prev: Order, next: Order): Order => {
    if (lifecycleRank(prev) <= lifecycleRank(next)) return next;
    return {
      ...next,
      shopee_order_status: prev.shopee_order_status || next.shopee_order_status,
      status: prev.status || next.status,
      logistics_status: prev.logistics_status || next.logistics_status,
    };
  };

  const preserveHandover = (prev: Order, next: Order): Order => {
    const progressed = preferProgress(prev, next);
    const prevHanded =
      prev.is_handed_over === true ||
      prev.isHandedOverToCarrier === true ||
      String(prev.local_status || prev.localStatus || prev.internal_status || '').toUpperCase() ===
        'HANDED_OVER';
    const nextHanded =
      progressed.is_handed_over === true ||
      progressed.isHandedOverToCarrier === true ||
      String(
        progressed.local_status || progressed.localStatus || progressed.internal_status || '',
      ).toUpperCase() === 'HANDED_OVER';
    if (!prevHanded || nextHanded) return progressed;
    return {
      ...progressed,
      is_handed_over: true,
      isHandedOverToCarrier: true,
      is_handed_over_to_carrier: true,
      is_handed_over_to_courier: true,
      local_status: prev.local_status || 'HANDED_OVER',
      localStatus: prev.localStatus || 'HANDED_OVER',
      internal_status: prev.internal_status || 'HANDED_OVER',
      handedOverAt: progressed.handedOverAt || prev.handedOverAt,
      handedOverSource: progressed.handedOverSource || prev.handedOverSource,
      handed_over_source: progressed.handed_over_source || prev.handed_over_source,
    };
  };

  const updatedCached = cached.map((o) => {
    const k = keyOf(o);
    const f = k ? freshByKey.get(k) : undefined;
    return f ? preserveHandover(o, { ...o, ...f }) : o;
  });

  return sanitizeOrders([...newOrders, ...updatedCached]);
}

const MAIN_NAV_TABS = new Set([
  'dashboard',
  'products',
  'publish',
  'orders',
  'picking',
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
  'return_requests',
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
  'yeu-cau-tra-hang': 'all',
  'return_requests': 'all',
  'don-huy-hoan': 'cancel_returns',
  'da-nhan-huy-hoan': 'received_cancel_returns',
};

function normalizeOrdersSubTab(raw: string | null | undefined): OrdersSubTabId | null {
  if (!raw) return null;
  const key = String(raw).trim();
  if (!key) return null;
  if (ORDERS_SUB_TAB_ALIASES[key]) return ORDERS_SUB_TAB_ALIASES[key];
  if (key === 'pending_verification') return 'pending_confirm';
  if (key === 'return_requests' || key === 'yeu-cau-tra-hang') return 'all';
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

function resolveOrdersFetchKindFromUrl(): string {
  if (typeof window === 'undefined') return '';
  try {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('cancelTab') || readSessionTab('omni_cancel_tab') || '';
    if (raw === 'refund_return' || raw === 'cancelled' || raw === 'failed_delivery') return raw;
  } catch {
    /* ignore */
  }
  return '';
}

/** Mobile viewport — khớp breakpoint Tailwind `md` (768px). */
function isMobileViewport(): boolean {
  if (typeof window === 'undefined') return false;
  return window.innerWidth < 768;
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

  // Mobile vào root `/` (không có ?tab=) → mặc định Quản lý đơn hàng
  const isBareRoot =
    path === '/' && !qTab && !params.get('ordersTab') && !params.get('subtab');
  if (isBareRoot && isMobileViewport()) {
    return 'orders';
  }

  const stored = readSessionTab('omni_active_tab');
  if (stored && MAIN_NAV_TABS.has(stored)) return stored;

  // PC: Tổng quan · Mobile: Quản lý đơn hàng
  return isMobileViewport() ? 'orders' : 'dashboard';
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

function normalizeShopIdsParam(shopIds?: string[], shopId?: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (v: unknown) => {
    const s = String(v || '').trim();
    if (!s || s === 'all' || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  if (Array.isArray(shopIds)) {
    for (const v of shopIds) push(v);
  }
  push(shopId);
  return out.sort();
}

function sortOrdersNewestFirst(list: Order[]): Order[] {
  return sortOrdersByCreatedAtDesc(list);
}

/** Gộp nhiều batch đơn (Promise.all đa shop) → 1 mảng, sort mới nhất trước. */
function mergeOrderBatchesNewestFirst(batches: Order[][]): Order[] {
  const byId = new Map<string, Order>();
  for (const batch of batches) {
    for (const o of batch) {
      const id = String(o?.id || o?.orderSn || '').trim();
      if (!id) continue;
      const prev = byId.get(id);
      if (!prev) {
        byId.set(id, o);
        continue;
      }
      const prevT = orderCreatedAtMs(prev);
      const nextT = orderCreatedAtMs(o);
      if (nextT >= prevT) byId.set(id, o);
    }
  }
  return sortOrdersNewestFirst([...byId.values()]);
}

type OrdersRefreshPayload = {
  success?: boolean;
  data?: Order[];
  error?: string;
  total?: number;
  totalPages?: number;
  currentPage?: number;
  page?: number;
  page_size?: number;
  limit?: number;
  has_more?: boolean;
  hasMore?: boolean;
  counters?: { total?: number; returned?: number; cancelled?: number; rts?: number };
};

type OrderCounters = { total: number; returned: number; cancelled: number; rts: number };

function emptyOrderCounters(): OrderCounters {
  return { total: 0, returned: 0, cancelled: 0, rts: 0 };
}

function sumOrderCounters(list: Array<OrderCounters | undefined | null>): OrderCounters {
  const out = emptyOrderCounters();
  for (const c of list) {
    out.total += Number(c?.total) || 0;
    out.returned += Number(c?.returned) || 0;
    out.cancelled += Number(c?.cancelled) || 0;
    out.rts += Number(c?.rts) || 0;
  }
  return out;
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
  const EMPTY_ORDERS_META = {
    page: 1,
    pageSize: 50,
    total: 0,
    totalPages: 1,
    hasMore: false,
    counters: { total: 0, returned: 0, cancelled: 0, rts: 0 },
  };
  const [ordersMeta, setOrdersMeta] = useState(EMPTY_ORDERS_META);
  /** Tab/kind đã apply gần nhất — OrderManager dùng để ẩn Filter/Pagination khi data lệch tab. */
  const [ordersAppliedTab, setOrdersAppliedTab] = useState('');
  const [ordersAppliedKind, setOrdersAppliedKind] = useState('');
  /** true chỉ sau khi ĐÃ có ít nhất 1 response thành công (success:true) từ
   * /api/orders/refresh — dùng để phân biệt "chưa tải xong lần đầu" (phải hiện
   * loading) với "đã tải xong và THẬT SỰ không có đơn nào" (mới hiện "0 đơn").
   * Tránh tình trạng F5 xong màn hình chớp "0 đơn" trước khi request đầu tiên
   * kịp chạy xong (silent fetch không set ordersLoading nên trước đây dễ lộ
   * trạng thái rỗng giả trong lúc chờ token verify + bootstrap chạy). */
  const [hasLoadedOrdersOnce, setHasLoadedOrdersOnce] = useState<boolean>(false);
  const [productsLoading, setProductsLoading] = useState<boolean>(false);
  /** Toast kết quả dò ngầm Backend (sống sót khi rời tab Đơn hàng). */
  const [scanBgToast, setScanBgToast] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [scanBgPendingCount, setScanBgPendingCount] = useState(0);
  const scanBgToastTimerRef = useRef<number | null>(null);
  /** Làm mới ngầm khi quay lại tab trình duyệt — không trigger Shopee sync. */
  const [backgroundRefreshing, setBackgroundRefreshing] = useState(false);
  const lastFocusRefreshAtRef = useRef(0);
  /** Sequence guard — tránh race-condition khi polling 15s + click thủ công/focus refresh
   * chạy gần nhau: chỉ response của request MỚI NHẤT được ghi vào state, response của
   * request cũ hơn (dù trả về sau) sẽ bị bỏ qua thay vì ghi đè mất dữ liệu vừa cập nhật. */
  const fetchOrdersSeqRef = useRef(0);
  /** Seq của lần APPLY (setOrders) thành công gần nhất — KHÔNG dùng fetchOrdersSeqRef
   * (seq của lần "phát" request mới nhất) để so sánh: nếu không, một request cũ hơn
   * đang chờ Mongo sẵn sàng (retry mongodb_not_ready) mà cuối cùng LẤY ĐƯỢC dữ liệu
   * thật sẽ luôn bị coi là "cũ" và bị vứt bỏ chỉ vì có request mới hơn đã được PHÁT ra
   * (kể cả khi request mới đó chưa xong hoặc cũng thất bại) — đây chính là nguyên nhân
   * phải bấm "Làm mới" 2-3 lần mới thấy dữ liệu sau khi Ctrl+F5. */
  const lastAppliedOrdersSeqRef = useRef(0);
  /** Tab đã apply gần nhất — chặn silent fetch không ?tab= đè list Đơn Hủy/Hoàn. */
  const lastAppliedOrdersTabRef = useRef('');
  /** Kind Hủy/Hoàn đã apply gần nhất — chặn silent không ?kind= đè sub-tab. */
  const lastAppliedOrdersKindRef = useRef('');
  /** Scope request mới nhất (tab+kind+q) — response lệch scope bị bỏ. */
  const latestOrdersScopeRef = useRef({ tab: '', kind: '', q: '', seq: 0 });
  /** Chỉ cho phép một lần đọc cùng mode (full / shallow) đang chạy để polling/focus/click không
   * tạo nhiều truy vấn MongoDB nặng đồng thời. */
  const fetchOrdersInFlightRef = useRef<{ key: string; promise: Promise<void> } | null>(null);
  const fetchOrdersAbortRef = useRef<AbortController | null>(null);
  /** Khóa mạng — cùng flightKey dedupe; ĐỔI tab → xếp hàng + invalidate seq (KHÔNG abort spam Mongo). */
  const isFetchingRef = useRef(false);
  const pendingFetchOptsRef = useRef<Record<string, unknown> | null>(null);
  /** Chống spam: tối thiểu 300ms giữa 2 lần BẮT ĐẦU refresh thật. */
  const lastOrdersFetchStartAtRef = useRef(0);
  const pendingFetchTimerRef = useRef<number | null>(null);
  /** Số fetch non-silent đang chạy — finally LUÔN giảm, tránh kẹt spinner khi bị abort. */
  const fetchOrdersNonSilentInFlightRef = useRef(0);
  /** Snapshot cache hydrate — tránh merge shallow đè mất cache khi setState chưa flush. */
  const ordersHydrateRef = useRef<Order[]>([]);
  /** Cache tạm theo tab (SWR): chuyển lại tab cũ → hiện data cũ, không màn hình trắng. */
  type OrdersTabCacheEntry = {
    orders: Order[];
    meta: {
      page: number;
      pageSize: number;
      total: number;
      totalPages: number;
      hasMore: boolean;
      counters: { total: number; returned: number; cancelled: number; rts: number };
    };
    at: number;
  };
  const ordersTabCacheRef = useRef<Map<string, OrdersTabCacheEntry>>(new Map());
  const MAX_ORDERS_TAB_CACHE = 12;

  /** Xóa list + meta trước fetch tab mới — chống hiển thị stale data khi loading. */
  const prepareOrdersListFetch = useCallback(() => {
    setOrders([]);
    setOrdersMeta(EMPTY_ORDERS_META);
    setOrdersAppliedTab('');
    setOrdersAppliedKind('');
    setOrdersLoading(true);
  }, []);
  /** Từ khóa search Kho SP chính — giữ qua phân trang / focus refresh. */
  const productsSearchRef = useRef('');
  /** Sequence guard — tránh response search cũ ghi đè kết quả mới hơn. */
  const fetchProductsSeqRef = useRef(0);
  const fetchProductsAbortRef = useRef<AbortController | null>(null);

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
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [focusScanner, setFocusScanner] = useState<boolean>(false);
  const [ordersSubTabHint, setOrdersSubTabHint] = useState<OrdersSubTabId | null>(() =>
    resolveOrdersSubTabFromUrl(),
  );
  // Mobile: tab 'products' có 2 màn — Kiểm hàng (audit) và Danh sách sản phẩm (list).
  const [mobileProductsView, setMobileProductsView] = useState<'audit' | 'list'>('audit');
  
  // Selected products for bulk editing
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  /** Mở Quét mã: nếu list tab đang rỗng nhưng hydrate còn data → khôi phục pool fallback (không đụng filter list). */
  useEffect(() => {
    if (!focusScanner) return;
    if (orders.length > 0) return;
    const hydrated = ordersHydrateRef.current;
    if (Array.isArray(hydrated) && hydrated.length > 0) {
      setOrders(hydrated);
    }
  }, [focusScanner, orders.length]);

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
  // Mobile + root `/` không có ?tab= → redirect sang Quản lý đơn hàng
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const path = window.location.pathname.replace(/\/$/, '') || '/';
    if (path === '/picking') {
      writeSessionTab('omni_active_tab', 'picking');
      return;
    }

    const params = new URLSearchParams(window.location.search);
    const hasExplicitTab =
      Boolean(params.get('tab')) ||
      Boolean(params.get('ordersTab')) ||
      Boolean(params.get('subtab'));
    let tab = activeTab;
    if (path === '/' && !hasExplicitTab && isMobileViewport()) {
      tab = 'orders';
      if (activeTab !== 'orders') setActiveTab('orders');
    }

    const sub = tab === 'orders' ? ordersSubTabHint || resolveOrdersSubTabFromUrl() : null;
    const nextUrl = buildNavUrl(tab, sub);
    const cur = `${window.location.pathname}${window.location.search}`;
    if (cur !== nextUrl) {
      window.history.replaceState({ tab, ordersTab: sub }, '', nextUrl);
    }
    writeSessionTab('omni_active_tab', tab);
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

  // Token Verification on Mount — chỉ xóa token khi server trả 401 (token thật sự invalid).
  useEffect(() => {
    let cancelled = false;

    const applyLocalAuthBypass = (token: string): boolean => {
      if (!isJwtLocallyValid(token)) return false;
      const payload = decodeJwtPayload(token);
      if (!payload?.username) return false;
      setIsAuthenticated(true);
      setAdminUser(payload.username);
      return true;
    };

    const retryVerifyInBackground = (token: string, attempt = 1) => {
      if (cancelled || attempt > 3) return;
      const delayMs = attempt * 5000;
      window.setTimeout(async () => {
        if (cancelled) return;
        try {
          const response = await fetch('/api/auth/verify', {
            method: 'GET',
            headers: { Authorization: `Bearer ${token}` },
          });
          if (cancelled) return;
          if (response.ok) {
            const data = await response.json();
            setIsAuthenticated(true);
            setAdminUser(data.username);
          } else if (response.status === 401) {
            safeRemoveItem('admin_token');
            setIsAuthenticated(false);
            setAdminUser('');
          } else {
            retryVerifyInBackground(token, attempt + 1);
          }
        } catch {
          if (!cancelled) retryVerifyInBackground(token, attempt + 1);
        }
      }, delayMs);
    };

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
            Authorization: `Bearer ${token}`,
          },
        });

        if (response.ok) {
          const data = await response.json();
          setIsAuthenticated(true);
          setAdminUser(data.username);
        } else if (response.status === 401) {
          safeRemoveItem('admin_token');
          setIsAuthenticated(false);
          setAdminUser('');
        } else {
          console.warn(
            `[Auth] Verify HTTP ${response.status} — giữ token, thử bypass local nếu còn hạn.`,
          );
          if (!applyLocalAuthBypass(token)) {
            setIsAuthenticated(false);
          } else {
            retryVerifyInBackground(token);
          }
        }
      } catch (err) {
        console.error('Auth verification error (network/backend):', err);
        if (!applyLocalAuthBypass(token)) {
          setIsAuthenticated(false);
        } else {
          retryVerifyInBackground(token);
        }
      } finally {
        setAuthChecking(false);
      }
    };

    verifyToken();
    return () => {
      cancelled = true;
    };
  }, []);

  // Fetch orders: Mongo-only pagination (default limit=50, replace — không shallow merge).
  const fetchOrders = useCallback(async (opts?: {
    silent?: boolean;
    bustCache?: boolean;
    retriesLeft?: number;
    limit?: number;
    merge?: boolean;
    page?: number;
    print_status?: 'printed' | 'unprinted' | 'all' | '';
    /** Cùng filter với /api/orders/counter — tránh badge ≠ list. */
    tab?: string;
    /** Search toàn collection — không kẹp tab. */
    q?: string;
    /** Sub-tab Hủy/Hoàn: refund_return | cancelled | failed_delivery */
    kind?: string;
    startDate?: string;
    endDate?: string;
    /** Bỏ qua dedupe in-flight (vd: tab vừa visible lại sau đóng băng). */
    force?: boolean;
    /** Trả lỗi về caller thay vì giữ im lặng và chỉ retry nền. */
    throwOnError?: boolean;
    /** Hủy từ useEffect cleanup — không abort ngay lúc render. */
    signal?: AbortSignal;
    shopId?: string;
    shopIds?: string[];
  }) => {
    const token = localStorage.getItem('admin_token');
    if (!token) {
      if (opts?.throwOnError) throw new Error('Phiên đăng nhập không hợp lệ.');
      return;
    }

    const callerSignal = opts?.signal;
    if (callerSignal?.aborted) return;

    const silent = Boolean(opts?.silent);
    const bustCache = Boolean(opts?.bustCache);
    // ERP list: mặc định 50/trang. Caller có thể tăng (vd: quét mã merge).
    const limit =
      typeof opts?.limit === 'number' && opts.limit > 0 ? opts.limit : 50;
    const page = typeof opts?.page === 'number' && opts.page > 0 ? opts.page : 1;
    // Mặc định REPLACE — bỏ shallow merge nặng (Backend trả list đã lọc theo tab).
    const merge = opts?.merge === true;
    const printStatus = String(opts?.print_status || '').trim().toLowerCase();
    const tab = String(opts?.tab || '').trim().toLowerCase();
    const q = String(opts?.q || '').trim();
    const kind = String(opts?.kind || '').trim().toLowerCase();
    const startDate = String(opts?.startDate || '').trim();
    const endDate = String(opts?.endDate || '').trim();
    const shopIds = normalizeShopIdsParam(opts?.shopIds, opts?.shopId);
    const shopKey = shopIds.join(',') || 'all';
    const force = Boolean(opts?.force);
    const flightKey = `page:${page}|limit:${limit}|print:${printStatus || 'all'}|tab:${tab || 'all'}|q:${q || ''}|kind:${kind || 'all'}|shops:${shopKey}|from:${startDate || ''}|to:${endDate || ''}`;
    const tabCacheKey = `tab:${tab || 'all'}|kind:${kind || 'all'}|q:${q || ''}|shops:${shopKey}|from:${startDate || ''}|to:${endDate || ''}|page:${page}|limit:${limit}`;

    /** SWR sớm: đổi sub-tab hiện cache ngay (kể cả khi fetch đang xếp hàng) — không spinner trắng. */
    let usedTabCache = false;
    if (!silent && !merge) {
      const cached = ordersTabCacheRef.current.get(tabCacheKey);
      if (cached && Array.isArray(cached.orders)) {
        usedTabCache = true;
        setOrders(cached.orders);
        setOrdersMeta(cached.meta);
        ordersHydrateRef.current = cached.orders;
        lastAppliedOrdersTabRef.current = tab;
        lastAppliedOrdersKindRef.current = kind;
        setOrdersAppliedTab(tab);
        setOrdersAppliedKind(kind);
        setHasLoadedOrdersOnce(true);
        setOrdersLoading(false);
      }
    }

    if (!silent && !merge && !usedTabCache) {
      setOrders([]);
      setOrdersMeta(EMPTY_ORDERS_META);
      setOrdersAppliedTab('');
      setOrdersAppliedKind('');
    }

    // Silent không được hủy request đang hiện spinner (P0 race: bootstrap abort tab fetch).
    if (silent && !force && fetchOrdersNonSilentInFlightRef.current > 0) {
      return fetchOrdersInFlightRef.current?.promise;
    }
    // Silent khác tab/key không được abort fetch tab đang chạy (Đơn Hủy/Hoàn bị trống).
    if (silent && !force && fetchOrdersInFlightRef.current && fetchOrdersInFlightRef.current.key !== flightKey) {
      return fetchOrdersInFlightRef.current.promise;
    }
    // Silent không ?tab= không được REPLACE list đã lọc theo tab.
    if (silent && !force && !tab && !q && lastAppliedOrdersTabRef.current) {
      return fetchOrdersInFlightRef.current?.promise;
    }
    // Silent lệch tab/kind không được đè sub-tab Đơn Hủy / Đơn Hoàn.
    if (silent && !force && !q && lastAppliedOrdersTabRef.current && tab !== lastAppliedOrdersTabRef.current) {
      return fetchOrdersInFlightRef.current?.promise;
    }
    if (silent && !force && !q && lastAppliedOrdersKindRef.current && kind !== lastAppliedOrdersKindRef.current) {
      return fetchOrdersInFlightRef.current?.promise;
    }

    // Cùng flightKey đang chạy — tái sử dụng, không abort.
    if (fetchOrdersInFlightRef.current?.key === flightKey) {
      return fetchOrdersInFlightRef.current.promise;
    }
    // Đang fetch khác scope: XẾP HÀNG 1 lệnh mới nhất + invalidate seq ngay (chống race đè tab).
    // CẤM abort/gọi chồng — abort spam khiến Mongo trên cPanel chạy song song → CPU 100%.
    if (isFetchingRef.current) {
      pendingFetchOptsRef.current = (opts || {}) as Record<string, unknown>;
      const invalidateSeq = ++fetchOrdersSeqRef.current;
      latestOrdersScopeRef.current = { tab, kind, q, seq: invalidateSeq };
      return fetchOrdersInFlightRef.current?.promise;
    }

    // Rate-limit: gộp các lần gọi dồn trong 300ms thành 1 request (chống loop useEffect).
    const nowStart = Date.now();
    const elapsed = nowStart - lastOrdersFetchStartAtRef.current;
    if (!force && elapsed < 300) {
      pendingFetchOptsRef.current = (opts || {}) as Record<string, unknown>;
      const invalidateSeq = ++fetchOrdersSeqRef.current;
      latestOrdersScopeRef.current = { tab, kind, q, seq: invalidateSeq };
      if (pendingFetchTimerRef.current == null) {
        pendingFetchTimerRef.current = window.setTimeout(() => {
          pendingFetchTimerRef.current = null;
          const queued = pendingFetchOptsRef.current;
          pendingFetchOptsRef.current = null;
          if (queued && !isFetchingRef.current) {
            void fetchOrders(queued as typeof opts);
          }
        }, 300 - elapsed);
      }
      return;
    }

    isFetchingRef.current = true;
    lastOrdersFetchStartAtRef.current = nowStart;

    const controller = new AbortController();
    fetchOrdersAbortRef.current = controller;
    // callerSignal chỉ bỏ apply nếu đã hủy — KHÔNG gắn abort HTTP (tránh storm Mongo).
    if (callerSignal?.aborted) {
      isFetchingRef.current = false;
      if (fetchOrdersAbortRef.current === controller) fetchOrdersAbortRef.current = null;
      return;
    }

    let finishInFlight: (() => void) | undefined;
    const inFlight = new Promise<void>((resolve) => {
      finishInFlight = resolve;
    });
    fetchOrdersInFlightRef.current = { key: flightKey, promise: inFlight };

    // MongoDB kết nối NGẦM sau khi Node app khởi động (không block listen) — ngay sau
    // restart, vài giây đầu isMongoReady() có thể còn false. Tự retry thay vì để
    // danh sách đơn hàng trống vĩnh viễn cho tới khi người dùng bấm "Làm mới".
    const retriesLeft = opts?.retriesLeft ?? 4;
    const requestId = ++fetchOrdersSeqRef.current;
    latestOrdersScopeRef.current = { tab, kind, q, seq: requestId };
    let requestTimeoutId: number | undefined;
    let didIncNonSilent = false;
    let aborted = false;
    try {
      if (!silent) {
        fetchOrdersNonSilentInFlightRef.current += 1;
        didIncNonSilent = true;
        // Có cache tab → tắt spinner (hiện data cũ); chưa có → spinner full-page.
        setOrdersLoading(!usedTabCache);
      }
      // Refresh chỉ đọc MongoDB nội bộ, không gọi Shopee API.
      const authHeaders = {
        Authorization: `Bearer ${token}`,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
        'If-Modified-Since': '0',
      };
      const retrySameFetch = () => {
        if (requestId !== fetchOrdersSeqRef.current) return;
        void fetchOrders({
          silent,
          bustCache,
          limit,
          merge,
          page,
          tab,
          q,
          kind,
          startDate: startDate || undefined,
          endDate: endDate || undefined,
          shopIds: shopIds.length ? shopIds : undefined,
          retriesLeft: retriesLeft - 1,
        });
      };
      const fetchRefreshForShops = async (ids: string[]): Promise<OrdersRefreshPayload> => {
        const params = new URLSearchParams();
        params.set('page', String(page));
        params.set('limit', String(limit));
        if (bustCache) {
          params.set('t', String(Date.now()));
          params.set('bust', '1');
        }
        if (printStatus && printStatus !== 'all') params.set('print_status', printStatus);
        if (ids.length === 1) params.set('shop_id', ids[0]);
        else if (ids.length > 1) params.set('shop_ids', ids.join(','));
        if (q) {
          params.set('q', q);
        } else if (tab) {
          params.set('tab', tab);
          if (kind) params.set('kind', kind);
        }
        if (startDate) params.set('startDate', startDate);
        if (endDate) params.set('endDate', endDate);
        const path = `/api/orders/refresh?${params.toString()}`;
        console.log(
          `[FRONTEND FETCHED] GET ${path} (silent=${silent} merge=${merge} tab=${tab || '(none)'} shops=${ids.join(',') || '(all)'})`,
        );
        const response = await fetch(path, {
          method: 'GET',
          cache: 'no-store',
          signal: controller.signal,
          headers: authHeaders,
        });
        if (!response.ok) {
          return { success: false, data: [], error: `http_${response.status}`, total: 0 };
        }
        const payload = (await response.json()) as OrdersRefreshPayload;
        return payload && typeof payload === 'object' ? payload : { success: false, data: [] };
      };
      if (
        typeof window !== 'undefined' &&
        /quanly\.linhkienamthanh\.net|linhkienamthanh\.net|vercel\.app/i.test(window.location.hostname)
      ) {
        console.warn(
          '⚠️ Đang mở PRODUCTION/REMOTE — refresh đang lấy dữ liệu MongoDB trên server thật.',
        );
      }
      requestTimeoutId = window.setTimeout(() => controller.abort(), 22_000);
      // Một request shop_ids=$in (Promise.all 1 phần tử) — tránh N query song song treo pending.
      const payloads = await Promise.all([fetchRefreshForShops(shopIds)]);
      if (controller.signal.aborted || callerSignal?.aborted) {
        aborted = true;
        return;
      }
      const retryPayload = payloads.find(
        (p) =>
          p?.success === false &&
          (p.error === 'mongodb_not_ready' || p.error === 'orders_refresh_failed'),
      );
      const okPayloads = payloads.filter((p) => p && p.success !== false);
      if (okPayloads.length === 0 && retryPayload && retriesLeft > 0) {
        console.warn(
          `[Fetch Orders] Refresh lỗi tạm thời (${retryPayload.error}) — thử lại sau 3s (còn ${retriesLeft} lần).`,
        );
        window.setTimeout(retrySameFetch, 3000);
        return;
      }
      if (okPayloads.length === 0) {
        const httpFail = payloads.find((p) => String(p?.error || '').startsWith('http_'));
        if (httpFail && retriesLeft > 0 && requestId === fetchOrdersSeqRef.current) {
          window.setTimeout(retrySameFetch, 3000);
          return;
        }
        if (opts?.throwOnError) {
          throw new Error(
            retryPayload?.error || httpFail?.error || 'Làm mới danh sách đơn hàng thất bại.',
          );
        }
        setHasLoadedOrdersOnce(true);
        console.warn('[Fetch Orders] Refresh failed; giữ nguyên danh sách hiện tại.');
        return;
      }
      let mergedData: Order[] = [];
      okPayloads.forEach((res) => {
        const data = Array.isArray(res.data) ? res.data : [];
        mergedData = [...mergedData, ...data];
      });
      const sanitized = mergeOrderBatchesNewestFirst([sanitizeOrders(mergedData)]);
      const total = okPayloads.reduce((sum, p) => sum + (Number(p.total) || 0), 0);
      const pageSize = Number(okPayloads[0]?.page_size ?? okPayloads[0]?.limit) || limit;
      const totalPages = Math.max(
        1,
        ...okPayloads.map((p) => Number(p.totalPages) || 0),
        Math.ceil(Math.max(0, total) / pageSize) || 1,
      );
      const currentPage =
        Number(okPayloads[0]?.currentPage ?? okPayloads[0]?.page) > 0
          ? Number(okPayloads[0]?.currentPage ?? okPayloads[0]?.page)
          : page;
      const counters = sumOrderCounters(
        okPayloads.map((p) => ({
          total: Number(p.counters?.total) || 0,
          returned: Number(p.counters?.returned) || 0,
          cancelled: Number(p.counters?.cancelled) || 0,
          rts: Number(p.counters?.rts) || 0,
        })),
      );
      console.log(
        '🛑 DATA ĐƯỢC LẤY TỪ URL: Promise.all shops=',
        shopIds.join(',') || '(all)',
        '- SỐ LƯỢNG:',
        sanitized.length,
      );
      if (controller.signal.aborted || callerSignal?.aborted) {
        aborted = true;
        return;
      }
      if (requestId !== fetchOrdersSeqRef.current) return;
      const latestScope = latestOrdersScopeRef.current;
      if (
        latestScope.seq !== requestId ||
        latestScope.tab !== tab ||
        latestScope.kind !== kind ||
        latestScope.q !== q
      ) {
        return;
      }
      lastAppliedOrdersSeqRef.current = requestId;
      lastAppliedOrdersTabRef.current = tab;
      lastAppliedOrdersKindRef.current = kind;
      setOrdersAppliedTab(tab);
      setOrdersAppliedKind(kind);
      const nextMeta = {
        page: currentPage,
        pageSize,
        total,
        totalPages,
        hasMore:
          okPayloads.some((p) => Boolean(p.has_more ?? p.hasMore)) || currentPage < totalPages,
        counters: {
          total: counters.total || (kind ? 0 : total) || 0,
          returned: counters.returned,
          cancelled: counters.cancelled,
          rts: counters.rts,
        },
      };
      setOrdersMeta(nextMeta);
      // Thành công: setOrders ĐÚNG 1 LẦN sau khi gộp + sort — không đè từng shop.
      if (merge) {
        setOrders((prev) => {
          const base = prev.length > 0 ? prev : ordersHydrateRef.current;
          const merged = mergeOrderBatchesNewestFirst([mergeShallowOrders(base, sanitized)]);
          ordersHydrateRef.current = merged;
          void saveOrdersCache(merged);
          return merged;
        });
      } else {
        const isRealEmpty = sanitized.length === 0 && Number(total) === 0;
        const cacheMap = ordersTabCacheRef.current;
        if (sanitized.length > 0) {
          setOrders(sanitized);
          ordersHydrateRef.current = sanitized;
          void saveOrdersCache(sanitized);
          cacheMap.set(tabCacheKey, { orders: sanitized, meta: nextMeta, at: Date.now() });
        } else if (isRealEmpty) {
          // Tab list thật sự rỗng — chỉ clear UI list, KHÔNG phá hydrate (scanner/picking fallback).
          setOrders([]);
          cacheMap.set(tabCacheKey, { orders: [], meta: nextMeta, at: Date.now() });
        }
        // sanitized=[] nhưng total>0 (race/lỗi trang): không đè list/cache.
        if (cacheMap.size > MAX_ORDERS_TAB_CACHE) {
          let oldestKey = '';
          let oldestAt = Number.POSITIVE_INFINITY;
          for (const [k, v] of cacheMap) {
            if (v.at < oldestAt) {
              oldestAt = v.at;
              oldestKey = k;
            }
          }
          if (oldestKey) cacheMap.delete(oldestKey);
        }
      }
      setHasLoadedOrdersOnce(true);
      console.log(
        `[FRONTEND FETCHED] /api/orders/refresh OK — số đơn: ${sanitized.length}` +
          `${merge ? ' (merge)' : ' (replace page ' + page + ')'} shops=${shopIds.join(',') || '(all)'}`,
      );
    } catch (err) {
      aborted =
        (err instanceof DOMException && err.name === 'AbortError') ||
        (err instanceof Error && err.name === 'AbortError') ||
        (typeof err === 'object' && err !== null && (err as { name?: string }).name === 'AbortError');
      if (aborted || (err as { name?: string })?.name === 'AbortError') {
        aborted = true;
        // AbortError: KHÔNG retry — tránh vòng lặp abort→retry→abort đốt CPU cPanel.
        return;
      }
      console.error('[FRONTEND FETCHED] /api/orders/refresh THẤT BẠI:', err);
      if (opts?.throwOnError) throw err;
      if (retriesLeft > 0 && requestId === fetchOrdersSeqRef.current) {
        window.setTimeout(() => {
          void fetchOrders({
            silent,
            bustCache,
            limit,
            merge,
            page,
            tab,
            q,
            kind,
            startDate: startDate || undefined,
            endDate: endDate || undefined,
            shopIds: shopIds.length ? shopIds : undefined,
            retriesLeft: retriesLeft - 1,
          });
        }, 3000);
      } else {
        setHasLoadedOrdersOnce(true);
      }
    } finally {
      if (requestTimeoutId !== undefined) window.clearTimeout(requestTimeoutId);
      if (didIncNonSilent) {
        fetchOrdersNonSilentInFlightRef.current = Math.max(
          0,
          fetchOrdersNonSilentInFlightRef.current - 1,
        );
      }
      // Mọi nhánh (OK / lỗi / abort / early-return trong try) đều tắt spinner.
      if (fetchOrdersNonSilentInFlightRef.current === 0) {
        setOrdersLoading(false);
      }
      const stillOwner = fetchOrdersInFlightRef.current?.promise === inFlight;
      if (stillOwner) {
        fetchOrdersInFlightRef.current = null;
      }
      if (fetchOrdersAbortRef.current === controller) {
        fetchOrdersAbortRef.current = null;
      }
      finishInFlight?.();
      // Chỉ owner mới mở khóa + chạy pending — tránh abort+supersede làm clear nhầm request mới.
      if (stillOwner) {
        isFetchingRef.current = false;
        const queued = pendingFetchOptsRef.current;
        pendingFetchOptsRef.current = null;
        if (queued) {
          void fetchOrders(queued as typeof opts);
        }
      }
    }
  }, []);

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
    search?: string;
  }) => {
    const token = localStorage.getItem('admin_token');
    if (!token) return;

    const forceRefresh = !!opts?.forceRefresh;
    const page = Math.max(1, opts?.page ?? 1);
    const pageSize = Math.min(50, Math.max(1, opts?.pageSize ?? 50));
    const append = !!opts?.append;
    const silent = Boolean(opts?.silent);
    if (opts && Object.prototype.hasOwnProperty.call(opts, 'search')) {
      productsSearchRef.current = String(opts.search ?? '').replace(/\s+/g, ' ').trim();
    }
    const searchQ = productsSearchRef.current;

    const seq = ++fetchProductsSeqRef.current;
    fetchProductsAbortRef.current?.abort();

    if (!silent) setProductsLoading(true);
    const maxAttempts = forceRefresh ? 3 : 2;
    let lastErr: unknown = null;
    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (seq !== fetchProductsSeqRef.current) return;
        const controller = new AbortController();
        fetchProductsAbortRef.current = controller;
        try {
          // Khớp timeout backend 30s — cPanel/Mongo cold-start cần thêm thời gian.
          const timeoutId = window.setTimeout(() => controller.abort(), 30_000);
          // Chỉ đọc trực tiếp DB Kho gốc theo trang (page/pageSize/search), không tải cả kho.
          const params = new URLSearchParams({
            page: String(page),
            pageSize: String(pageSize),
            t: String(Date.now()),
          });
          // Luôn gửi search (kể cả rỗng) để backend và FE đồng bộ tham số.
          params.set('search', searchQ);
          const response = await fetch(`/api/products?${params.toString()}`, {
            method: 'GET',
            cache: 'no-store',
            signal: controller.signal,
            headers: {
              Authorization: `Bearer ${token}`,
              'Cache-Control': 'no-cache',
              Pragma: 'no-cache',
            },
          });
          window.clearTimeout(timeoutId);
          if (seq !== fetchProductsSeqRef.current) return;
          if (!response.ok) throw new Error('Không thể đọc dữ liệu Kho gốc từ Database.');

          const data = await response.json();
          if (seq !== fetchProductsSeqRef.current) return;
          if (Array.isArray(data)) {
            setProducts(data);
            setProductsMeta({ page: 1, pageSize: data.length, total: data.length, totalPages: 1, hasMore: false });
            return;
          }
          if (data?.success === false) {
            throw new Error(data?.message || data?.error || 'products_unavailable');
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
          return;
        } catch (err) {
          if (seq !== fetchProductsSeqRef.current) return;
          const aborted = err instanceof DOMException && err.name === 'AbortError';
          if (aborted) return;
          lastErr = err;
          console.warn(`[Fetch Products] attempt ${attempt}/${maxAttempts} failed:`, err);
          if (attempt < maxAttempts) {
            await new Promise((r) => window.setTimeout(r, 1500 * attempt));
          }
        }
      }
      if (seq !== fetchProductsSeqRef.current) return;
      console.error('Fetch products error:', lastErr);
      // Lỗi mạng/Mongo không đồng nghĩa kho thật rỗng. Giữ danh sách hiện có.
      // Chỉ ném lỗi khi caller chủ động forceRefresh (vd: sau khởi tạo kho).
      if (forceRefresh) throw lastErr;
    } finally {
      if (seq === fetchProductsSeqRef.current && !silent) setProductsLoading(false);
    }
  };

  const resolveOrdersFetchTab = useCallback((): string => {
    if (activeTab !== 'orders') return '';
    const hint = String(ordersSubTabHint || '').trim().toLowerCase();
    if (!hint || hint === 'all' || hint === 'order_products') {
      return '';
    }
    return hint;
  }, [activeTab, ordersSubTabHint]);

  const resolveOrdersFetchKind = useCallback((): string => {
    if (resolveOrdersFetchTab() !== 'cancel_returns') return '';
    return resolveOrdersFetchKindFromUrl();
  }, [resolveOrdersFetchTab]);

  // Quay lại tab / sáng màn hình → lập tức fetch đơn mới nhất, bỏ qua cache (KHÔNG gọi Shopee).
  useEffect(() => {
    if (!isAuthenticated) return;

    // Chỉ chống double-fire focus + visibilitychange cùng lúc; không chặn sau khi tab bị đóng băng.
    const FOCUS_REFRESH_COOLDOWN_MS = 800;

    const refreshFromLocalDb = async () => {
      if (document.visibilityState === 'hidden') return;
      // Tab Đơn hàng: OrderManager đã có SSE + counter — tránh /refresh chồng poll.
      if (activeTab === 'orders') return;
      const now = Date.now();
      if (now - lastFocusRefreshAtRef.current < FOCUS_REFRESH_COOLDOWN_MS) return;
      lastFocusRefreshAtRef.current = now;

      setBackgroundRefreshing(true);
      try {
        const tab = resolveOrdersFetchTab();
        const kind = resolveOrdersFetchKind();
        await fetchOrders({
          silent: true,
          page: 1,
          limit: 50,
          merge: false,
          ...(tab ? { tab } : {}),
          ...(kind ? { kind } : {}),
        });
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
  }, [isAuthenticated, activeTab, resolveOrdersFetchTab, resolveOrdersFetchKind]);

  // Poll hàng đợi dò ngầm Backend — toast toàn app kể cả khi tắt màn quét / đổi tab.
  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    let timer: number | null = null;
    let abortCtrl: AbortController | null = null;
    let inFlight = false;
    const schedule = () => {
      if (cancelled) return;
      timer = window.setTimeout(() => {
        void poll();
      }, SCAN_BG_STATUS_POLL_MS);
    };
    const poll = async () => {
      if (cancelled || inFlight) return;
      if (document.visibilityState === 'hidden' || activeTab === 'orders') {
        // Tab Đơn hàng: OrderManager poll riêng — tránh 2 request song song.
        schedule();
        return;
      }
      inFlight = true;
      abortCtrl = new AbortController();
      const signal = abortCtrl.signal;
      try {
        const status = await fetchScanBgStatus(signal);
        if (cancelled || !status) return;
        setScanBgPendingCount(status.pendingCount || 0);
        const unnotified = status.unnotified || [];
        if (unnotified.length === 0) return;
        const toast = formatScanBgToast(status.summary);
        if (toast) {
          if (scanBgToastTimerRef.current) window.clearTimeout(scanBgToastTimerRef.current);
          setScanBgToast({
            text: toast,
            type: status.summary.cancelled + status.summary.returnReceived > 0 ? 'success' : 'error',
          });
          scanBgToastTimerRef.current = window.setTimeout(() => setScanBgToast(null), 5000);
        }
        await ackScanBgNotifications(unnotified.map((j) => j.id));
        const saved =
          (status.summary?.cancelled || 0) + (status.summary?.returnReceived || 0);
        if (saved > 0) {
          const tab = resolveOrdersFetchTab();
          const kind = resolveOrdersFetchKind();
          void fetchOrders({
            silent: true,
            page: 1,
            limit: 50,
            merge: false,
            ...(tab ? { tab } : {}),
            ...(kind ? { kind } : {}),
          });
        }
      } finally {
        inFlight = false;
        schedule();
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
      abortCtrl?.abort();
    };
  }, [isAuthenticated, activeTab, resolveOrdersFetchTab, resolveOrdersFetchKind]);

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

  // Persist status/tracking changes made in the UI back to the real orders database.
  const handleUpdateOrders = (updatedOrders: Order[], opts?: { persist?: boolean }) => {
    const sanitized = sanitizeOrders(updatedOrders);
    const previousById = new Map(orders.map(o => [o.id, o]));
    setOrders(sanitized);
    ordersHydrateRef.current = sanitized;
    void saveOrdersCache(sanitized);

    // Handover/API đã persist JSON+Mongo — chỉ cập nhật state, tránh PATCH full order ghi đè lệch.
    if (opts?.persist === false) return;

    const token = localStorage.getItem('admin_token');
    if (!token) return;

    sanitized.forEach(order => {
      const prev = previousById.get(order.id);
      if (!prev || JSON.stringify(prev) === JSON.stringify(order)) return;

      // Dynamic orderId/orderSn — tuyệt đối không hardcode mã test.
      const sn = String(order.orderSn || '').replace(/^shopee-/i, '').trim();
      const orderKey =
        String(order.id || '').trim() ||
        (sn ? `shopee-${sn}` : '');
      if (!orderKey || /^shopee-TEST/i.test(orderKey) || /TEST-SCAN-MVC/i.test(orderKey)) {
        console.warn('[Orders PATCH] skip invalid/hardcoded order key:', orderKey || '(empty)');
        return;
      }

      fetch(`/api/orders/${encodeURIComponent(orderKey)}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          ...order,
          id: orderKey,
          orderSn: sn || order.orderSn,
        }),
      }).catch(err => console.error(`Sync order ${orderKey} error:`, err));
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
  const handleAddProduct = async (prod: Product): Promise<Product> => {
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
              unit: saved.unit,
              channels: saved.channels || [],
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
    return prod;
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
      // Chỉ lưu kho nội bộ — đồng bộ Shopee tách riêng qua nút "Đồng bộ Shopee".
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
          data?.error || data?.message || `Lỗi cập nhật sản phẩm (HTTP ${response.status})`;
        return {
          success: false,
          error,
          shopeeSynced: false,
          shopeeMessage: data?.shopeeMessage || error,
        };
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
        shopeeSynced: false,
        shopeeMessage: 'Lưu thành công',
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

  /** Tìm SKU trong cây sản phẩm (parent + children) — dùng khi merge bulk-save. */
  const findProductInTree = (tree: Product[], id: string): Product | undefined => {
    const sid = String(id);
    for (const p of tree) {
      if (String(p.id) === sid) return p;
      for (const c of getProductChildren(p)) {
        if (String(c.id) === sid) return c;
      }
    }
    return undefined;
  };

  /** Merge bulk-save vào danh sách trang hiện tại — không thay cả kho, giữ pagination/search UI. */
  const mergeBulkSaveIntoProducts = (
    prev: Product[],
    updates: BulkSaveProductUpdate[],
    sourceTree?: Product[]
  ): Product[] => {
    const updateMap = new Map(updates.map((u) => [String(u.id), u]));
    const updateIds = new Set(updateMap.keys());

    return prev.map((p) => {
      if (updateIds.has(String(p.id))) {
        const fresh = sourceTree ? findProductInTree(sourceTree, p.id) : undefined;
        const patch = updateMap.get(String(p.id))!;
        if (fresh) return { ...p, ...fresh };
        return {
          ...p,
          importPrice: patch.importPrice ?? p.importPrice,
          sellingPrice: patch.sellingPrice ?? p.sellingPrice,
          stock: patch.stock ?? p.stock,
          sku: patch.sku ?? p.sku,
        };
      }

      const children = getProductChildren(p);
      if (children.length === 0) return p;
      if (!children.some((c) => updateIds.has(String(c.id)))) return p;

      const nextChildren = children.map((c) => {
        if (!updateIds.has(String(c.id))) return c;
        const fresh = sourceTree ? findProductInTree(sourceTree, c.id) : undefined;
        const patch = updateMap.get(String(c.id))!;
        if (fresh) return { ...c, ...fresh };
        return {
          ...c,
          importPrice: patch.importPrice ?? c.importPrice,
          sellingPrice: patch.sellingPrice ?? c.sellingPrice,
          stock: patch.stock ?? c.stock,
          sku: patch.sku ?? c.sku,
        };
      });
      const totalStock = nextChildren.reduce((s, c) => s + (Number(c.stock) || 0), 0);
      return { ...p, children: nextChildren, stock: totalStock };
    });
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
      const sourceTree = Array.isArray(data.products) ? (data.products as Product[]) : undefined;
      setProducts((prev) => mergeBulkSaveIntoProducts(prev, updates, sourceTree));
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

      // IndexedDB chỉ hydrate ref (scanner fallback) — KHÔNG đổ mixed cache vào list tab cụ thể.
      const cached = await loadOrdersCache();
      ordersHydrateRef.current = cached;
      if (cached.length > 0 && activeTabRef.current !== 'orders') {
        setOrders(cached);
        setHasLoadedOrdersOnce(true);
      }
      // Tab Đơn hàng: OrderManager useEffect (silent:false) là SSOT — không abort/đua request.
      if (activeTabRef.current !== 'orders') {
        void fetchOrders({ silent: true, limit: 50, page: 1, merge: false });
      }

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
          // KHÔNG remap shopId 1↔1 (tránh ghi đè AuDIO 831052930 → shop khác).
          // Chỉ THÊM shop OAuth còn thiếu vào danh sách kết nối.
          if (unmatchedTokens.length === 0) return prev;
          const now = new Date().toISOString();
          const additions = unmatchedTokens.map((id) => ({
            id: `shop-shopee-${id}`,
            platform: 'shopee' as const,
            shopId: id,
            shopName: id === '831052930' ? 'AuDIO' : `Shopee ${id}`,
            apiKey: 'oauth',
            connected: true,
            lastSynced: now,
          }));
          return { ...prev, shops: [...shops, ...additions] };
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
          className="fixed top-16 right-3 z-[100] flex items-center gap-2 rounded-full bg-slate-900/90 text-white px-3 py-1.5 shadow-lg pointer-events-none"
          role="status"
          aria-live="polite"
        >
          <RefreshCw className="w-3.5 h-3.5 animate-spin shrink-0" />
          <span className="text-[11px] font-semibold tracking-wide">Đang làm mới...</span>
        </div>
      )}
      {scanBgPendingCount > 0 && activeTab !== 'orders' && (
        <div
          className="fixed top-16 left-3 right-3 md:left-auto md:right-3 md:max-w-sm z-[100] flex items-center gap-2 rounded-xl bg-sky-600 text-white px-3 py-2 shadow-lg"
          role="status"
        >
          <Loader2 className="w-4 h-4 animate-spin shrink-0" />
          <span className="text-[11px] font-bold">
            Đang dò ngầm {scanBgPendingCount} mã...
          </span>
        </div>
      )}
      {scanBgToast && (
        <div
          className={`fixed top-16 left-3 right-3 md:left-auto md:right-3 md:max-w-md z-[110] text-xs font-bold px-4 py-3 rounded-xl shadow-lg flex items-center gap-2 ${
            scanBgToast.type === 'success' ? 'bg-emerald-600 text-white' : 'bg-rose-600 text-white'
          }`}
        >
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span className="flex-1">{scanBgToast.text}</span>
        </div>
      )}
      {/* Sidebar Navigation */}
      <aside className="sidebar-panel max-md:hidden md:fixed md:inset-y-0 md:left-0 md:z-40 md:flex md:w-64 md:flex-col shrink-0 h-screen overflow-hidden bg-slate-900 text-slate-300 border-r border-slate-800" id="sidebar-panel">
        {/* Brand Header */}
        <div className="p-6 border-b border-slate-800 shrink-0">
          <BrandHeader logoSize={48} />
        </div>

        {/* Navigation Items */}
        <nav className="sidebar-nav-scroll flex-1 min-h-0 p-4 space-y-1 overflow-y-auto" id="sidebar-nav">
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
            {scanBgPendingCount > 0 && (
              <span className="ml-auto text-[9px] font-black bg-sky-500 text-white px-1.5 py-0.5 rounded-full tabular-nums">
                {scanBgPendingCount}
              </span>
            )}
          </button>

          <button
            onClick={() => navigateTab('picking')}
            className={`${navButtonClass('picking')} max-md:hidden`}
          >
            <ScanLine className="w-4 h-4 shrink-0" /> Nhặt hàng
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
                {scanBgPendingCount > 0 && (
                  <span className="ml-auto text-[9px] font-black bg-sky-500 text-white px-1.5 py-0.5 rounded-full tabular-nums">
                    {scanBgPendingCount}
                  </span>
                )}
              </button>
              <button onClick={() => navigateTab('orders', { openScanner: true })} className={`w-full flex items-center gap-3 px-4 py-3 min-h-11 rounded-xl text-xs font-bold uppercase tracking-wider transition-all cursor-pointer ${activeTab === 'orders' && focusScanner ? 'bg-blue-600 text-white' : 'hover:bg-slate-800 hover:text-white text-slate-400'}`}>
                <Barcode className="w-4 h-4 shrink-0" /> Quét mã vạch
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

      {/* Main Content Area — md:ml-64 tránh bị sidebar fixed đè lên */}
      <main className="md:flex-1 min-w-0 w-full md:ml-64">
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
            {activeTab !== 'dashboard' && (
              <>
                <h2 className={`text-lg font-extrabold text-gray-900 tracking-tight ${activeTab === 'orders' ? 'om-orders-mobile-hide-page-title' : ''}`}>
                  {activeTab === 'products' && 'Quản Lý Danh Sách Sản Phẩm'}
                  {activeTab === 'publish' && 'Hệ Thống Đăng Bán Sản Phẩm Đa Kênh'}
                  {activeTab === 'orders' &&
                    (ordersSubTabHint === 'received_cancel_returns'
                      ? 'Đã nhận đơn hủy, đơn hoàn'
                      : 'Hệ Thống Quản Lý Đơn Hàng Đa Sàn')}
                  {activeTab === 'picking' && 'Nhặt Hàng (Picking)'}
                  {activeTab === 'suppliers' && 'Quản Lý Đối Tác Nhà Cung Cấp'}
                  {activeTab === 'imports' && 'Quản Lý Nhập Hàng'}
                  {activeTab === 'financials' && 'Chi Phí Bán Hàng'}
                  {activeTab === 'settings' && 'Thiết Lập API Sàn Thương Mại'}
                </h2>
                <p className={`text-xs text-gray-400 ${activeTab === 'orders' ? 'om-orders-mobile-hide-page-desc' : ''}`}>
                  {activeTab === 'products' && 'Quản lý giá nhập, giá bán lẻ, tồn kho và xuất bản kênh.'}
                  {activeTab === 'publish' && 'Đăng bán sản phẩm lên nhiều gian hàng đồng thời, lồng khung hình sỉ hàng loạt và tối ưu tiêu đề chống spam bằng AI.'}
                  {activeTab === 'orders' &&
                    (ordersSubTabHint === 'received_cancel_returns'
                      ? 'Đối soát kiện hủy/hoàn đã nhận về kho — dữ liệu lưu vĩnh viễn.'
                      : 'Quản lý 8 trạng thái đơn Shopee & TikTok, chuẩn bị hàng đóng gói và in vận đơn nhiệt.')}
                  {activeTab === 'picking' && 'Quét mã đơn, tích sản phẩm đã nhặt và chuyển sang đóng gói.'}
                  {activeTab === 'suppliers' && 'Quản lý thông tin liên hệ, công nợ sỉ và tiền độ thanh toán cho xưởng sỉ.'}
                  {activeTab === 'imports' && 'Quản lý hóa đơn nhập đầu vào, theo dõi biến động % giá nhập hàng.'}
                  {activeTab === 'financials' && 'Theo dõi chi phí hoạt động, cơ cấu quỹ và mô phỏng lợi nhuận sau phí sàn.'}
                  {activeTab === 'settings' && 'Cập nhật mã gian hàng, API key và trỏ DNS về hosting riêng.'}
                </p>
              </>
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
        <div className={`app-main-container app-page-content app-scroll-list ${activeTab === 'picking' || activeTab === 'products' || activeTab === 'orders' ? 'max-md:pt-1 max-md:px-2' : 'max-md:pt-2 max-md:px-3'} ${activeTab === 'dashboard' ? 'px-4 pt-3 pb-24 md:px-6 md:pt-4 md:pb-6' : 'p-4 md:p-6 pb-24 md:pb-6'}`}>
          {activeTab === 'dashboard' && (
            <ErrorBoundary label="Tổng quan">
              <Dashboard
                orders={orders}
                products={products}
                systemFees={settings.systemFees ?? []}
                rtsCount={ordersMeta.counters.rts}
                onTabChange={(tab, options) => navigateTab(tab, options)}
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
              ordersMeta={ordersMeta}
              onUpdateOrders={handleUpdateOrders}
              onFetchOrders={fetchOrders}
              onPrepareTabFetch={prepareOrdersListFetch}
              ordersAppliedTab={ordersAppliedTab}
              ordersAppliedKind={ordersAppliedKind}
              ordersLoading={ordersLoading || (!hasLoadedOrdersOnce && orders.length === 0)}
              shops={settings.shops || []}
              systemFees={settings.systemFees ?? []}
              onAddLog={handleAddLog}
              products={products}
              onUpdateProduct={handleUpdateProduct}
              focusScanner={focusScanner}
              initialOrdersSubTab={ordersSubTabHint}
              onOrdersSubTabChange={(tab) => {
                setOrdersSubTabHint((prev) => (prev === tab ? prev : tab));
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
              onProductCreated={(p) =>
                setProducts((prev) => (prev.some((x) => x.id === p.id) ? prev : [p, ...prev]))
              }
              systemFees={settings.systemFees ?? []}
              onProductPriceUpdated={(productId, sellingPrice) => {
                setProducts((prev) =>
                  prev.map((p) => {
                    if (p.id === productId) return { ...p, sellingPrice };
                    const children = getProductChildren(p);
                    if (!children.some((c) => c.id === productId)) return p;
                    return {
                      ...p,
                      children: children.map((c) => (c.id === productId ? { ...c, sellingPrice } : c)),
                    };
                  }),
                );
              }}
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
