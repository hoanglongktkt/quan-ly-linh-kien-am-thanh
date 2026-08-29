import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Product, SyncLog, ConnectedShop } from '../types';
import { parseJsonResponse, apiFetch } from '../utils/apiClient';
import { normalizeProductSearchText } from '../utils/productSearch';
import { 
  Check, 
  AlertCircle, 
  Search, 
  RefreshCw, 
  Copy, 
  Link2, 
  Link2Off, 
  ChevronsRight, 
  ExternalLink,
  HelpCircle,
  CheckCircle2,
  AlertTriangle,
  X,
  ChevronDown,
  ShoppingBag,
  Store,
  Grid,
  Filter,
  Plus,
  PlusCircle,
  ArrowDownToLine,
  Sparkles,
  Trash2,
  Square
} from 'lucide-react';

interface ChannelListing {
  id: string;
  title: string;
  sku: string;
  imageUrl?: string;
  channelId: string;
  platform: 'shopee' | 'tiktok' | 'woocommerce' | 'lazada';
  shopName: string;
  shopId?: string;
  status: 'success' | 'unlinked' | 'failed' | 'invalid';
  linkedProductId?: string;
  /** Populate từ API JOIN kho gốc — nguồn sự thật cho UI, không lấy từ DOM */
  linkedProductTitle?: string;
  linkedProductSku?: string;
  linkedProduct?: { id: string; title: string; sku: string };
  syncError?: string;
  linkBroken?: boolean;
  itemId?: string;
  modelId?: string;
  price?: number;
  weight?: number;
  stock?: number;
}

/** Chuẩn hóa SKU — trim + toUpperCase để so khớp chính xác. */
function normalizeSKU(sku: unknown): string {
  return String(sku ?? '').trim().toUpperCase();
}

/** So khớp SKU tuyệt đối — chỉ trim + toUpperCase (không includes / regex). */
function skusMatchLikeSearch(listingSku: unknown, masterSku: unknown): boolean {
  const listingRaw = normalizeSKU(listingSku);
  const masterRaw = normalizeSKU(masterSku);
  return listingRaw !== '' && masterRaw !== '' && listingRaw === masterRaw;
}

function findMasterProductLikeSearch(
  listingSku: unknown,
  masters: Product[]
): Product | null {
  const listingRaw = normalizeSKU(listingSku);
  if (!listingRaw || !Array.isArray(masters) || masters.length === 0) return null;

  for (const p of masters) {
    if (skusMatchLikeSearch(listingSku, p?.sku)) return p;
  }

  return null;
}

/** Chuẩn hóa 1 dòng mapping từ DATA object — không đọc DOM. */
function normalizeListingRecord(raw: any): ChannelListing | null {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim();
  const channelId = String(raw.channelId || raw.itemId || '').trim();
  if (!id && !channelId) return null;
  const platformRaw = String(raw.platform || 'shopee').toLowerCase();
  const platform = (['shopee', 'tiktok', 'woocommerce', 'lazada'].includes(platformRaw)
    ? platformRaw
    : 'shopee') as ChannelListing['platform'];
  const statusRaw = String(raw.status || 'unlinked');
  const status = (['success', 'failed', 'unlinked', 'invalid'].includes(statusRaw)
    ? statusRaw
    : 'unlinked') as ChannelListing['status'];
  const linkedProductId =
    raw.linkedProductId != null && String(raw.linkedProductId).trim() !== ''
      ? String(raw.linkedProductId)
      : undefined;
  const linkedFromObj = raw.linkedProduct && typeof raw.linkedProduct === 'object' ? raw.linkedProduct : null;
  return {
    id: id || `cl-${platform}-${channelId}`,
    title: String(raw.title ?? ''),
    sku: String(raw.sku ?? ''),
    imageUrl: raw.imageUrl ? String(raw.imageUrl) : undefined,
    channelId: channelId || id,
    platform,
    shopName: String(raw.shopName ?? ''),
    shopId: raw.shopId != null && String(raw.shopId).trim() !== '' ? String(raw.shopId) : undefined,
    status,
    linkedProductId,
    linkedProductTitle:
      (linkedFromObj?.title && String(linkedFromObj.title)) ||
      (raw.linkedProductTitle ? String(raw.linkedProductTitle) : undefined),
    linkedProductSku:
      (linkedFromObj?.sku && String(linkedFromObj.sku)) ||
      (raw.linkedProductSku ? String(raw.linkedProductSku) : undefined),
    linkedProduct: linkedFromObj
      ? {
          id: String(linkedFromObj.id || linkedProductId || ''),
          title: String(linkedFromObj.title || ''),
          sku: String(linkedFromObj.sku || ''),
        }
      : linkedProductId
        ? {
            id: linkedProductId,
            title: String(raw.linkedProductTitle || ''),
            sku: String(raw.linkedProductSku || ''),
          }
        : undefined,
    syncError: raw.syncError ? String(raw.syncError) : undefined,
    linkBroken: !!raw.linkBroken,
    itemId: raw.itemId != null ? String(raw.itemId) : undefined,
    modelId: raw.modelId != null ? String(raw.modelId) : undefined,
    price: Math.max(0, Math.round(Number(raw.price ?? raw.sellingPrice) || 0)),
    weight: Math.max(0, Number(raw.weight) || 0),
    stock: Math.max(0, Math.round(Number(raw.stock) || 0)),
  };
}

/**
 * Resolve tên/SKU SP liên kết — DATA-DRIVEN + defensive.
 * Mọi truy cập linkedProduct dùng optional chaining.
 */
function resolveLinkedMasterFromData(
  listing: ChannelListing | null | undefined,
  products: Product[] | null | undefined
): {
  linkedId?: string;
  title: string;
  sku: string;
  isBroken: boolean;
  effectiveStatus: ChannelListing['status'];
} {
  if (!listing || typeof listing !== 'object') {
    return {
      title: '',
      sku: '',
      isBroken: true,
      effectiveStatus: 'unlinked',
    };
  }

  const linkedId =
    listing.linkedProductId ||
    listing.linkedProduct?.id ||
    undefined;
  const fromListingTitle = String(
    listing.linkedProduct?.title || listing.linkedProductTitle || ''
  ).trim();
  const fromListingSku = String(
    listing.linkedProduct?.sku || listing.linkedProductSku || ''
  ).trim();

  let title = fromListingTitle;
  let sku = fromListingSku;

  const safeProducts = Array.isArray(products) ? products : [];
  if (linkedId && (!title || !sku)) {
    const fromProps = safeProducts.find((p) => p && String(p?.id) === String(linkedId));
    if (fromProps) {
      if (!title) title = String(fromProps?.title || '').trim();
      if (!sku) sku = String(fromProps?.sku || '').trim();
    }
  }

  const isBroken =
    listing.linkBroken === true ||
    (listing.status === 'success' && (!linkedId || (!title && !sku)));

  return {
    linkedId,
    title,
    sku,
    isBroken,
    effectiveStatus: isBroken ? 'unlinked' : listing.status || 'unlinked',
  };
}


interface InitVariantRow {
  id: string;
  label: string;
  sku: string;
  price: number;
  weight: number;
  stock: number;
  modelId?: string;
  itemId?: string;
}

interface ProductLinkingProps {
  products: Product[];
  shops: ConnectedShop[];
  onAddLog: (log: SyncLog) => void;
  onUpdateProduct: (product: Product, opts?: { save?: boolean }) => void;
  onAddProduct?: (product: Product) => Product | void | Promise<Product | void>;
  onRefreshProducts?: (opts?: { page?: number; append?: boolean; pageSize?: number; forceRefresh?: boolean }) => Promise<void>;
}

function applyProductChannelLink(masterProd: Product, listing: ChannelListing): Product {
  const platform = listing.platform as Product['channels'][number];
  const existingChannels = Array.isArray(masterProd.channels) ? masterProd.channels : [];
  const channels = existingChannels.includes(platform)
    ? existingChannels
    : [...existingChannels, platform];

  const linked: Product = { ...masterProd, channels };

  if (listing.platform === 'shopee') {
    const cid = String(listing.channelId || '').trim();
    const modelHint = (listing as ChannelListing & { modelId?: string }).modelId;
    if (cid.includes(':')) {
      const [itemPart, modelPart] = cid.split(':');
      const itemId = (itemPart.match(/(\d{6,})/) || [])[1] || itemPart;
      const modelId = (String(modelPart).match(/(\d+)/) || [])[1] || modelPart;
      linked.shopeeItemId = itemId;
      linked.shopeeModelId = modelId || undefined;
      linked.shopeeId = modelId ? `${itemId}:${modelId}` : cid;
    } else {
      linked.shopeeId = cid;
      linked.shopeeItemId = cid;
      if (modelHint) linked.shopeeModelId = String(modelHint);
    }
  } else if (listing.platform === 'tiktok') {
    linked.tiktokId = listing.channelId;
  } else if (listing.platform === 'woocommerce') {
    linked.wooId = listing.channelId;
  }

  return linked;
}

/** Tìm SP (kể cả biến thể con) trong mảng products đang có ở UI. */
function findProductInTree(list: Product[] | null | undefined, productId: string): Product | null {
  const id = String(productId || '').trim();
  if (!id || !Array.isArray(list)) return null;
  for (const p of list) {
    if (!p) continue;
    if (String(p.id) === id) return p;
    const children = [
      ...(Array.isArray((p as any).children) ? (p as any).children : []),
      ...(Array.isArray((p as any).children_models) ? (p as any).children_models : []),
    ] as Product[];
    for (const c of children) {
      if (c && String(c.id) === id) return c;
    }
  }
  return null;
}

function buildListingsFromProducts(products: Product[], shops: ConnectedShop[]): ChannelListing[] {
  const shopeeShop = shops.find((s) => s.platform === 'shopee');
  const seen = new Set<string>();
  const rows: ChannelListing[] = [];

  for (const p of products) {
    const channelId = p.shopeeItemId || p.shopeeId;
    if (!channelId) continue;
    const key = `shopee::${channelId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      id: `cl-shopee-${channelId}`,
      title: p.title,
      sku: p.sku,
      imageUrl: p.avatarUrl || p.imageUrl,
      channelId: String(channelId),
      platform: 'shopee',
      shopName: shopeeShop?.shopName || 'Shopee',
      status: 'success',
      linkedProductId: p.id,
      linkedProductTitle: p.title,
      linkedProductSku: p.sku,
      linkedProduct: { id: p.id, title: p.title, sku: p.sku },
    });
  }
  return rows;
}

async function fetchMappingListingsFromServer(token: string): Promise<{ rows: ChannelListing[]; source: string } | null> {
  try {
    const endpoint = '/api/mapping-products';
    const res = await apiFetch(endpoint, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await parseJsonResponse<{ success?: boolean; listings?: ChannelListing[] }>(res);
    if (res.ok && data.success !== false && Array.isArray(data.listings)) {
      const rows = data.listings
        .map((row) => normalizeListingRecord(row))
        .filter((r): r is ChannelListing => r != null);
      return { rows, source: endpoint };
    }
    console.warn('[ProductLinking] Không đọc được dữ liệu liên kết:', {
      status: res.status,
      data,
    });
  } catch (err) {
    console.warn('[ProductLinking] Lỗi đọc dữ liệu liên kết:', err);
  }
  return null;
}

export default function ProductLinking({ products, shops, onAddLog, onUpdateProduct, onAddProduct, onRefreshProducts }: ProductLinkingProps) {
  const [listings, setListings] = useState<ChannelListing[]>([]);
  const [listingsLoading, setListingsLoading] = useState(false);
  const [mappingLoadError, setMappingLoadError] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 4500);
  }, []);

  const persistListings = useCallback(async (rows: ChannelListing[]): Promise<ChannelListing[] | null> => {
    const token = localStorage.getItem('admin_token');
    if (!token) {
      showToast('Phiên đăng nhập hết hạn. Vui lòng đăng nhập lại.');
      return null;
    }
    if (!Array.isArray(rows)) {
      console.error('[ProductLinking] persistListings: rows không phải mảng');
      return null;
    }
    try {
      // Gửi DATA model đầy đủ (id/channelId/linkedProductId) — không phụ thuộc UI có render ID.
      const payload = rows
        .map((r) => normalizeListingRecord(r))
        .filter((r): r is ChannelListing => r != null);
      const res = await apiFetch('/api/mapping-products', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ listings: payload }),
      });
      const data = await parseJsonResponse<{ success?: boolean; listings?: ChannelListing[]; message?: string; error?: string }>(res);
      if (!res.ok || !data.success) {
        const msg = data?.message || data?.error || 'Lỗi lưu mapping vào máy chủ.';
        console.error('[ProductLinking] Lưu mapping thất bại:', data);
        showToast(msg);
        return null;
      }
      const savedRows = Array.isArray(data.listings)
        ? data.listings
            .map((row) => normalizeListingRecord(row))
            .filter((r): r is ChannelListing => r != null)
        : payload;
      return savedRows;
    } catch (err) {
      console.error('[ProductLinking] Lưu mapping thất bại:', err);
      showToast('Không thể lưu dữ liệu mapping. Vui lòng kiểm tra kết nối máy chủ.');
      return null;
    }
  }, [showToast]);

  const saveListings = useCallback(
    (updater: ChannelListing[] | ((prev: ChannelListing[]) => ChannelListing[])) => {
      setListings((prev) => {
        const next = typeof updater === 'function' ? updater(prev) : updater;
        void persistListings(next);
        return next;
      });
    },
    [persistListings]
  );

  const mergeListingIntoState = useCallback((nextListing: ChannelListing) => {
    setListings((prev) =>
      prev.map((row) => (String(row.id) === String(nextListing.id) ? nextListing : row))
    );
  }, []);

  const commitAutoLinkedListing = useCallback(
    async (listing: ChannelListing): Promise<ChannelListing> => {
      const normalized = normalizeListingRecord(listing);
      if (!normalized) return listing;
      const saved = await persistListings([normalized]);
      const final = saved?.[0] ?? normalized;
      mergeListingIntoState(final);
      return final;
    },
    [mergeListingIntoState, persistListings]
  );

  const requestSingleAutoLink = useCallback(async (item: ChannelListing): Promise<{
    success: boolean;
    listing: ChannelListing | null;
    message: string;
  }> => {
    const token = localStorage.getItem('admin_token');
    if (!token) {
      throw new Error('Phiên đăng nhập đã hết hạn.');
    }

    const res = await apiFetch('/api/mapping-products/auto-link-single', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        id: item.id,
      }),
    });

    const data = await parseJsonResponse<{
      success?: boolean;
      listing?: ChannelListing;
      message?: string;
      error?: string;
    }>(res);

    if (!res.ok) {
      throw new Error(data?.message || data?.error || 'API liên kết tự động thất bại.');
    }

    return {
      success: data.success === true,
      listing: normalizeListingRecord(data.listing) ?? null,
      message:
        data.message ||
        (data.success === true
          ? 'Liên kết tự động thành công.'
          : 'Không tìm thấy SKU trùng khớp trong Kho gốc.'),
    };
  }, []);

  const refreshListingsFromDb = useCallback(async (opts?: { forceRefresh?: boolean }) => {
    const token = localStorage.getItem('admin_token');
    if (!token) {
      setListingsLoading(false);
      const msg = 'Chưa đăng nhập — không thể đọc dữ liệu sản phẩm sàn.';
      setMappingLoadError(msg);
      return;
    }

    setListingsLoading(true);
    setMappingLoadError(null);
    try {
      const serverResult = await fetchMappingListingsFromServer(token);
      if (serverResult) {
        setListings(serverResult.rows);
        setMappingLoadError(null);
        return;
      }
      setListings([]);
      const msg = 'Chưa có dữ liệu liên kết trên Database.';
      setMappingLoadError(msg);
    } catch (err) {
      const msg = 'Không thể lấy dữ liệu liên kết từ Database. Vui lòng kiểm tra máy chủ.';
      console.error('[ProductLinking] Đọc dữ liệu liên kết thất bại:', err);
      setMappingLoadError(msg);
      setListings([]);
    } finally {
      setListingsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshListingsFromDb({ forceRefresh: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-once hydrate
  }, []);

  useEffect(() => {
    if (listings.length > 0) {
      setMappingLoadError(null);
    }
  }, [listings.length]);

  // Tab state matching Image 1
  const [activeSubTab, setActiveSubTab] = useState<'all' | 'success' | 'unlinked' | 'failed'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedShopFilter, setSelectedShopFilter] = useState<string>('all');
  const [showShopFilterDropdown, setShowShopFilterDropdown] = useState(false);
  // Client-side pagination — chỉ cắt mảng lúc render, không đụng API/Sync
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 50;
  
  // Chỉ giữ các thao tác live data từ Database hiện tại.
  const [isAutoLinking, setIsAutoLinking] = useState(false);
  const [autoLinkProgress, setAutoLinkProgress] = useState({ current: 0, total: 0 });
  const [isPurgingBroken, setIsPurgingBroken] = useState(false);
  const isMappingCancelledRef = useRef(false);

  // Manual Mapping Modal state
  const [mappingListing, setMappingListing] = useState<ChannelListing | null>(null);
  const [mappingSearch, setMappingSearch] = useState('');
  /** Toàn bộ SKU kho gốc — không phụ thuộc phân trang trang Kho sản phẩm. */
  const [masterCatalog, setMasterCatalog] = useState<Array<{ id: string; sku: string; title: string }>>([]);
  const [masterCatalogLoading, setMasterCatalogLoading] = useState(false);
  const [masterCatalogError, setMasterCatalogError] = useState<string | null>(null);

  const mergeCatalogRows = useCallback(
    (rows: any[]): Array<{ id: string; sku: string; title: string }> => {
      const out: Array<{ id: string; sku: string; title: string }> = [];
      const pushOne = (it: any, parentTitle = '') => {
        if (!it || typeof it !== 'object') return;
        const id = String(it?.id || '').trim();
        const sku = String(it?.sku || '').trim();
        if (!id || !sku) return;
        out.push({
          id,
          sku,
          title: String(it?.title || it?.name || parentTitle || sku).trim(),
        });
      };
      for (const it of Array.isArray(rows) ? rows : []) {
        pushOne(it);
        const children = [
          ...(Array.isArray(it?.children) ? it.children : []),
          ...(Array.isArray(it?.children_models) ? it.children_models : []),
          ...(Array.isArray(it?.variants) ? it.variants : []),
          ...(Array.isArray(it?.models) ? it.models : []),
        ];
        const parentTitle = String(it?.title || it?.name || '').trim();
        for (const child of children) pushOne(child, parentTitle);
      }
      return out;
    },
    []
  );

  const loadMasterCatalog = useCallback(async () => {
    setMasterCatalogLoading(true);
    setMasterCatalogError(null);
    try {
      const token = localStorage.getItem('admin_token');
      const res = await apiFetch('/api/mapping-products/sku-index', {
        cache: 'no-store',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !Array.isArray(data?.items)) {
        const msg =
          data?.message ||
          data?.error ||
          `Không tải được danh mục SKU Kho gốc (HTTP ${res.status}).`;
        setMasterCatalogError(msg);
        setMasterCatalog([]);
        return;
      }
      const items = data.items
        .map((it: any) => ({
          id: String(it?.id || '').trim(),
          sku: String(it?.sku || '').trim(),
          title: String(it?.title || '').trim(),
        }))
        .filter((x: { id: string; sku: string }) => Boolean(x.id && x.sku));
      setMasterCatalog(items);
      if (items.length === 0) {
        setMasterCatalogError('Kho gốc chưa có SKU nào trong index. Hãy kiểm tra data/products.json.');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[ProductLinking] loadMasterCatalog failed', err);
      setMasterCatalogError(msg || 'Không tải được danh mục SKU Kho gốc.');
      setMasterCatalog([]);
    } finally {
      setMasterCatalogLoading(false);
    }
  }, []);

  const searchMasterViaApi = useCallback(async (q: string) => {
    const query = String(q || '').trim();
    if (!query) return;
    try {
      const token = localStorage.getItem('admin_token');
      const res = await apiFetch(
        `/api/products/search?q=${encodeURIComponent(query)}&limit=50`,
        {
          cache: 'no-store',
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        }
      );
      const data = await res.json().catch(() => ({}));
      const rows = Array.isArray(data?.products)
        ? data.products
        : Array.isArray(data?.items)
          ? data.items
          : Array.isArray(data?.results)
            ? data.results
            : [];
      if (rows.length === 0) return;
      const flattened = mergeCatalogRows(rows);
      if (flattened.length === 0) return;
      setMasterCatalog((prev) => {
        const byId = new Map(prev.map((r) => [r.id, r]));
        for (const row of flattened) byId.set(row.id, row);
        return [...byId.values()];
      });
      setMasterCatalogError(null);
    } catch (err: unknown) {
      console.warn('[ProductLinking] searchMasterViaApi failed', err);
    }
  }, [mergeCatalogRows]);

  useEffect(() => {
    void loadMasterCatalog();
  }, [loadMasterCatalog]);

  useEffect(() => {
    if (!mappingListing) return;
    const q = mappingSearch.trim();
    if (q.length < 1) return;
    const t = window.setTimeout(() => {
      void searchMasterViaApi(q);
    }, 280);
    return () => window.clearTimeout(t);
  }, [mappingListing, mappingSearch, searchMasterViaApi]);

  /** Chỉ dùng sku-index / search API — tuyệt đối không fallback sang products trang 1 của App. */
  const flattenedMasterProducts = useMemo(() => {
    return masterCatalog.map(
      (r) =>
        ({
          id: r.id,
          sku: r.sku,
          title: r.title || r.sku,
          stock: 0,
          price: 0,
          status: 'active',
          createdAt: 0,
        }) as Product
    );
  }, [masterCatalog]);

  // Sync dữ liệu sàn -> Mapping table
  const [showSyncModal, setShowSyncModal] = useState(false);
  const [syncPlatform, setSyncPlatform] = useState<'shopee' | 'tiktok'>('shopee');
  const [syncShopId, setSyncShopId] = useState('');
  const [syncTimeRange, setSyncTimeRange] = useState<'all' | '24h'>('24h');
  const [isFetchingFromChannel, setIsFetchingFromChannel] = useState(false);
  const [syncProgress, setSyncProgress] = useState({
    page: 0,
    totalScanned: 0,
    skipped: 0,
    newlyAdded: 0,
  });
  const [syncResultMessage, setSyncResultMessage] = useState<string | null>(null);
  const syncPlatformShops = useMemo(
    () => shops.filter((shop) => shop.connected && shop.platform === syncPlatform),
    [shops, syncPlatform]
  );

  useEffect(() => {
    if (syncPlatformShops.length === 0) {
      setSyncShopId('');
      return;
    }
    if (!syncPlatformShops.some((shop) => shop.id === syncShopId)) {
      setSyncShopId(syncPlatformShops[0].id);
    }
  }, [syncPlatformShops, syncShopId]);

  const handleOpenSyncModal = () => {
    setSyncPlatform('shopee');
    setSyncTimeRange('24h');
    setSyncProgress({ page: 0, totalScanned: 0, skipped: 0, newlyAdded: 0 });
    setSyncResultMessage(null);
    setShowSyncModal(true);
  };

  const handleFetchChannelProducts = async () => {
    if (syncPlatform === 'tiktok') return;
    const shop = syncPlatformShops.find((s) => s.id === syncShopId);
    if (!shop) {
      alert('Vui lòng chọn một gian hàng đã kết nối.');
      return;
    }

    setIsFetchingFromChannel(true);
    setSyncResultMessage(null);
    setSyncProgress({ page: 0, totalScanned: 0, skipped: 0, newlyAdded: 0 });
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 600000);

    try {
      const token = localStorage.getItem('admin_token');
      if (!token) throw new Error('Phiên đăng nhập đã hết hạn.');

      let offset = 0;
      let hasMore = true;
      let pageIndex = 0;
      let totalScanned = 0;
      let totalSkipped = 0;
      let totalNewlyAdded = 0;
      let lastListingsCount = 0;
      const maxPages = 200;
      const syncTo = Math.floor(Date.now() / 1000);

      while (hasMore && pageIndex < maxPages) {
        pageIndex += 1;
        setSyncProgress({
          page: pageIndex,
          totalScanned,
          skipped: totalSkipped,
          newlyAdded: totalNewlyAdded,
        });

        const res = await apiFetch('/api/sync-from-shop', {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            shop_id: shop.shopId,
            time_range: syncTimeRange,
            offset,
            sync_to: syncTo,
          }),
        });
        const data = await parseJsonResponse<{
          success?: boolean;
          fetchedCount?: number;
          savedCount?: number;
          listingsCount?: number;
          hasMore?: boolean;
          nextOffset?: number | null;
          totalScanned?: number;
          skipped?: number;
          newlyAdded?: number;
          message?: string;
          error?: string;
        }>(res);

        if (!res.ok || data.success === false) {
          throw new Error(
            data?.message || data?.error || `Tải trang ${pageIndex} thất bại.`
          );
        }

        const pageScanned = Number(data.totalScanned ?? data.fetchedCount ?? 0) || 0;
        const pageSkipped = Number(data.skipped ?? 0) || 0;
        const pageAdded = Number(data.newlyAdded ?? data.savedCount ?? 0) || 0;
        totalScanned += pageScanned;
        totalSkipped += pageSkipped;
        totalNewlyAdded += pageAdded;
        lastListingsCount = Number(data.listingsCount || lastListingsCount);

        setSyncProgress({
          page: pageIndex,
          totalScanned,
          skipped: totalSkipped,
          newlyAdded: totalNewlyAdded,
        });

        hasMore = data.hasMore === true;
        offset = data.nextOffset != null ? Number(data.nextOffset) : offset;
        if (!hasMore) break;
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      }

      await refreshListingsFromDb({ forceRefresh: true });
      if (onRefreshProducts) await onRefreshProducts({ forceRefresh: true });
      void loadMasterCatalog();

      const resultText =
        `Hoàn tất! Đã quét ${totalScanned} sản phẩm. ` +
        `Bỏ qua ${totalSkipped} sản phẩm đã có. ` +
        `Thêm mới ${totalNewlyAdded} sản phẩm bị sót.`;
      setSyncResultMessage(resultText);
      showToast(resultText);
      onAddLog({
        id: `log-${Date.now()}`,
        timestamp: new Date().toISOString(),
        channel: 'shopee',
        type: 'product_sync',
        status: 'success',
        message:
          `Tải mapping [${shop.shopName}]: quét ${totalScanned}, bỏ qua ${totalSkipped}, thêm mới ${totalNewlyAdded}` +
          ` (${pageIndex} trang, listings=${lastListingsCount})`,
      });
      // Giữ modal ~1.2s để user thấy kết quả trước khi đóng
      await new Promise<void>((resolve) => setTimeout(resolve, 1200));
      setShowSyncModal(false);
      setSyncResultMessage(null);
    } catch (err: unknown) {
      const e = err as { name?: string; message?: string };
      const rawMsg = String(e?.message || '');
      const isTimeoutAbort =
        e?.name === 'AbortError' ||
        /operation was aborted|aborted|timeout|quá thời gian/i.test(rawMsg);
      const message = isTimeoutAbort
        ? 'Quá thời gian chờ khi tải dữ liệu từ Shopee. Vui lòng thử lại.'
        : rawMsg || 'Tải dữ liệu từ sàn thất bại.';
      alert(`Tải dữ liệu từ sàn thất bại: ${message}`);
      onAddLog({
        id: `log-${Date.now()}`,
        timestamp: new Date().toISOString(),
        channel: 'shopee',
        type: 'product_sync',
        status: 'failed',
        message: `Tải dữ liệu sàn thất bại: ${message}`,
      });
    } finally {
      clearTimeout(timeoutId);
      setIsFetchingFromChannel(false);
    }
  };

  // Khởi tạo về Kho modal state
  const [initListing, setInitListing] = useState<ChannelListing | null>(null);
  const [initTitle, setInitTitle] = useState('');
  const [initAutoLink, setInitAutoLink] = useState(true);
  const [initVariants, setInitVariants] = useState<InitVariantRow[]>([]);
  const [initLoading, setInitLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);

  const buildInitVariantsFromListing = (item: ChannelListing): InitVariantRow[] => {
    const fromWarehouse = products.filter(
      (p) => p.shopeeItemId === item.channelId || String(p.shopeeId || '').startsWith(String(item.itemId || item.channelId).split(':')[0])
    );
    if (fromWarehouse.length > 0) {
      return fromWarehouse.map((p, i) => ({
        id: `row-${i}`,
        label: p.modelName || p.title.split(' - ').pop() || `Phiên bản ${i + 1}`,
        sku: p.sku,
        price: Math.max(0, Math.round(Number(p.sellingPrice) || 0)),
        weight: Math.max(0, Number(p.weight) || 0),
        stock: Math.max(0, Math.round(Number(p.stock) || 0)),
        modelId: p.shopeeModelId,
        itemId: p.shopeeItemId,
      }));
    }
    // Fallback từ snapshot listing (sau sync-from-shop) — không hardcode.
    return [{
      id: 'row-0',
      label: 'Phiên bản 1',
      sku: item.sku || `SP-${item.channelId}`,
      price: Math.max(0, Math.round(Number(item.price) || 0)),
      weight: Math.max(0, Number(item.weight) || 0),
      stock: Math.max(0, Math.round(Number(item.stock) || 0)),
      modelId: item.modelId,
      itemId: item.itemId,
    }];
  };

  const mapShopeePreviewToInitRows = (variants: any[]): InitVariantRow[] => {
    const out: InitVariantRow[] = [];
    const pushRow = (v: any, i: number, parentWeight = 0) => {
      out.push({
        id: `row-${out.length}`,
        label: String(v?.label || v?.modelName || v?.title?.split?.(' - ')?.pop() || `Phiên bản ${i + 1}`),
        sku: String(v?.sku || ''),
        price: Math.max(0, Math.round(Number(v?.price ?? v?.sellingPrice) || 0)),
        weight: Math.max(0, Number(v?.weight) || parentWeight || 0),
        stock: Math.max(0, Math.round(Number(v?.stock) || 0)),
        modelId: v?.modelId != null ? String(v.modelId) : v?.shopeeModelId != null ? String(v.shopeeModelId) : undefined,
        itemId: v?.itemId != null ? String(v.itemId) : v?.shopeeItemId != null ? String(v.shopeeItemId) : undefined,
      });
    };

    (Array.isArray(variants) ? variants : []).forEach((row, i) => {
      if (!row || typeof row !== 'object') return;
      const children = Array.isArray(row.children)
        ? row.children
        : Array.isArray(row.children_models)
          ? row.children_models
          : [];
      const parentWeight = Math.max(0, Number(row.weight) || 0);
      if (children.length > 0) {
        children.forEach((c: any, idx: number) => pushRow(c, idx, parentWeight));
        return;
      }
      // Flat preview row (đã có price/label) hoặc sản phẩm 1 phiên bản
      pushRow(row, i, parentWeight);
    });
    return out;
  };

  const resolveInitShopId = (item: ChannelListing): string | undefined => {
    if (item.shopId) return String(item.shopId);
    const byName = shops.find(
      (s) => s.platform === 'shopee' && s.connected && s.shopName === item.shopName,
    );
    if (byName?.shopId) return String(byName.shopId);
    const byNameLoose = shops.find(
      (s) =>
        s.platform === 'shopee' &&
        s.connected &&
        String(s.shopName || '').toLowerCase().includes(String(item.shopName || '').toLowerCase()),
    );
    if (byNameLoose?.shopId) return String(byNameLoose.shopId);
    return shops.find((s) => s.platform === 'shopee' && s.connected)?.shopId;
  };

  const handleOpenInitModal = async (item: ChannelListing) => {
    setInitListing(item);
    setInitTitle(item.title);
    setInitAutoLink(true);
    setInitError(null);
    setInitVariants(buildInitVariantsFromListing(item));

    if (item.platform !== 'shopee') return;

    const itemId =
      String(item.itemId || '').trim() ||
      (String(item.channelId || '').match(/(\d{6,})/) || [])[1] ||
      '';
    if (!itemId) return;

    setInitLoading(true);
    try {
      const token = localStorage.getItem('admin_token');
      const shopId = resolveInitShopId(item);
      const payload = {
        itemId,
        shopId,
        channelId: item.channelId,
        shopeeItemId: itemId,
        previewOnly: true,
      };
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      };

      // Ưu tiên endpoint ĐÃ TỒN TẠI trên prod (sync-item-variants + previewOnly).
      // Không gọi cross-origin (tránh Failed to fetch / CORS).
      const endpoints = [
        '/api/shopee/products/sync-item-variants',
        '/api/shopee/products/item-preview',
        '/api/products/shopee-item-preview',
      ];

      let data: any = null;
      let lastMessage = '';
      for (const endpoint of endpoints) {
        try {
          const res = await apiFetch(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
          });
          const json = await res.json().catch(() => ({}));
          const msg = String(json?.message || json?.error || '');
          // Chỉ coi là "route thiếu" khi đúng message 404 API không tồn tại.
          if (res.status === 404 && /API không tồn tại|not_found/i.test(msg) && !/no_variants/i.test(msg)) {
            lastMessage = msg || `HTTP ${res.status}`;
            continue;
          }
          if (!res.ok || json?.success === false) {
            lastMessage = msg || `HTTP ${res.status}`;
            // Thử endpoint khác nếu route thiếu; còn lỗi nghiệp vụ thì dừng.
            if (res.status === 404) continue;
            throw new Error(msg || 'Không lấy được dữ liệu Shopee');
          }
          data = json;
          break;
        } catch (inner: unknown) {
          const message = inner instanceof Error ? inner.message : String(inner);
          if (/API không tồn tại|Failed to fetch|NetworkError/i.test(message)) {
            lastMessage = message;
            continue;
          }
          throw inner;
        }
      }

      if (!data) {
        throw new Error(lastMessage || 'Không tải được chi tiết Shopee');
      }

      const rows = mapShopeePreviewToInitRows(data?.variants);
      if (rows.length > 0) {
        setInitVariants(rows);
        if (data?.title) setInitTitle(String(data.title));
        setInitError(null);
      } else {
        setInitError('Shopee không trả về phân loại/giá/tồn kho.');
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setInitError(message);
      console.warn('[ProductLinking] item-preview failed, dùng snapshot listing:', message);
    } finally {
      setInitLoading(false);
    }
  };

  const updateInitVariant = (id: string, patch: Partial<InitVariantRow>) => {
    setInitVariants((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  // Selected listings for bulk actions
  const [selectedListingIds, setSelectedListingIds] = useState<string[]>([]);

  const handleCopyId = (id: string) => {
    navigator.clipboard.writeText(id);
    showToast(`Đã sao chép ID: ${id}`);
  };

  // 1. Unlink Action (broken chain button)
  const handleUnlink = (listingId: string) => {
    const listing = listings.find(l => l.id === listingId);
    if (!listing) return;

    saveListings(prev => prev.map(item => {
      if (item.id === listingId) {
        return {
          ...item,
          status: 'unlinked',
          linkedProductId: undefined
        };
      }
      return item;
    }));

    showToast(`Đã hủy liên kết sản phẩm "${listing.title}"`);
    
    onAddLog({
      id: `log-${Date.now()}`,
      timestamp: new Date().toISOString(),
      channel: listing.platform,
      type: 'product_sync',
      status: 'success',
      message: `Hủy liên kết thành công sản phẩm sàn [ID: ${listing.channelId}] khỏi Kho chính`
    });
  };

  // 2. Open Manual Mapping Modal — ưu tiên tên sản phẩm sàn (SKU khớp thì đã auto-map).
  const handleOpenMapping = (listing: ChannelListing) => {
    setMappingListing(listing);
    const titleKeyword = String(listing.title || '').trim();
    setMappingSearch(titleKeyword);
    void loadMasterCatalog();
    void searchMasterViaApi(titleKeyword);
  };

  // 3. Confirm Manual Mapping — dùng listingId + masterProductId từ DATA (state), không lấy từ UI text.
  const handleMapProduct = (listingId: string, masterProductId: string) => {
    const catalogHit = flattenedMasterProducts.find((p) => String(p.id) === String(masterProductId));
    const listing = listings.find((l) => String(l.id) === String(listingId));
    // Ưu tiên SP đầy đủ từ trang Kho đang load; catalog chỉ có id/sku/title (không được PATCH stock=0).
    const warehouseProd = findProductInTree(products, masterProductId);
    const displayProd = warehouseProd || catalogHit;
    if (!displayProd || !listing) {
      showToast('Lỗi dữ liệu: thiếu listing.id hoặc sản phẩm kho gốc.');
      return;
    }

    saveListings((prev) =>
      prev.map((item) => {
        if (String(item.id) !== String(listingId)) return item;
        return {
          ...item,
          status: 'success',
          linkedProductId: String(displayProd.id),
          linkedProductTitle: displayProd.title,
          linkedProductSku: displayProd.sku,
          linkedProduct: { id: String(displayProd.id), title: displayProd.title, sku: displayProd.sku },
          sku: item.sku || displayProd.sku,
          syncError: undefined,
          linkBroken: false,
        };
      })
    );

    if (warehouseProd) {
      onUpdateProduct(applyProductChannelLink(warehouseProd, listing), { save: true });
    } else {
      // SP ở trang 2+ Kho Gốc — chỉ PATCH field liên kết kênh, không ghi đè tồn/giá.
      void (async () => {
        try {
          const token = localStorage.getItem('admin_token');
          if (!token) return;
          const patched = applyProductChannelLink(
            {
              id: displayProd.id,
              title: displayProd.title,
              sku: displayProd.sku,
              stock: 0,
              price: 0,
              status: 'active',
              createdAt: 0,
              channels: [],
            } as Product,
            listing
          );
          await apiFetch(`/api/products/${encodeURIComponent(String(displayProd.id))}`, {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              channels: patched.channels,
              shopeeId: patched.shopeeId,
              shopeeItemId: patched.shopeeItemId,
              shopeeModelId: patched.shopeeModelId,
              tiktokId: patched.tiktokId,
              wooId: patched.wooId,
            }),
          });
        } catch (err) {
          console.warn('[ProductLinking] patch channel link (off-page) failed', err);
        }
      })();
    }

    setMappingListing(null);
    showToast(`Liên kết thành công sàn [${listing.shopName}] với kho sản phẩm chính!`);

    onAddLog({
      id: `log-${Date.now()}`,
      timestamp: new Date().toISOString(),
      channel: listing.platform,
      type: 'product_sync',
      status: 'success',
      message: `Liên kết thủ công sản phẩm sàn [ID: ${listing.channelId}] sang Kho chính sản phẩm [${displayProd.sku}]`,
    });
  };

  // Handler to auto link a single channel product
  // Auto-link: luôn gọi API server (toàn bộ kho gốc + ghi mapping disk) — không phụ thuộc trang Kho.
  const handleAutoLinkIndividual = async (
    item: ChannelListing,
    opts?: { silent?: boolean }
  ): Promise<boolean> => {
    const silent = opts?.silent === true;
    try {
      const result = await requestSingleAutoLink(item);
      if (result.success && result.listing) {
        const linkedOk = result.listing.status === 'success' && !!result.listing.linkedProductId;
        if (linkedOk) {
          const saved = await commitAutoLinkedListing(result.listing);
          if (!silent) {
            const isAlreadyLinked = /đã được liên kết trước đó/i.test(result.message);
            showToast(
              isAlreadyLinked
                ? `⚡ ${result.message}`
                : `⚡ Liên kết tự động thành công với Kho chính [${saved.linkedProductSku || saved.linkedProductTitle || 'matched'}]`
            );
            onAddLog({
              id: `log-${Date.now()}`,
              timestamp: new Date().toISOString(),
              channel: (item.platform === 'lazada' ? 'shopee' : item.platform) as any,
              type: 'product_sync',
              status: 'success',
              message: isAlreadyLinked
                ? `Sản phẩm sàn [ID: ${item.channelId}] đã liên kết hợp lệ trước đó.`
                : `Liên kết tự động thành công sản phẩm sàn [ID: ${item.channelId}] với Kho chính [${saved.linkedProductSku || saved.linkedProductTitle || 'matched'}]`,
            });
          }
          return true;
        }
      }

      if (!result.success && result.listing) {
        mergeListingIntoState(result.listing);
      }

      // Fallback: khớp local từ sku-index toàn kho nếu API trả không khớp (không phải lỗi quota)
      const localMatch = findMasterProductLikeSearch(item?.sku, flattenedMasterProducts);
      if (localMatch?.id) {
        handleMapProduct(String(item.id), String(localMatch.id));
        if (!silent) {
          showToast(`⚡ Liên kết tự động thành công với Kho chính [${localMatch.sku}]`);
        }
        return true;
      }

      if (!silent) {
        showToast(result.message);
      }
      return false;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Fallback local khi API lỗi (vd. trước đây Atlas đầy) — vẫn thử map từ catalog disk
      const localMatch = findMasterProductLikeSearch(item?.sku, flattenedMasterProducts);
      if (localMatch?.id) {
        handleMapProduct(String(item.id), String(localMatch.id));
        if (!silent) {
          showToast(`⚡ Liên kết tự động thành công với Kho chính [${localMatch.sku}]`);
        }
        return true;
      }
      if (!silent) {
        showToast(`Liên kết thất bại: ${message}`);
        onAddLog({
          id: `log-${Date.now()}`,
          timestamp: new Date().toISOString(),
          channel: (item.platform === 'lazada' ? 'shopee' : item.platform) as any,
          type: 'product_sync',
          status: 'failed',
          message: `Liên kết tự động thất bại sản phẩm sàn [ID: ${item.channelId}]: ${message}`,
        });
      }
      return false;
    }
  };

  const linkInitListingToSavedProduct = useCallback(
    async (listing: ChannelListing, savedProduct: Product): Promise<boolean> => {
      const productId = String(savedProduct.id || '').trim();
      if (!productId) return false;

      const updatedListing: ChannelListing = {
        ...listing,
        status: 'success',
        linkedProductId: productId,
        linkedProductTitle: savedProduct.title,
        linkedProductSku: savedProduct.sku,
        linkedProduct: { id: productId, title: savedProduct.title, sku: savedProduct.sku },
        sku: listing.sku || savedProduct.sku,
        syncError: undefined,
        linkBroken: false,
      };

      const persisted = await persistListings([updatedListing]);
      if (!persisted?.[0]) return false;
      mergeListingIntoState(persisted[0]);

      try {
        const token = localStorage.getItem('admin_token');
        if (token) {
          const patched = applyProductChannelLink(savedProduct, listing);
          await apiFetch(`/api/products/${encodeURIComponent(productId)}`, {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              channels: patched.channels,
              shopeeId: patched.shopeeId,
              shopeeItemId: patched.shopeeItemId,
              shopeeModelId: patched.shopeeModelId,
              tiktokId: patched.tiktokId,
              wooId: patched.wooId,
            }),
          });
        }
      } catch (err) {
        console.warn('[ProductLinking] patch channel link after init failed', err);
      }

      return true;
    },
    [mergeListingIntoState, persistListings]
  );

  const handleConfirmInitToWarehouse = async () => {
    if (!initListing || !initTitle.trim() || isSubmitting) return;

    setIsSubmitting(true);
    try {
      const validPlatforms = ['shopee', 'tiktok', 'woocommerce'];
      const channelList = validPlatforms.includes(initListing.platform)
        ? [initListing.platform as 'shopee' | 'tiktok' | 'woocommerce']
        : ['shopee'];

      const createdProducts: Product[] = initVariants.map((row, idx) => {
        const baseTitle = initTitle.trim();
        const title = initVariants.length > 1 ? `${baseTitle} - ${row.label}` : baseTitle;
        let shopeeId: string | undefined;
        let shopeeItemId: string | undefined;
        let shopeeModelId: string | undefined;
        if (initListing.platform === 'shopee') {
          const cid = String(initListing.channelId || '').trim();
          const itemFromCid = (cid.match(/(\d{6,})/) || [])[1] || '';
          shopeeItemId = String(row.itemId || initListing.itemId || itemFromCid || '').trim() || undefined;
          shopeeModelId = String(row.modelId || '').trim() || undefined;
          if (!shopeeModelId && cid.includes(':')) {
            const modelPart = cid.split(':')[1];
            shopeeModelId = (String(modelPart).match(/(\d+)/) || [])[1] || modelPart || undefined;
          }
          shopeeId = shopeeModelId && shopeeItemId
            ? `${shopeeItemId}:${shopeeModelId}`
            : shopeeItemId || cid;
        }
        return {
          id: `prod-imported-${Date.now()}-${idx}`,
          title,
          sku: row.sku.trim() || `SP-${initListing.channelId}-${idx}`,
          category: 'Chưa phân loại',
          stock: Math.max(0, Math.round(row.stock)),
          importPrice: 0,
          sellingPrice: Math.max(0, Math.round(row.price)),
          weight: Math.max(0, row.weight),
          channels: channelList,
          imageUrl: initListing.imageUrl || 'https://images.unsplash.com/photo-1608248597279-f99d160bfcbc?w=400&auto=format&fit=crop&q=60&ixlib=rb-4.0.3',
          description: `Sản phẩm khởi tạo từ sàn ${initListing.platform.toUpperCase()} - ${initListing.shopName}. ID sàn: ${initListing.channelId}`,
          status: row.stock > 0 ? 'active' as const : 'out_of_stock' as const,
          shopeeId,
          shopeeItemId,
          shopeeModelId,
          modelName: initVariants.length > 1 ? row.label : undefined,
          tiktokId: initListing.platform === 'tiktok' ? initListing.channelId : undefined,
          lastSynced: new Date().toISOString(),
        };
      });

      // Bước 1: Lưu từng phiên bản vào Kho gốc — đợi API trả về productId thật từ DB.
      const savedProducts: Product[] = [];
      for (const p of createdProducts) {
        if (onAddProduct) {
          const saved = await onAddProduct(p);
          savedProducts.push(saved?.id ? saved : p);
        } else {
          savedProducts.push(p);
        }
      }

      // Bước 2: Chỉ sau khi lưu Kho thành công mới gọi liên kết mapping (tránh race condition).
      if (initAutoLink && savedProducts.length > 0) {
        const primary = savedProducts[0];
        const linked = await linkInitListingToSavedProduct(initListing, primary);
        if (!linked) {
          showToast('Đã tạo sản phẩm về Kho nhưng liên kết tự động thất bại. Vui lòng liên kết thủ công.');
        }
      }

      showToast(`🎉 Đã tạo ${createdProducts.length} phiên bản sản phẩm "${initTitle}" về Kho gốc!`);
      void loadMasterCatalog();
      onAddLog({
        id: `log-${Date.now()}`,
        timestamp: new Date().toISOString(),
        channel: (initListing.platform === 'lazada' ? 'shopee' : initListing.platform) as 'shopee' | 'tiktok' | 'woocommerce',
        type: 'product_sync',
        status: 'success',
        message: `Khởi tạo sản phẩm sàn [ID: ${initListing.channelId}] về Kho gốc (${createdProducts.length} phiên bản).`,
      });

      setInitListing(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showToast(`Khởi tạo thất bại: ${message}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleStopAutoLink = () => {
    isMappingCancelledRef.current = true;
    showToast('Đang dừng liên kết… không gửi thêm lô nào xuống server.');
  };

  const handleAutoLinkBySku = async () => {
    isMappingCancelledRef.current = false;
    setIsAutoLinking(true);
    setAutoLinkProgress({ current: 0, total: 0 });

    /** Mỗi lô = 1 HTTP request — tuyệt đối không spam 1 API / 1 SP (NPROC AZDIGI). */
    const CHUNK_SIZE = 50;
    const CHUNK_GAP_MS = 200;

    try {
      const token = localStorage.getItem('admin_token');
      if (!token) throw new Error('Phiên đăng nhập đã hết hạn.');

      // Toàn bộ listings — không phụ thuộc tab/search/shop filter; retry cả failed.
      const pendingListings = listings.filter(
        (item) => item?.status === 'unlinked' || item?.status === 'failed'
      );
      if (pendingListings.length === 0) {
        showToast('Không có sản phẩm chưa liên kết hoặc liên kết thất bại để xử lý.');
        return;
      }

      // Ưu tiên 1 request server (all-pending) — Hash Map cache + toàn kho, không phụ thuộc trang UI.
      setAutoLinkProgress({ current: 0, total: pendingListings.length });
      try {
        const allRes = await apiFetch('/api/mapping-products/bulk-auto-link', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ mode: 'all-pending' }),
        });
        const allData = await parseJsonResponse<{
          success?: boolean;
          linkedCount?: number;
          failedCount?: number;
          processed?: number;
          listings?: ChannelListing[];
          results?: Array<{ id: string; success: boolean; listing?: ChannelListing; message?: string }>;
          message?: string;
          error?: string;
        }>(allRes);

        if (allRes.ok && allData.success !== false) {
          const resultById = new Map<string, ChannelListing>();
          if (Array.isArray(allData.results)) {
            for (const row of allData.results) {
              const normalized =
                normalizeListingRecord(row.listing) ??
                normalizeListingRecord({
                  ...pendingListings.find((c) => String(c.id) === String(row.id)),
                  status: row.success ? 'success' : 'failed',
                  syncError: row.success ? undefined : row.message,
                });
              if (normalized) resultById.set(String(normalized.id), normalized);
            }
          } else if (Array.isArray(allData.listings)) {
            for (const row of allData.listings) {
              const normalized = normalizeListingRecord(row);
              if (normalized) resultById.set(String(normalized.id), normalized);
            }
          }

          if (resultById.size > 0) {
            setListings((prev) =>
              prev.map((row) => {
                const next = resultById.get(String(row.id));
                return next || row;
              })
            );
          }

          const totalLinked = Number(allData.linkedCount) || 0;
          const totalFailed = Number(allData.failedCount) || 0;
          const processed = Number(allData.processed) || pendingListings.length;
          setAutoLinkProgress({ current: processed, total: processed });

          if (totalLinked > 0) {
            showToast(`Đã liên kết thành công ${totalLinked}/${processed} sản phẩm`);
          } else {
            showToast(`Đã chạy xong ${processed} sản phẩm nhưng không có dòng nào liên kết thành công.`);
          }
          onAddLog({
            id: `log-${Date.now()}`,
            timestamp: new Date().toISOString(),
            channel: 'all',
            type: 'product_sync',
            status: totalLinked > 0 ? 'success' : 'failed',
            message:
              totalLinked > 0
                ? `Liên kết tự động all-pending: ${totalLinked}/${processed} thành công, thất bại ${totalFailed}.`
                : `Liên kết tự động all-pending thất bại hoặc không khớp ở ${processed} sản phẩm.`,
          });
          await refreshListingsFromDb({ forceRefresh: true });
          return;
        }
      } catch (allPendingErr) {
        console.warn('[ProductLinking] all-pending failed, fallback chunk ids', allPendingErr);
      }

      const total = pendingListings.length;
      const chunks: ChannelListing[][] = [];
      for (let i = 0; i < pendingListings.length; i += CHUNK_SIZE) {
        chunks.push(pendingListings.slice(i, i + CHUNK_SIZE));
      }

      let processed = 0;
      let totalLinked = 0;
      let totalFailed = 0;
      let cancelled = false;
      setAutoLinkProgress({ current: 0, total });

      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
        // Nút Dừng: chặn gửi lô tiếp theo — không tạo orphan request trên server.
        if (isMappingCancelledRef.current) {
          cancelled = true;
          break;
        }

        const chunk = chunks[chunkIndex];
        const res = await apiFetch('/api/mapping-products/bulk-auto-link', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            ids: chunk.map((item) => item.id),
          }),
        });

        const data = await parseJsonResponse<{
          success?: boolean;
          linkedCount?: number;
          failedCount?: number;
          listings?: ChannelListing[];
          results?: Array<{ id: string; success: boolean; listing?: ChannelListing; message?: string }>;
          message?: string;
          error?: string;
        }>(res);

        if (!res.ok || data.success === false) {
          throw new Error(data?.message || data?.error || `Lô ${chunkIndex + 1} thất bại.`);
        }

        const resultById = new Map<string, ChannelListing>();
        if (Array.isArray(data.results)) {
          for (const row of data.results) {
            const normalized = normalizeListingRecord(row.listing) ?? normalizeListingRecord({
              ...chunk.find((c) => String(c.id) === String(row.id)),
              status: row.success ? 'success' : 'failed',
              syncError: row.success ? undefined : row.message,
            });
            if (normalized) resultById.set(String(normalized.id), normalized);
          }
        } else if (Array.isArray(data.listings)) {
          for (const row of data.listings) {
            const normalized = normalizeListingRecord(row);
            if (normalized) resultById.set(String(normalized.id), normalized);
          }
        }

        // Cập nhật UI theo lô ngay sau khi Backend trả kết quả.
        setListings((prev) =>
          prev.map((row) => {
            const next = resultById.get(String(row.id));
            return next || row;
          })
        );

        totalLinked += Number(data.linkedCount) || 0;
        totalFailed += Number(data.failedCount) || 0;
        processed += chunk.length;
        setAutoLinkProgress({ current: Math.min(processed, total), total });

        // Khoảng nghỉ giữa các lô — chờ Backend thở xong, tránh spike HTTP.
        if (chunkIndex < chunks.length - 1 && !isMappingCancelledRef.current) {
          await new Promise<void>((resolve) => setTimeout(resolve, CHUNK_GAP_MS));
        }
      }

      const stoppedNote = cancelled ? ' (đã dừng sớm)' : '';
      if (totalLinked > 0) {
        showToast(`Đã liên kết thành công ${totalLinked}/${processed} sản phẩm${stoppedNote}`);
      } else if (cancelled) {
        showToast('Đã dừng. Chưa liên kết được sản phẩm nào.');
      } else {
        showToast(`Đã chạy xong ${processed} sản phẩm nhưng không có dòng nào liên kết thành công.`);
      }

      onAddLog({
        id: `log-${Date.now()}`,
        timestamp: new Date().toISOString(),
        channel: 'all',
        type: 'product_sync',
        status: totalLinked > 0 ? 'success' : 'failed',
        message: cancelled
          ? `Liên kết tự động đã dừng (chunk ${CHUNK_SIZE}): ${totalLinked}/${processed} thành công, thất bại ${totalFailed}.`
          : totalLinked > 0
            ? `Liên kết tự động theo lô ${CHUNK_SIZE}: ${totalLinked}/${total} thành công, thất bại ${totalFailed}.`
            : `Liên kết tự động theo lô thất bại hoặc không khớp ở ${total} sản phẩm.`,
      });
      await refreshListingsFromDb({ forceRefresh: true });
    } catch (err: unknown) {
      const message = (err as Error)?.message || 'Liên kết tự động thất bại.';
      alert(`Liên kết tự động thất bại: ${message}`);
      onAddLog({
        id: `log-${Date.now()}`,
        timestamp: new Date().toISOString(),
        channel: 'all',
        type: 'product_sync',
        status: 'failed',
        message: `Liên kết tự động thất bại: ${message}`,
      });
    } finally {
      isMappingCancelledRef.current = false;
      setIsAutoLinking(false);
      setAutoLinkProgress({ current: 0, total: 0 });
    }
  };

  const handlePurgeBrokenMappings = async () => {
    const confirmed = window.confirm(
      'Dọn sạch các mapping đang trỏ tới sản phẩm Kho gốc không còn tồn tại?\n\nDữ liệu Kho gốc sẽ không bị xóa.'
    );
    if (!confirmed) return;

    setIsPurgingBroken(true);
    try {
      const token = localStorage.getItem('admin_token');
      if (!token) throw new Error('Phiên đăng nhập đã hết hạn.');
      const res = await apiFetch('/api/mapping-products/purge-broken', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await parseJsonResponse<{
        success?: boolean;
        deletedCount?: number;
        purged?: number;
        remaining?: number;
        message?: string;
        error?: string;
      }>(res);
      if (!res.ok || data.success === false) {
        throw new Error(data.message || data.error || 'Dọn dẹp mapping lỗi thất bại.');
      }

      await refreshListingsFromDb();
      setSelectedListingIds([]);
      const deleted = Number(data.deletedCount ?? data.purged ?? 0);
      showToast(
        deleted > 0
          ? `Đã dọn sạch ${deleted} mapping lỗi.`
          : 'Không phát hiện mapping lỗi cần dọn dẹp.'
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      alert(`Dọn dẹp lỗi thất bại: ${message}`);
    } finally {
      setIsPurgingBroken(false);
    }
  };

  // Filter listings based on active tab & search & shop filters
  const tabCounts = useMemo(() => ({
    all: listings.length,
    success: listings.filter(l => l.status === 'success').length,
    unlinked: listings.filter(l => l.status === 'unlinked').length,
    failed: listings.filter(l => l.status === 'failed').length,
  }), [listings]);

  const filteredListings = listings.filter(item => {
    if (!item) return false;
    // 1. Tab Status Filter
    if (activeSubTab === 'success' && item?.status !== 'success') return false;
    if (activeSubTab === 'unlinked' && item?.status !== 'unlinked') return false;
    if (activeSubTab === 'failed' && item?.status !== 'failed') return false;

    // 2. Search query
    const q = String(searchQuery || '').toLowerCase();
    const matchesSearch =
      String(item?.title || '').toLowerCase().includes(q) ||
      String(item?.sku || '').toLowerCase().includes(q) ||
      String(item?.channelId || '').includes(searchQuery || '');
    if (!matchesSearch) return false;

    // 3. Shop filter
    if (selectedShopFilter !== 'all' && item?.shopName !== selectedShopFilter) return false;

    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filteredListings.length / itemsPerPage));
  const safePage = Math.min(currentPage, totalPages);
  const paginatedListings = filteredListings.slice(
    (safePage - 1) * itemsPerPage,
    safePage * itemsPerPage
  );

  const renderPaginationBar = (position: 'top' | 'bottom') => (
    <div
      className={`flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-4 py-3 bg-slate-50/60 ${
        position === 'top' ? 'border-b border-gray-100' : 'border-t border-gray-100'
      }`}
    >
      <span className="text-xs font-bold text-gray-600">
        Trang {safePage} / {totalPages} (Tổng {filteredListings.length} sản phẩm)
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={safePage <= 1}
          onClick={() => setCurrentPage(safePage - 1)}
          className="px-3 py-1.5 text-xs font-bold rounded-lg border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-white transition-all"
        >
          Trang trước
        </button>
        <button
          type="button"
          disabled={safePage >= totalPages || filteredListings.length === 0}
          onClick={() => setCurrentPage(safePage + 1)}
          className="px-3 py-1.5 text-xs font-bold rounded-lg border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-white transition-all"
        >
          Trang sau
        </button>
      </div>
    </div>
  );

  // Get list of unique shop names in our current listings for filter dropdown
  const uniqueShopsInListings = Array.from(new Set(listings.map(l => l.shopName)));

  const handleToggleSelectListing = (id: string) => {
    if (selectedListingIds.includes(id)) {
      setSelectedListingIds(prev => prev.filter(item => item !== id));
    } else {
      setSelectedListingIds(prev => [...prev, id]);
    }
  };

  const handleSelectAllListings = () => {
    if (selectedListingIds.length === filteredListings.length) {
      setSelectedListingIds([]);
    } else {
      setSelectedListingIds(filteredListings.map(l => l.id));
    }
  };

  // Master product search in manual mapping modal — khớp 1 chiều: title/SKU chứa từ khóa (không reverse-includes).
  const mappingSearchNorm = normalizeProductSearchText(mappingSearch);
  const filteredMasterProducts = (() => {
    const matched = flattenedMasterProducts.filter((p) => {
      if (!mappingSearchNorm) return true;
      const titleNorm = normalizeProductSearchText(p.title);
      const skuNorm = normalizeProductSearchText(p.sku);
      // Chỉ giữ khi TÊN hoặc SKU chứa từ khóa — tuyệt đối không match vì SKU ngắn nằm trong chuỗi tìm kiếm.
      return titleNorm.includes(mappingSearchNorm) || skuNorm.includes(mappingSearchNorm);
    });
    return matched.slice(0, mappingSearchNorm ? 80 : 30);
  })();

  return (
    <div className="space-y-6">
      
      {/* Toast Notification */}
      {toastMessage && (
        <div className="fixed top-5 right-5 z-50 bg-slate-900 text-white font-bold text-xs px-5 py-3 rounded-2xl shadow-2xl border border-slate-700 animate-bounce flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* HEADER CONTROLS BAR MATCHING MOCKUP */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-3.5 rounded-2xl border border-gray-100 shadow-2xs">
        {/* Connection status counters for tags */}
        <div className="flex bg-gray-100/80 p-1 rounded-xl w-full sm:w-auto">
          <button
            onClick={() => { setActiveSubTab('all'); setSelectedListingIds([]); setCurrentPage(1); }}
            className={`flex-1 sm:flex-initial px-4 py-2 rounded-lg text-xs font-bold transition-all ${
              activeSubTab === 'all' 
                ? 'bg-white text-blue-600 shadow-xs font-extrabold' 
                : 'text-gray-500 hover:text-gray-900'
            }`}
          >
            Tất cả sản phẩm ({tabCounts.all})
          </button>
          
          <button
            onClick={() => { setActiveSubTab('success'); setSelectedListingIds([]); setCurrentPage(1); }}
            className={`flex-1 sm:flex-initial px-4 py-2 rounded-lg text-xs font-bold transition-all ${
              activeSubTab === 'success' 
                ? 'bg-white text-emerald-600 shadow-xs font-extrabold' 
                : 'text-gray-500 hover:text-gray-900'
            }`}
          >
            Liên kết thành công ({tabCounts.success})
          </button>

          <button
            onClick={() => { setActiveSubTab('unlinked'); setSelectedListingIds([]); setCurrentPage(1); }}
            className={`flex-1 sm:flex-initial px-4 py-2 rounded-lg text-xs font-bold transition-all ${
              activeSubTab === 'unlinked' 
                ? 'bg-white text-amber-600 shadow-xs font-extrabold' 
                : 'text-gray-500 hover:text-gray-900'
            }`}
          >
            Chưa liên kết ({tabCounts.unlinked})
          </button>

          <button
            onClick={() => { setActiveSubTab('failed'); setSelectedListingIds([]); setCurrentPage(1); }}
            className={`flex-1 sm:flex-initial px-4 py-2 rounded-lg text-xs font-bold transition-all ${
              activeSubTab === 'failed' 
                ? 'bg-white text-rose-600 shadow-xs font-extrabold' 
                : 'text-gray-500 hover:text-gray-900'
            }`}
          >
            Liên kết thất bại ({tabCounts.failed})
          </button>
        </div>

        {/* Action: Sync mapping + auto-link + cleanup */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 w-full sm:w-auto">
          <button
            onClick={handleOpenSyncModal}
            type="button"
            disabled={isFetchingFromChannel || isAutoLinking || isPurgingBroken}
            className="flex-1 sm:flex-none px-4 py-2.5 bg-white border border-blue-500 hover:bg-blue-50 text-blue-600 text-xs font-extrabold rounded-xl transition-all shadow-2xs flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
          >
            {isFetchingFromChannel ? (
              <>
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                <span>
                  {syncProgress.totalScanned > 0
                    ? `Đang tải ${syncProgress.totalScanned} SP (mới ${syncProgress.newlyAdded})…`
                    : 'Đang quét dữ liệu từ sàn…'}
                </span>
              </>
            ) : (
              <>
                <ArrowDownToLine className="w-3.5 h-3.5" />
                <span>Tải sản phẩm từ sàn</span>
              </>
            )}
          </button>

          {isAutoLinking ? (
            <div className="flex-1 sm:flex-none flex items-stretch sm:items-center gap-2">
              <div className="flex-1 sm:flex-none px-4 py-2.5 bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs font-extrabold rounded-xl flex items-center justify-center gap-1.5">
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                <span>
                  {autoLinkProgress.total > 0
                    ? `Đang liên kết (${autoLinkProgress.current}/${autoLinkProgress.total})`
                    : 'Đang liên kết...'}
                </span>
              </div>
              <button
                onClick={handleStopAutoLink}
                type="button"
                className="px-4 py-2.5 bg-rose-600 hover:bg-rose-700 text-white text-xs font-extrabold rounded-xl transition-all shadow-md shadow-rose-500/20 flex items-center justify-center gap-1.5 cursor-pointer"
                title="Dừng liên kết khẩn cấp"
              >
                <Square className="w-3 h-3 fill-current" />
                <span>Dừng</span>
              </button>
            </div>
          ) : (
            <button
              onClick={() => void handleAutoLinkBySku()}
              type="button"
              disabled={isFetchingFromChannel || isPurgingBroken}
              className="flex-1 sm:flex-none px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-extrabold rounded-xl transition-all shadow-md shadow-emerald-500/20 flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>Liên kết tự động</span>
            </button>
          )}

          <button
            onClick={() => void handlePurgeBrokenMappings()}
            type="button"
            disabled={isFetchingFromChannel || isAutoLinking || isPurgingBroken}
            className="flex-1 sm:flex-none px-4 py-2.5 bg-white border border-rose-300 hover:bg-rose-50 text-rose-600 text-xs font-extrabold rounded-xl transition-all flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
          >
            {isPurgingBroken ? (
              <>
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                <span>Đang dọn...</span>
              </>
            ) : (
              <>
                <Trash2 className="w-3.5 h-3.5" />
                <span>Dọn dẹp lỗi</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* FILTER SEARCH ROW */}
      <div className="bg-white p-4 rounded-2xl border border-gray-100 shadow-2xs flex flex-col md:flex-row md:items-center justify-between gap-4">
        
        {/* Filter Dropdown & Search Bar */}
        <div className="flex-1 flex flex-col sm:flex-row gap-3">
          
          {/* Lọc sản phẩm drop down */}
          <div className="relative">
            <button
              onClick={() => setShowShopFilterDropdown(!showShopFilterDropdown)}
              type="button"
              className="px-4 py-2.5 bg-gray-50/50 hover:bg-gray-50 text-xs font-bold text-gray-700 rounded-xl border border-gray-150 flex items-center justify-between gap-2 min-w-[150px] text-left cursor-pointer transition-all"
            >
              <Filter className="w-3.5 h-3.5 text-blue-500" />
              <span>{selectedShopFilter === 'all' ? 'Lọc sản phẩm' : selectedShopFilter}</span>
              <ChevronDown className="w-3.5 h-3.5 text-gray-400 ml-auto" />
            </button>

            {showShopFilterDropdown && (
              <div className="absolute left-0 mt-1.5 w-56 bg-white border border-gray-100 rounded-xl shadow-lg z-20 py-1.5">
                <button
                  onClick={() => { setSelectedShopFilter('all'); setShowShopFilterDropdown(false); setCurrentPage(1); }}
                  className="w-full text-left px-4 py-2 text-xs font-bold text-gray-700 hover:bg-slate-50 flex items-center gap-2"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-500"></span>
                  <span>Tất cả gian hàng</span>
                </button>
                {uniqueShopsInListings.map(shopName => (
                  <button
                    key={shopName}
                    onClick={() => { setSelectedShopFilter(shopName); setShowShopFilterDropdown(false); setCurrentPage(1); }}
                    className="w-full text-left px-4 py-2 text-xs font-bold text-gray-700 hover:bg-slate-50 flex items-center gap-2"
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-gray-400"></span>
                    <span className="truncate">{shopName}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Search bar */}
          <div className="relative flex-1">
            <Search className="w-3.5 h-3.5 text-gray-400 absolute left-3 top-3.5" />
            <input
              type="text"
              placeholder="Tìm kiếm sản phẩm theo tên, SKU hoặc ID..."
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setCurrentPage(1); }}
              className="pl-9 pr-4 py-2.5 w-full bg-gray-50/50 focus:bg-white focus:ring-1 focus:ring-blue-500 text-xs font-bold text-gray-800 rounded-xl border border-gray-150 outline-none transition-all"
            />
          </div>
        </div>

        {/* Counter Info Banner */}
        <div className="text-[11px] text-gray-400 font-bold flex items-center gap-1 px-2">
          <HelpCircle className="w-3.5 h-3.5 text-gray-400" />
          <span>Để đồng bộ kho tự động, SKU trên sàn Shopee/TikTok phải khớp chính xác với SKU trong Kho chính</span>
        </div>
      </div>

      {/* LISTINGS TABLE */}
      {mappingLoadError && !listingsLoading && listings.length === 0 && (
        <div className="flex items-center gap-2 p-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700 font-semibold">
          <AlertCircle className="w-5 h-5 shrink-0" />
          <span>{mappingLoadError}</span>
        </div>
      )}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-2xs overflow-hidden">
        {renderPaginationBar('top')}
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-gray-50/50 border-b border-gray-150 text-xs font-extrabold text-gray-500 uppercase tracking-wider">
                <th className="p-4 w-12 text-center">
                  <input
                    type="checkbox"
                    checked={filteredListings.length > 0 && selectedListingIds.length === filteredListings.length}
                    onChange={handleSelectAllListings}
                    className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 w-4 h-4 cursor-pointer"
                  />
                </th>
                <th className="p-4 w-10"></th> {/* Toggle column >> */}
                <th className="p-4 min-w-[280px]">Tên sản phẩm</th>
                <th className="p-4 min-w-[140px]">Gian hàng</th>
                <th className="p-4 min-w-[140px]">Trạng thái liên kết</th>
                <th className="p-4 min-w-[240px]">Sản phẩm liên kết</th>
                <th className="p-4 min-w-[140px] text-center">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 text-xs">
              {listingsLoading ? (
                <tr>
                  <td colSpan={7} className="p-16 text-center text-gray-500">
                    <div className="flex flex-col items-center justify-center gap-3">
                      <RefreshCw className="w-8 h-8 text-blue-500 animate-spin" />
                      <span className="text-sm font-bold">Đang tải dữ liệu...</span>
                    </div>
                  </td>
                </tr>
              ) : filteredListings.length === 0 ? (
                <tr>
                  <td colSpan={7} className="p-12 text-center text-gray-400 font-bold">
                    Không tìm thấy sản phẩm liên kết nào khớp với bộ lọc hiện tại.
                  </td>
                </tr>
              ) : (
                paginatedListings.map((item) => {
                  // Lookup hoàn toàn từ DATA model — defensive optional chaining.
                  const linked = resolveLinkedMasterFromData(item, flattenedMasterProducts);
                  const linkedTitle = linked?.title || '';
                  const linkedSku = linked?.sku || '';
                  const isBrokenLink = linked?.isBroken === true;
                  const effectiveStatus = linked?.effectiveStatus || 'unlinked';
                  const showLinked =
                    effectiveStatus === 'success' &&
                    !!linked?.linkedId &&
                    (!!linkedTitle || !!linkedSku);
                  const displayLinkedName =
                    linkedTitle ||
                    item?.linkedProduct?.title ||
                    item?.linkedProductTitle ||
                    'Chưa liên kết';
                  const displayLinkedSku =
                    linkedSku ||
                    item?.linkedProduct?.sku ||
                    item?.linkedProductSku ||
                    '';
                  const rowId = item?.id || '';
                  const rowTitle = item?.title || '';
                  const rowSku = item?.sku || '';
                  return (
                    <tr
                      key={rowId || `row-${Math.random()}`}
                      className="hover:bg-slate-50/50 transition-colors"
                      data-listing-id={rowId}
                      data-channel-id={item?.channelId || ''}
                      data-linked-id={item?.linkedProductId || item?.linkedProduct?.id || ''}
                    >
                      <td className="p-4 text-center">
                        <input
                          type="checkbox"
                          checked={selectedListingIds.includes(rowId)}
                          onChange={() => rowId && handleToggleSelectListing(rowId)}
                          className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 w-4 h-4 cursor-pointer"
                        />
                      </td>
                      
                      {/* Double arrow indicator >> shown in mockup */}
                      <td className="p-4 text-center">
                        <ChevronsRight className="w-4 h-4 text-blue-400 font-bold" />
                      </td>

                      {/* Tên sản phẩm — ID giữ trong data-*, không render ra UI */}
                      <td className="p-4">
                        <div className="flex items-start gap-3">
                          {item?.imageUrl ? (
                            <img
                              src={item.imageUrl}
                              alt={rowTitle}
                              className="w-12 h-12 rounded-lg object-cover border border-gray-150 shrink-0"
                              referrerPolicy="no-referrer"
                            />
                          ) : (
                            <div className="w-12 h-12 rounded-lg bg-gray-100 text-gray-400 font-extrabold flex items-center justify-center border border-gray-150 shrink-0 text-[10px]">
                              NO IMG
                            </div>
                          )}
                          <div className="space-y-1">
                            <p className="font-bold text-gray-900 line-clamp-2 max-w-[320px] hover:text-blue-600 leading-tight">
                              {rowTitle || '—'}
                            </p>
                            
                            {/* SKU under title */}
                            <p className="text-[10px] font-mono text-gray-400 font-bold flex items-center gap-1">
                              <span>SKU:</span>
                              <span className={rowSku ? 'text-gray-600 font-semibold' : 'text-amber-600 bg-amber-50 px-1 rounded'}>
                                {rowSku || 'Chưa có SKU'}
                              </span>
                            </p>
                          </div>
                        </div>
                      </td>

                      {/* Gian hàng column showing Platform and Channel Name */}
                      <td className="p-4">
                        <div className="flex items-center gap-1.5 font-bold text-gray-700">
                          {item?.platform === 'shopee' && <span className="bg-orange-500 text-white w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-black shrink-0">S</span>}
                          {item?.platform === 'tiktok' && <span className="bg-black text-white w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-black shrink-0">T</span>}
                          {item?.platform === 'lazada' && <span className="bg-blue-600 text-white w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-black shrink-0">L</span>}
                          {item?.platform === 'woocommerce' && <span className="bg-indigo-600 text-white w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-black shrink-0">W</span>}
                          <span className="truncate max-w-[140px] text-xs font-semibold">{item?.shopName || '—'}</span>
                        </div>
                      </td>

                      {/* Connection status badge */}
                      <td className="p-4">
                        {isBrokenLink && (
                          <span className="text-rose-700 font-bold text-[11px] bg-rose-50 border border-rose-200 px-2 py-1 rounded-lg flex items-center gap-1 w-fit">
                            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                            <span>Lỗi liên kết (Mất dữ liệu)</span>
                          </span>
                        )}
                        {!isBrokenLink && effectiveStatus === 'success' && (
                          <span className="text-blue-600 font-bold text-[11px] bg-blue-50/50 border border-blue-200 px-2 py-1 rounded-lg">
                            Liên kết thành công
                          </span>
                        )}
                        {!isBrokenLink && effectiveStatus === 'unlinked' && (
                          <span className="text-amber-600 font-bold text-[11px] bg-amber-50/80 border border-amber-200 px-2 py-1 rounded-lg flex items-center gap-1 w-fit">
                            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                            <span>Chưa liên kết</span>
                          </span>
                        )}
                        {!isBrokenLink && effectiveStatus === 'failed' && (
                          <span className="text-rose-600 font-bold text-[11px] bg-rose-50/80 border border-rose-200 px-2 py-1 rounded-lg flex items-center gap-1 w-fit">
                            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                            <span>Liên kết thất bại</span>
                          </span>
                        )}
                      </td>

                      {/* Linked master product info — defensive render */}
                      <td className="p-4">
                        {showLinked ? (
                          <div className="space-y-0.5">
                            <p className="font-extrabold text-blue-600 text-xs hover:underline cursor-pointer line-clamp-1 max-w-[280px]">
                              {displayLinkedName || 'Chưa liên kết'}
                            </p>
                            <p className="font-mono font-bold text-gray-400 text-[10px]">
                              SKU: {displayLinkedSku || '—'}
                            </p>
                          </div>
                        ) : isBrokenLink ? (
                          <div className="space-y-0.5">
                            <span className="text-rose-600 font-bold text-xs">Lỗi dữ liệu</span>
                            {item?.syncError ? (
                              <p className="text-[10px] text-rose-400 line-clamp-2 max-w-[240px]">{item.syncError}</p>
                            ) : null}
                          </div>
                        ) : (
                          <span className="text-gray-400 font-bold text-xs">Chưa liên kết</span>
                        )}
                      </td>

                      {/* Action buttons exactly matching mockup */}
                      <td className="p-4 text-center">
                        {effectiveStatus === 'success' && !isBrokenLink ? (
                          <button
                            onClick={() => rowId && handleUnlink(rowId)}
                            className="p-2 border border-red-150 hover:bg-red-50 text-rose-600 rounded-xl transition-all cursor-pointer"
                            title="Xóa liên kết sản phẩm này"
                          >
                            <Link2Off className="w-4 h-4" />
                          </button>
                        ) : (
                          <div className="flex items-center gap-1.5 justify-center">
                            {/* 1. Liên kết tự động */}
                            <div className="relative group">
                              <button
                                onClick={() => void handleAutoLinkIndividual(item)}
                                className="p-1.5 border border-blue-200 hover:border-blue-500 rounded-lg text-blue-600 hover:bg-blue-50 transition-all cursor-pointer flex items-center justify-center bg-white"
                                type="button"
                              >
                                <Sparkles className="w-3.5 h-3.5 animate-pulse text-blue-500" />
                              </button>
                              <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 scale-0 group-hover:scale-100 transition-all bg-slate-900 text-white text-[10px] font-bold px-2 py-1 rounded shadow-lg whitespace-nowrap z-50 pointer-events-none origin-bottom">
                                Liên kết tự động
                              </div>
                            </div>

                            {/* 2. Liên kết thủ công */}
                            <div className="relative group">
                              <button
                                onClick={() => handleOpenMapping(item)}
                                className="p-1.5 border border-blue-200 hover:border-blue-500 rounded-lg text-blue-600 hover:bg-blue-50 transition-all cursor-pointer flex items-center justify-center bg-white"
                                type="button"
                              >
                                <PlusCircle className="w-3.5 h-3.5 text-blue-600" />
                              </button>
                              <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 scale-0 group-hover:scale-100 transition-all bg-slate-900 text-white text-[10px] font-bold px-2 py-1 rounded shadow-lg whitespace-nowrap z-50 pointer-events-none origin-bottom">
                                Liên kết thủ công
                              </div>
                            </div>

                            {/* 3. Khởi tạo về kho */}
                            <div className="relative group">
                              <button
                                onClick={() => handleOpenInitModal(item)}
                                className="p-1.5 bg-blue-600 border border-blue-600 hover:bg-blue-700 text-white rounded-lg transition-all cursor-pointer flex items-center justify-center shadow-xs"
                                type="button"
                              >
                                <ArrowDownToLine className="w-3.5 h-3.5" />
                              </button>
                              <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 scale-0 group-hover:scale-100 transition-all bg-slate-900 text-white text-[10px] font-bold px-2 py-1 rounded shadow-lg whitespace-nowrap z-50 pointer-events-none origin-bottom">
                                Khởi tạo về Kho
                              </div>
                            </div>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        {renderPaginationBar('bottom')}
      </div>

      {/* ========================================================================= */}
      {/* MODAL: TẠO SẢN PHẨM VỀ KHO */}
      {/* ========================================================================= */}
      {initListing && (
        <div className="fixed inset-0 bg-gray-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in">
          <div className="bg-white rounded-2xl max-w-3xl w-full overflow-hidden shadow-2xl flex flex-col border border-gray-100 max-h-[90vh]">
            <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between bg-slate-50 shrink-0">
              <h3 className="text-sm font-black text-gray-800 uppercase tracking-wider">
                Tạo sản phẩm về Kho
              </h3>
              <button
                type="button"
                onClick={() => !isSubmitting && setInitListing(null)}
                disabled={isSubmitting}
                className="p-1 hover:bg-gray-200 rounded-full transition-all text-gray-400 hover:text-gray-700 disabled:opacity-40"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 flex-1 overflow-y-auto space-y-5">
              <div className="p-3 bg-slate-50 rounded-xl border border-gray-100 flex items-center gap-3">
                {initListing.imageUrl ? (
                  <img src={initListing.imageUrl} alt="" className="w-12 h-12 rounded-lg object-cover border border-gray-100 shrink-0" referrerPolicy="no-referrer" />
                ) : (
                  <div className="w-12 h-12 bg-gray-200 rounded-lg flex items-center justify-center text-[10px] font-bold text-gray-400 shrink-0">IMG</div>
                )}
                <div className="min-w-0">
                  <span className="text-[10px] font-bold uppercase text-orange-600">{initListing.platform} — {initListing.shopName}</span>
                  <p className="text-xs text-gray-500 font-mono mt-0.5 sr-only" aria-hidden="true">
                    {initListing.channelId}
                  </p>
                </div>
              </div>

              <div className="space-y-3">
                <h4 className="text-xs font-black text-gray-700 uppercase tracking-wide">Thông tin chung</h4>
                <div>
                  <label className="text-xs font-bold text-gray-600 mb-1 block">Tên sản phẩm <span className="text-red-500">*</span></label>
                  <input
                    type="text"
                    value={initTitle}
                    onChange={(e) => setInitTitle(e.target.value)}
                    className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/20"
                  />
                </div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={initAutoLink}
                    onChange={(e) => setInitAutoLink(e.target.checked)}
                    className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="text-xs font-bold text-gray-700">Tự động liên kết</span>
                </label>
              </div>

              <div className="space-y-2">
                <h4 className="text-xs font-black text-gray-700 uppercase tracking-wide flex items-center gap-2">
                  Phiên bản sản phẩm
                  {initLoading && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-blue-600 normal-case tracking-normal">
                      <RefreshCw className="w-3 h-3 animate-spin" /> Đang lấy giá/tồn từ Shopee…
                    </span>
                  )}
                </h4>
                {initError && (
                  <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
                    Không tải được chi tiết Shopee ({initError}). Đang hiển thị dữ liệu đã lưu trên listing.
                  </p>
                )}
                <div className="border border-gray-100 rounded-xl overflow-hidden">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="bg-gray-50 border-b border-gray-100 text-[10px] font-bold text-gray-500 uppercase">
                        <th className="p-3">Phân loại</th>
                        <th className="p-3">Mã SKU</th>
                        <th className="p-3">Giá sản phẩm</th>
                        <th className="p-3">Khối lượng (g)</th>
                        <th className="p-3">Tồn kho ban đầu</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {initVariants.map((row) => (
                        <tr key={row.id} className="hover:bg-gray-50/50">
                          <td className="p-2">
                            <input
                              type="text"
                              value={row.label}
                              onChange={(e) => updateInitVariant(row.id, { label: e.target.value })}
                              className="w-full px-2 py-1.5 border border-gray-200 rounded-lg text-xs"
                            />
                          </td>
                          <td className="p-2">
                            <input
                              type="text"
                              value={row.sku}
                              onChange={(e) => updateInitVariant(row.id, { sku: e.target.value })}
                              className="w-full px-2 py-1.5 border border-gray-200 rounded-lg font-mono text-xs"
                            />
                          </td>
                          <td className="p-2">
                            <input
                              type="number"
                              min={0}
                              value={row.price}
                              onChange={(e) => updateInitVariant(row.id, { price: Math.max(0, Number(e.target.value)) })}
                              className="w-full px-2 py-1.5 border border-gray-200 rounded-lg text-right font-mono text-xs"
                            />
                          </td>
                          <td className="p-2">
                            <input
                              type="number"
                              min={0}
                              step="0.01"
                              value={row.weight}
                              onChange={(e) => updateInitVariant(row.id, { weight: Math.max(0, Number(e.target.value)) })}
                              className="w-full px-2 py-1.5 border border-gray-200 rounded-lg text-right font-mono text-xs"
                            />
                          </td>
                          <td className="p-2">
                            <input
                              type="number"
                              min={0}
                              value={row.stock}
                              onChange={(e) => updateInitVariant(row.id, { stock: Math.max(0, Math.round(Number(e.target.value))) })}
                              className="w-full px-2 py-1.5 border border-gray-200 rounded-lg text-right font-mono text-xs"
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            <div className="px-5 py-4 bg-slate-50 border-t border-gray-100 flex justify-end gap-3 shrink-0">
              <button
                type="button"
                onClick={() => setInitListing(null)}
                disabled={isSubmitting}
                className="px-5 py-2.5 bg-white hover:bg-gray-100 border border-gray-200 text-gray-700 font-extrabold text-xs rounded-xl disabled:opacity-50"
              >
                Hủy
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmInitToWarehouse()}
                disabled={!initTitle.trim() || initLoading || initVariants.length === 0 || isSubmitting}
                className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 text-white font-extrabold text-xs rounded-xl flex items-center gap-1.5"
              >
                {isSubmitting ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    Đang xử lý…
                  </>
                ) : (
                  <>
                    <ArrowDownToLine className="w-3.5 h-3.5" />
                    Khởi tạo về Kho
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Popup chọn sàn/gian hàng trước khi tải dữ liệu về bảng Mapping */}
      {showSyncModal && (
        <div className="fixed inset-0 bg-gray-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-3xl max-w-md w-full overflow-hidden shadow-2xl border border-gray-100">
            <div className="p-5 border-b border-gray-100 flex items-center justify-between bg-slate-50">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-blue-100 text-blue-600 flex items-center justify-center">
                  <Store className="w-4.5 h-4.5" />
                </div>
                <div>
                  <h3 className="font-black text-gray-900">Tải sản phẩm từ sàn</h3>
                  <p className="text-[11px] text-gray-500 font-semibold">Chọn sàn và gian hàng để đổ dữ liệu vào Mapping</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => !isFetchingFromChannel && setShowSyncModal(false)}
                disabled={isFetchingFromChannel}
                className="p-1.5 hover:bg-gray-200 rounded-full text-gray-400 disabled:opacity-40"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 space-y-5">
              <div className="space-y-2">
                <label className="text-xs font-black text-gray-700">Sàn</label>
                <select
                  value={syncPlatform}
                  onChange={(e) => setSyncPlatform(e.target.value as 'shopee' | 'tiktok')}
                  disabled={isFetchingFromChannel}
                  className="w-full px-3.5 py-3 bg-white border border-gray-200 rounded-xl text-sm font-bold text-gray-700 focus:outline-none focus:border-blue-500 disabled:opacity-50"
                >
                  <option value="shopee">Shopee</option>
                  <option value="tiktok">TikTok</option>
                </select>
              </div>

              <div className="space-y-2">
                <label className="text-xs font-black text-gray-700">Gian hàng đã kết nối</label>
                <select
                  value={syncShopId}
                  onChange={(e) => setSyncShopId(e.target.value)}
                  disabled={isFetchingFromChannel}
                  className="w-full px-3.5 py-3 bg-white border border-gray-200 rounded-xl text-sm font-bold text-gray-700 focus:outline-none focus:border-blue-500 disabled:opacity-50"
                >
                  <option value="">Chọn gian hàng</option>
                  {syncPlatformShops.map((shop) => (
                    <option key={shop.id} value={shop.id}>
                      {shop.shopName} ({shop.platform.toUpperCase()})
                    </option>
                  ))}
                </select>
              </div>

              <fieldset className="space-y-2">
                <legend className="text-xs font-black text-gray-700 mb-2">Khoảng thời gian</legend>
                <label className="flex items-start gap-3 p-3.5 border border-gray-200 rounded-xl cursor-pointer hover:border-blue-300">
                  <input
                    type="radio"
                    name="sync-time-range"
                    value="all"
                    checked={syncTimeRange === 'all'}
                    onChange={() => setSyncTimeRange('all')}
                    disabled={isFetchingFromChannel}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="block text-sm font-extrabold text-gray-800">Toàn thời gian</span>
                    <span className="block text-[11px] text-gray-500 mt-0.5">Initial Sync — tải tất cả sản phẩm</span>
                  </span>
                </label>
                <label className="flex items-start gap-3 p-3.5 border border-gray-200 rounded-xl cursor-pointer hover:border-blue-300">
                  <input
                    type="radio"
                    name="sync-time-range"
                    value="24h"
                    checked={syncTimeRange === '24h'}
                    onChange={() => setSyncTimeRange('24h')}
                    disabled={isFetchingFromChannel}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="block text-sm font-extrabold text-gray-800">24h qua</span>
                    <span className="block text-[11px] text-gray-500 mt-0.5">Delta Sync — chỉ tải sản phẩm vừa cập nhật</span>
                  </span>
                </label>
              </fieldset>

              {syncPlatform === 'tiktok' && (
                <div className="bg-amber-50 border border-amber-200 p-4 rounded-xl text-xs text-amber-800 font-semibold">
                  Tính năng chưa tích hợp API
                </div>
              )}

              {isFetchingFromChannel && (
                <div className="bg-blue-50 border border-blue-200 p-4 rounded-xl space-y-1.5">
                  <p className="text-xs font-extrabold text-blue-800 flex items-center gap-1.5">
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    Đang quét dữ liệu từ sàn…
                    {syncProgress.page > 0 ? ` (trang ${syncProgress.page})` : ''}
                  </p>
                  <p className="text-[11px] font-semibold text-blue-700">
                    Đã quét {syncProgress.totalScanned} · Bỏ qua {syncProgress.skipped} đã có · Thêm mới{' '}
                    {syncProgress.newlyAdded}
                  </p>
                </div>
              )}

              {syncResultMessage && !isFetchingFromChannel && (
                <div className="bg-emerald-50 border border-emerald-200 p-4 rounded-xl">
                  <p className="text-xs font-extrabold text-emerald-800 flex items-center gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    {syncResultMessage}
                  </p>
                </div>
              )}
            </div>

            <div className="px-5 py-4 bg-slate-50 border-t border-gray-100 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setShowSyncModal(false)}
                disabled={isFetchingFromChannel}
                className="px-5 py-2.5 bg-white border border-gray-200 text-gray-700 font-extrabold text-xs rounded-xl disabled:opacity-50"
              >
                Hủy
              </button>
              <button
                type="button"
                onClick={() => void handleFetchChannelProducts()}
                disabled={!syncShopId || isFetchingFromChannel || syncPlatform === 'tiktok'}
                className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 text-white font-extrabold text-xs rounded-xl flex items-center gap-1.5"
              >
                {isFetchingFromChannel ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    {syncProgress.totalScanned > 0
                      ? `Đang tải ${syncProgress.totalScanned}…`
                      : 'Đang quét…'}
                  </>
                ) : (
                  <>
                    <ArrowDownToLine className="w-3.5 h-3.5" />
                    Bắt đầu tải
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL: MANUAL PRODUCT LINKING / MAPPING */}
      {/* ========================================================================= */}
      {mappingListing && (
        <div className="fixed inset-0 bg-gray-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in">
          <div className="bg-white rounded-3xl max-w-xl w-full overflow-hidden shadow-2xl flex flex-col border border-gray-100 max-h-[85vh]">
            {/* Modal Header */}
            <div className="p-5 border-b border-gray-100 flex items-center justify-between bg-slate-50">
              <div>
                <h3 className="text-xs font-black text-blue-600 uppercase tracking-wider">
                  Liên kết sản phẩm thủ công
                </h3>
                <p className="text-xs font-bold text-gray-800 line-clamp-1 max-w-[420px] mt-0.5">
                  Sàn: {mappingListing.title}
                </p>
              </div>
              <button
                onClick={() => setMappingListing(null)}
                className="p-1 hover:bg-gray-200 rounded-full transition-all text-gray-400 hover:text-gray-700"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Content */}
            <div className="p-5 flex-1 overflow-y-auto space-y-4">
              
              {/* Product details to be mapped */}
              <div className="p-4 bg-slate-50 rounded-2xl border border-gray-150 flex gap-3.5">
                {mappingListing.imageUrl ? (
                  <img
                    src={mappingListing.imageUrl}
                    alt={mappingListing.title}
                    className="w-14 h-14 rounded-xl object-cover border border-gray-250 shrink-0"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <div className="w-14 h-14 bg-gray-200 rounded-xl flex items-center justify-center text-gray-400 font-bold text-xs shrink-0 border border-gray-200">
                    NO IMG
                  </div>
                )}
                <div className="space-y-1">
                  <span className="text-[10px] font-black uppercase text-orange-600 bg-orange-50 border border-orange-100 px-1.5 py-0.2 rounded">
                    {mappingListing.platform.toUpperCase()} - {mappingListing.shopName}
                  </span>
                  <p className="text-xs font-extrabold text-gray-800 leading-tight">
                    {mappingListing.title}
                  </p>
                  <div className="flex gap-4 text-[10px] text-gray-400 font-bold">
                    <span>Mã SKU Sàn: <strong className="text-gray-700 font-mono">{mappingListing.sku || 'Không có'}</strong></span>
                    <span className="sr-only" aria-hidden="true">{mappingListing.channelId}</span>
                  </div>
                </div>
              </div>

              {/* Master products search section */}
              <div className="space-y-2">
                <label className="text-xs font-black text-gray-700 block">
                  Tìm sản phẩm trong Kho chính để liên kết
                  {masterCatalogLoading ? (
                    <span className="ml-1 font-bold text-amber-500 normal-case tracking-normal">
                      (đang tải index…)
                    </span>
                  ) : masterCatalog.length > 0 ? (
                    <span className="ml-1 font-bold text-gray-400 normal-case tracking-normal">
                      ({masterCatalog.length} SKU toàn kho)
                    </span>
                  ) : null}
                </label>
                {masterCatalogError && (
                  <div className="flex items-start gap-2 p-2.5 bg-rose-50 border border-rose-200 rounded-xl text-[11px] text-rose-700 font-bold">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    <div className="flex-1 space-y-1.5">
                      <p>{masterCatalogError}</p>
                      <button
                        type="button"
                        onClick={() => void loadMasterCatalog()}
                        className="px-2.5 py-1 bg-white border border-rose-300 rounded-lg text-[10px] font-extrabold text-rose-600 hover:bg-rose-100"
                      >
                        Thử lại tải SKU index
                      </button>
                    </div>
                  </div>
                )}
                <div className="relative">
                  <Search className="w-4 h-4 text-gray-400 absolute left-3.5 top-3.5" />
                  <input
                    type="text"
                    placeholder="Tìm theo Tên hoặc SKU sản phẩm kho..."
                    value={mappingSearch}
                    onChange={(e) => setMappingSearch(e.target.value)}
                    className="w-full pl-10 pr-4 py-3 bg-white focus:bg-slate-50/50 focus:ring-1 focus:ring-blue-500 rounded-xl border border-gray-250 outline-none text-xs font-bold transition-all"
                  />
                </div>
              </div>

              {/* Match list */}
              <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                <p className="text-[10px] font-black text-gray-400 uppercase tracking-wider">
                  Kết quả tìm thấy ({filteredMasterProducts.length})
                </p>

                {filteredMasterProducts.length === 0 ? (
                  <div className="p-6 text-center text-gray-400 font-bold bg-slate-50 rounded-2xl text-xs">
                    {masterCatalogLoading
                      ? 'Đang tải danh mục SKU Kho gốc…'
                      : masterCatalogError
                        ? 'Chưa có danh mục SKU. Bấm «Thử lại» hoặc gõ tìm để gọi API search toàn kho.'
                        : 'Không tìm thấy sản phẩm Kho chính nào khớp với từ khóa tìm kiếm.'}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {filteredMasterProducts.map(masterProd => (
                      <div
                        key={masterProd.id}
                        className="p-3 bg-white border border-gray-150 hover:border-blue-300 rounded-xl transition-all flex items-center justify-between gap-4 shadow-2xs"
                      >
                        <div className="flex items-center gap-3">
                          {masterProd.imageUrl ? (
                            <img
                              src={masterProd.imageUrl}
                              alt={masterProd.title}
                              className="w-10 h-10 rounded-lg object-cover border border-gray-100 shrink-0"
                              referrerPolicy="no-referrer"
                            />
                          ) : (
                            <div className="w-10 h-10 bg-gray-100 text-gray-400 rounded-lg flex items-center justify-center shrink-0 border text-[9px] font-bold">
                              PROD
                            </div>
                          )}
                          <div className="space-y-0.5">
                            <p className="text-xs font-extrabold text-gray-800 line-clamp-1 max-w-[280px]">
                              {masterProd.title}
                            </p>
                            <div className="flex items-center gap-3 text-[10px] text-gray-400 font-bold">
                              <span>Mã SKU: <strong className="text-gray-700 font-mono font-semibold">{masterProd.sku}</strong></span>
                              <span>Tồn kho: <strong className="text-blue-600 font-semibold">{masterProd.stock}</strong></span>
                            </div>
                          </div>
                        </div>

                        <button
                          type="button"
                          onClick={() => handleMapProduct(mappingListing.id, masterProd.id)}
                          className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white font-extrabold text-[11px] rounded-lg transition-all cursor-pointer flex items-center gap-1"
                        >
                          <Link2 className="w-3.5 h-3.5" />
                          <span>Liên kết</span>
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

            </div>

            {/* Modal Footer */}
            <div className="p-4 bg-slate-50 border-t border-gray-100 flex justify-end">
              <button
                type="button"
                onClick={() => setMappingListing(null)}
                className="px-5 py-2.5 bg-white hover:bg-gray-100 border border-gray-250 text-gray-700 font-extrabold text-xs rounded-xl cursor-pointer"
              >
                Hủy bỏ
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
