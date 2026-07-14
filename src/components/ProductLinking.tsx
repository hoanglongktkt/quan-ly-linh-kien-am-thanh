import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Product, SyncLog, ConnectedShop } from '../types';
import { purgeLegacyCatalogCache } from '../utils/catalogStorage';
import { parseJsonResponse, apiFetch } from '../utils/apiClient';
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
  Sparkles
} from 'lucide-react';

interface ChannelListing {
  id: string;
  title: string;
  sku: string;
  imageUrl?: string;
  channelId: string;
  platform: 'shopee' | 'tiktok' | 'woocommerce' | 'lazada';
  shopName: string;
  status: 'success' | 'unlinked' | 'failed';
  linkedProductId?: string;
  /** Populate từ API JOIN kho gốc */
  linkedProductTitle?: string;
  linkedProductSku?: string;
  linkedProduct?: { id: string; title: string; sku: string };
}

interface InitVariantRow {
  id: string;
  label: string;
  sku: string;
  price: number;
  weight: number;
  stock: number;
}

interface ProductLinkingProps {
  products: Product[];
  shops: ConnectedShop[];
  onAddLog: (log: SyncLog) => void;
  onUpdateProduct: (product: Product, opts?: { save?: boolean }) => void;
  onAddProduct?: (product: Product) => void;
  onRefreshProducts?: () => Promise<void>;
}

function applyProductChannelLink(masterProd: Product, listing: ChannelListing): Product {
  const platform = listing.platform as Product['channels'][number];
  const channels = masterProd.channels.includes(platform)
    ? masterProd.channels
    : [...masterProd.channels, platform];

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
    });
  }
  return rows;
}

async function fetchMappingListingsFromServer(token: string): Promise<{ rows: ChannelListing[]; source: string } | null> {
  const endpoints = ['/api/mapping-products', '/api/channel-listings'];
  for (const endpoint of endpoints) {
    try {
      const res = await apiFetch(endpoint, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const text = await res.text();
      let data: { success?: boolean; listings?: ChannelListing[] } = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        console.warn(`[ProductLinking] ${endpoint} non-JSON:`, text.slice(0, 120));
        continue;
      }
      if (res.ok && data.success !== false && Array.isArray(data.listings)) {
        return { rows: data.listings, source: endpoint };
      }
      console.warn(`[ProductLinking] ${endpoint} failed:`, { status: res.status, data });
    } catch (err) {
      console.warn(`[ProductLinking] ${endpoint} network error:`, err);
    }
  }
  return null;
}

export default function ProductLinking({ products, shops, onAddLog, onUpdateProduct, onAddProduct, onRefreshProducts }: ProductLinkingProps) {
  const [listings, setListings] = useState<ChannelListing[]>([]);
  const [listingsLoading, setListingsLoading] = useState(false);
  const [mappingLoadError, setMappingLoadError] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const listingsHydratedRef = useRef(false);

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 4500);
  }, []);

  const persistListings = useCallback(async (rows: ChannelListing[]): Promise<boolean> => {
    const token = localStorage.getItem('admin_token');
    if (!token) {
      showToast('Phiên đăng nhập hết hạn. Vui lòng đăng nhập lại.');
      return false;
    }
    try {
      const res = await fetch('/api/mapping-products', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ listings: rows }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        const msg = data?.message || data?.error || 'Lỗi lưu mapping vào máy chủ.';
        console.error('[ProductLinking] Lưu mapping thất bại:', data);
        showToast(msg);
        return false;
      }
      return true;
    } catch (err) {
      console.error('[ProductLinking] Lưu mapping thất bại:', err);
      showToast('Không thể lưu dữ liệu mapping. Vui lòng kiểm tra kết nối máy chủ.');
      return false;
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

  useEffect(() => {
    purgeLegacyCatalogCache();
  }, []);

  const loadMappingListings = useCallback(async (opts?: { silent?: boolean }) => {
    const token = localStorage.getItem('admin_token');
    if (!token) {
      setListingsLoading(false);
      const msg = 'Chưa đăng nhập — không thể tải dữ liệu mapping.';
      setMappingLoadError(msg);
      if (!opts?.silent) showToast(msg);
      return;
    }
    setListingsLoading(true);
    setMappingLoadError(null);
    try {
      const serverResult = await fetchMappingListingsFromServer(token);
      if (serverResult) {
        listingsHydratedRef.current = true;
        setListings(serverResult.rows);
        setMappingLoadError(null);
        if (!opts?.silent) showToast(`Đã tải ${serverResult.rows.length} dòng mapping.`);
        return;
      }
      const msg = 'Không thể lấy dữ liệu sản phẩm từ máy chủ. Vui lòng kiểm tra kết nối hoặc bấm "Tải dữ liệu từ sàn".';
      setMappingLoadError(msg);
      if (!opts?.silent) showToast(msg);
    } catch (err) {
      const msg = 'Không thể lấy dữ liệu sản phẩm từ máy chủ. Vui lòng kiểm tra kết nối.';
      console.error('[ProductLinking] Tải mapping thất bại:', err);
      setMappingLoadError(msg);
      if (!opts?.silent) showToast(msg);
    } finally {
      setListingsLoading(false);
    }
  }, [showToast]);

  // F5 / mở tab mapping → đọc lại từ Database (GET /api/mapping-products).
  useEffect(() => {
    if (listingsHydratedRef.current) return;
    void loadMappingListings({ silent: true });
  }, [loadMappingListings]);

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
  
  // Shop selector + fetch / auto-link actions
  const [syncShopId, setSyncShopId] = useState('');
  const [isFetchingFromChannel, setIsFetchingFromChannel] = useState(false);
  const [isAutoLinking, setIsAutoLinking] = useState(false);

  useEffect(() => {
    const shopeeShops = shops.filter((s) => s.platform === 'shopee');
    if (shopeeShops.length === 0) {
      setSyncShopId('');
      return;
    }
    if (!shopeeShops.some((s) => s.id === syncShopId)) {
      setSyncShopId(shopeeShops[0].id);
    }
  }, [shops, syncShopId]);

  // Manual Mapping Modal state
  const [mappingListing, setMappingListing] = useState<ChannelListing | null>(null);
  const [mappingSearch, setMappingSearch] = useState('');

  // Khởi tạo về Kho modal state
  const [initListing, setInitListing] = useState<ChannelListing | null>(null);
  const [initTitle, setInitTitle] = useState('');
  const [initAutoLink, setInitAutoLink] = useState(true);
  const [initVariants, setInitVariants] = useState<InitVariantRow[]>([]);

  const buildInitVariants = (item: ChannelListing): InitVariantRow[] => {
    const fromWarehouse = products.filter(
      (p) => p.shopeeItemId === item.channelId || String(p.shopeeId || '').startsWith(item.channelId)
    );
    if (fromWarehouse.length > 0) {
      return fromWarehouse.map((p, i) => ({
        id: `row-${i}`,
        label: p.modelName || p.title.split(' - ').pop() || `Phiên bản ${i + 1}`,
        sku: p.sku,
        price: p.sellingPrice || 0,
        weight: p.weight || 0,
        stock: p.stock || 0,
      }));
    }
    return [{
      id: 'row-0',
      label: 'Phiên bản 1',
      sku: item.sku || `SP-${item.channelId}`,
      price: 100000,
      weight: 0,
      stock: 100,
    }];
  };

  const handleOpenInitModal = (item: ChannelListing) => {
    setInitListing(item);
    setInitTitle(item.title);
    setInitAutoLink(true);
    setInitVariants(buildInitVariants(item));
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

  // 2. Open Manual Mapping Modal
  const handleOpenMapping = (listing: ChannelListing) => {
    setMappingListing(listing);
    setMappingSearch('');
  };

  // 3. Confirm Manual Mapping
  const handleMapProduct = (listingId: string, masterProductId: string) => {
    const masterProd = products.find(p => p.id === masterProductId);
    const listing = listings.find(l => l.id === listingId);
    if (!masterProd || !listing) return;

    saveListings(prev => prev.map(item => {
      if (item.id === listingId) {
        return {
          ...item,
          status: 'success',
          linkedProductId: masterProductId,
          sku: item.sku || masterProd.sku
        };
      }
      return item;
    }));

    onUpdateProduct(applyProductChannelLink(masterProd, listing), { save: true });

    setMappingListing(null);
    showToast(`Liên kết thành công sàn [${listing.shopName}] với kho sản phẩm chính!`);

    onAddLog({
      id: `log-${Date.now()}`,
      timestamp: new Date().toISOString(),
      channel: listing.platform,
      type: 'product_sync',
      status: 'success',
      message: `Liên kết thủ công sản phẩm sàn [ID: ${listing.channelId}] sang Kho chính sản phẩm [${masterProd.sku}]`
    });
  };

  // Handler to auto link a single channel product
  const handleAutoLinkIndividual = (item: ChannelListing) => {
    // 1. Try to match by SKU
    if (item.sku) {
      const matchedBySku = products.find(p => p.sku.toLowerCase() === item.sku.toLowerCase());
      if (matchedBySku) {
        saveListings(prev => prev.map(listing => {
          if (listing.id === item.id) {
            return {
              ...listing,
              status: 'success' as const,
              linkedProductId: matchedBySku.id
            };
          }
          return listing;
        }));
        onUpdateProduct(applyProductChannelLink(matchedBySku, item), { save: true });
        showToast(`⚡ Liên kết tự động thành công sản phẩm "${item.title}" với SKU "${item.sku}"!`);
        onAddLog({
          id: `log-${Date.now()}`,
          timestamp: new Date().toISOString(),
          channel: (item.platform === 'lazada' ? 'shopee' : item.platform) as any,
          type: 'product_sync',
          status: 'success',
          message: `Liên kết tự động thành công sản phẩm sàn [ID: ${item.channelId}] với Kho chính sản phẩm [${matchedBySku.sku}]`
        });
        return;
      }
    }

    // 2. Try to match by Name similarity
    const matchedByName = products.find(p => {
      const masterTitle = p.title.toLowerCase();
      const listingTitle = item.title.toLowerCase();
      return masterTitle.includes(listingTitle) || listingTitle.includes(masterTitle);
    });

    if (matchedByName) {
      saveListings(prev => prev.map(listing => {
        if (listing.id === item.id) {
          return {
            ...listing,
            status: 'success' as const,
            linkedProductId: matchedByName.id,
            sku: listing.sku || matchedByName.sku
          };
        }
        return listing;
      }));
      onUpdateProduct(applyProductChannelLink(matchedByName, item), { save: true });
      showToast(`⚡ Liên kết tự động thành công sản phẩm "${item.title}" theo Tên tương đồng!`);
      onAddLog({
        id: `log-${Date.now()}`,
        timestamp: new Date().toISOString(),
        channel: (item.platform === 'lazada' ? 'shopee' : item.platform) as any,
        type: 'product_sync',
        status: 'success',
        message: `Liên kết tự động thành công sản phẩm sàn [ID: ${item.channelId}] với Kho chính [${matchedByName.title}]`
      });
      return;
    }

    showToast(`Không tìm thấy sản phẩm có SKU hoặc Tên tương tự trong Kho chính.`);
  };

  const handleConfirmInitToWarehouse = () => {
    if (!initListing || !initTitle.trim()) return;

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
        if (cid.includes(':')) {
          const [itemPart, modelPart] = cid.split(':');
          shopeeItemId = (itemPart.match(/(\d{6,})/) || [])[1] || itemPart;
          shopeeModelId = (String(modelPart).match(/(\d+)/) || [])[1] || modelPart;
          shopeeId = shopeeModelId ? `${shopeeItemId}:${shopeeModelId}` : cid;
        } else {
          shopeeId = cid;
          shopeeItemId = cid;
        }
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

    createdProducts.forEach((p) => {
      if (onAddProduct) onAddProduct(p);
    });

    if (initAutoLink) {
      const primary = createdProducts[0];
      saveListings((prev) =>
        prev.map((listing) =>
          listing.id === initListing.id
            ? {
                ...listing,
                status: 'success' as const,
                linkedProductId: primary.id,
                sku: primary.sku,
              }
            : listing
        )
      );
    }

    showToast(`🎉 Đã tạo ${createdProducts.length} phiên bản sản phẩm "${initTitle}" về Kho gốc!`);
    onAddLog({
      id: `log-${Date.now()}`,
      timestamp: new Date().toISOString(),
      channel: (initListing.platform === 'lazada' ? 'shopee' : initListing.platform) as 'shopee' | 'tiktok' | 'woocommerce',
      type: 'product_sync',
      status: 'success',
      message: `Khởi tạo sản phẩm sàn [ID: ${initListing.channelId}] về Kho gốc (${createdProducts.length} phiên bản).`,
    });

    setInitListing(null);
  };

  const handleFetchChannelProducts = async () => {
    const shop = shops.find((s) => s.id === syncShopId) || shops.find((s) => s.platform === 'shopee');
    if (!shop || shop.platform !== 'shopee') {
      alert('Chưa có gian hàng Shopee được kết nối.');
      return;
    }

    setIsFetchingFromChannel(true);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 300000);

    try {
      const token = localStorage.getItem('admin_token');
      const res = await apiFetch('/api/shopee/channel-products/fetch', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ shopId: shop.shopId, fetchAll: true }),
      });
      const data = await parseJsonResponse<{
        success?: boolean;
        fetchedCount?: number;
        savedCount?: number;
        listings?: ChannelListing[];
        products?: Product[];
        listingsCount?: number;
        message?: string;
        error?: string;
      }>(res);

      if (!res.ok || data.success === false) {
        throw new Error(data?.message || data?.error || 'Tải dữ liệu từ sàn thất bại.');
      }

      // Server đã ghi channel_listings.json — hydrate UI từ response hoặc GET lại DB.
      if (Array.isArray(data.listings) && data.listings.length > 0) {
        listingsHydratedRef.current = true;
        setListings(data.listings);
      } else {
        await loadMappingListings({ silent: true });
      }

      if (onRefreshProducts) await onRefreshProducts();

      const count =
        data.listingsCount ??
        data.savedCount ??
        data.fetchedCount ??
        (Array.isArray(data.listings) ? data.listings.length : 0);
      showToast(data.message || `Đã tải và lưu DB thành công ${count} sản phẩm từ sàn Shopee`);
      onAddLog({
        id: `log-${Date.now()}`,
        timestamp: new Date().toISOString(),
        channel: 'shopee',
        type: 'product_sync',
        status: 'success',
        message: data.message || `Tải ${count} sản phẩm sàn từ gian hàng [${shop.shopName}]`,
      });
    } catch (err: unknown) {
      const e = err as { name?: string; message?: string };
      const message =
        e?.name === 'AbortError'
          ? 'Quá thời gian chờ (5 phút) khi tải dữ liệu từ Shopee. Vui lòng thử lại.'
          : e?.message || 'Tải dữ liệu từ sàn thất bại.';
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

  const handleAutoLinkBySku = async () => {
    setIsAutoLinking(true);
    try {
      const token = localStorage.getItem('admin_token');
      const res = await apiFetch('/api/shopee/channel-products/auto-link', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      const data = await parseJsonResponse<{
        success?: boolean;
        data?: {
          linkedCount?: number;
          listings?: ChannelListing[];
          alreadyLinked?: number;
          unlinkedRemaining?: number;
        };
        linkedCount?: number;
        listings?: ChannelListing[];
        message?: string;
        error?: string;
      }>(res);

      if (!res.ok || data.success === false) {
        throw new Error(data?.message || data?.error || 'Liên kết tự động thất bại.');
      }

      const payload = data.data || data;
      const linkedCount = payload.linkedCount ?? data.linkedCount ?? 0;
      const nextListings = payload.listings ?? data.listings;

      // Server đã ghi DB — chỉ hydrate UI, KHÔNG PUT lại / lưu từng SP (tránh timeout).
      if (Array.isArray(nextListings)) {
        listingsHydratedRef.current = true;
        setListings(nextListings);
      } else {
        const loaded = token ? await fetchMappingListingsFromServer(token) : null;
        if (loaded?.rows) {
          listingsHydratedRef.current = true;
          setListings(loaded.rows);
        }
      }

      if (onRefreshProducts) await onRefreshProducts();

      if (linkedCount > 0) {
        showToast(data.message || `Đã liên kết thành công ${linkedCount} sản phẩm`);
      } else {
        showToast('Không tìm thấy SKU trùng khớp để liên kết tự động.');
      }

      onAddLog({
        id: `log-${Date.now()}`,
        timestamp: new Date().toISOString(),
        channel: 'all',
        type: 'product_sync',
        status: linkedCount > 0 ? 'success' : 'failed',
        message: data.message || `Liên kết tự động: ${linkedCount} sản phẩm`,
      });
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
      setIsAutoLinking(false);
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
    // 1. Tab Status Filter
    if (activeSubTab === 'success' && item.status !== 'success') return false;
    if (activeSubTab === 'unlinked' && item.status !== 'unlinked') return false;
    if (activeSubTab === 'failed' && item.status !== 'failed') return false;

    // 2. Search query
    const matchesSearch = item.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
                          item.sku.toLowerCase().includes(searchQuery.toLowerCase()) ||
                          String(item.channelId || '').includes(searchQuery);
    if (!matchesSearch) return false;

    // 3. Shop filter
    if (selectedShopFilter !== 'all' && item.shopName !== selectedShopFilter) return false;

    return true;
  });

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

  // Master product search in manual mapping modal
  const filteredMasterProducts = products.filter(p => 
    p.title.toLowerCase().includes(mappingSearch.toLowerCase()) || 
    p.sku.toLowerCase().includes(mappingSearch.toLowerCase())
  );

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
            onClick={() => { setActiveSubTab('all'); setSelectedListingIds([]); }}
            className={`flex-1 sm:flex-initial px-4 py-2 rounded-lg text-xs font-bold transition-all ${
              activeSubTab === 'all' 
                ? 'bg-white text-blue-600 shadow-xs font-extrabold' 
                : 'text-gray-500 hover:text-gray-900'
            }`}
          >
            Tất cả sản phẩm ({tabCounts.all})
          </button>
          
          <button
            onClick={() => { setActiveSubTab('success'); setSelectedListingIds([]); }}
            className={`flex-1 sm:flex-initial px-4 py-2 rounded-lg text-xs font-bold transition-all ${
              activeSubTab === 'success' 
                ? 'bg-white text-emerald-600 shadow-xs font-extrabold' 
                : 'text-gray-500 hover:text-gray-900'
            }`}
          >
            Liên kết thành công ({tabCounts.success})
          </button>

          <button
            onClick={() => { setActiveSubTab('unlinked'); setSelectedListingIds([]); }}
            className={`flex-1 sm:flex-initial px-4 py-2 rounded-lg text-xs font-bold transition-all ${
              activeSubTab === 'unlinked' 
                ? 'bg-white text-amber-600 shadow-xs font-extrabold' 
                : 'text-gray-500 hover:text-gray-900'
            }`}
          >
            Chưa liên kết ({tabCounts.unlinked})
          </button>

          <button
            onClick={() => { setActiveSubTab('failed'); setSelectedListingIds([]); }}
            className={`flex-1 sm:flex-initial px-4 py-2 rounded-lg text-xs font-bold transition-all ${
              activeSubTab === 'failed' 
                ? 'bg-white text-rose-600 shadow-xs font-extrabold' 
                : 'text-gray-500 hover:text-gray-900'
            }`}
          >
            Liên kết thất bại ({tabCounts.failed})
          </button>
        </div>

        {/* Action: Tải dữ liệu sàn + Liên kết tự động (tách riêng) */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 w-full sm:w-auto">
          <div className="relative min-w-[160px]">
            <select
              value={syncShopId}
              onChange={(e) => setSyncShopId(e.target.value)}
              disabled={isFetchingFromChannel || isAutoLinking}
              className="w-full pl-3 pr-8 py-2.5 bg-white border border-gray-200 rounded-xl text-xs font-bold text-gray-700 focus:outline-none focus:border-blue-500 cursor-pointer disabled:opacity-50"
            >
              {shops.filter((s) => s.platform === 'shopee').map((shop) => (
                <option key={shop.id} value={shop.id}>
                  {shop.shopName}
                </option>
              ))}
            </select>
            <Store className="w-3.5 h-3.5 text-gray-400 absolute right-2.5 top-3 pointer-events-none" />
          </div>

          <button
            onClick={() => void loadMappingListings()}
            type="button"
            disabled={listingsLoading || isFetchingFromChannel}
            className="flex-1 sm:flex-none px-4 py-2.5 bg-slate-700 hover:bg-slate-800 text-white text-xs font-extrabold rounded-xl transition-all flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
          >
            {listingsLoading ? (
              <>
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                <span>Đang tải DB...</span>
              </>
            ) : (
              <>
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Tải danh sách mapping</span>
              </>
            )}
          </button>

          <button
            onClick={handleFetchChannelProducts}
            type="button"
            disabled={isFetchingFromChannel || isAutoLinking}
            className="flex-1 sm:flex-none px-4 py-2.5 bg-white border border-blue-500 hover:bg-blue-50 text-blue-600 text-xs font-extrabold rounded-xl transition-all shadow-2xs flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
          >
            {isFetchingFromChannel ? (
              <>
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                <span>Đang tải...</span>
              </>
            ) : (
              <>
                <ArrowDownToLine className="w-3.5 h-3.5" />
                <span>Tải dữ liệu từ sàn</span>
              </>
            )}
          </button>

          <button
            onClick={handleAutoLinkBySku}
            type="button"
            disabled={isFetchingFromChannel || isAutoLinking}
            className="flex-1 sm:flex-none px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-extrabold rounded-xl transition-all shadow-md shadow-emerald-500/20 flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
          >
            {isAutoLinking ? (
              <>
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                <span>Đang liên kết...</span>
              </>
            ) : (
              <>
                <Sparkles className="w-3.5 h-3.5" />
                <span>Liên kết tự động</span>
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
                  onClick={() => { setSelectedShopFilter('all'); setShowShopFilterDropdown(false); }}
                  className="w-full text-left px-4 py-2 text-xs font-bold text-gray-700 hover:bg-slate-50 flex items-center gap-2"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-500"></span>
                  <span>Tất cả gian hàng</span>
                </button>
                {uniqueShopsInListings.map(shopName => (
                  <button
                    key={shopName}
                    onClick={() => { setSelectedShopFilter(shopName); setShowShopFilterDropdown(false); }}
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
              onChange={(e) => setSearchQuery(e.target.value)}
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
                filteredListings.map(item => {
                  const fromProps = products.find((p) => p.id === item.linkedProductId);
                  const linkedTitle =
                    fromProps?.title ||
                    item.linkedProduct?.title ||
                    item.linkedProductTitle ||
                    '';
                  const linkedSku =
                    fromProps?.sku ||
                    item.linkedProduct?.sku ||
                    item.linkedProductSku ||
                    '';
                  const showLinked =
                    item.status === 'success' &&
                    !!item.linkedProductId &&
                    (!!linkedTitle || !!linkedSku || !!item.linkedProductId);
                  return (
                    <tr key={item.id} className="hover:bg-slate-50/50 transition-colors">
                      <td className="p-4 text-center">
                        <input
                          type="checkbox"
                          checked={selectedListingIds.includes(item.id)}
                          onChange={() => handleToggleSelectListing(item.id)}
                          className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 w-4 h-4 cursor-pointer"
                        />
                      </td>
                      
                      {/* Double arrow indicator >> shown in mockup */}
                      <td className="p-4 text-center">
                        <ChevronsRight className="w-4 h-4 text-blue-400 font-bold" />
                      </td>

                      {/* Tên sản phẩm */}
                      <td className="p-4">
                        <div className="flex items-start gap-3">
                          {item.imageUrl ? (
                            <img
                              src={item.imageUrl}
                              alt={item.title}
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
                              {item.title}
                            </p>
                            
                            {/* SKU under title */}
                            <p className="text-[10px] font-mono text-gray-400 font-bold flex items-center gap-1">
                              <span>SKU:</span>
                              <span className={item.sku ? 'text-gray-600 font-semibold' : 'text-amber-600 bg-amber-50 px-1 rounded'}>
                                {item.sku || 'Chưa có SKU'}
                              </span>
                            </p>

                            {/* ID with copy icon */}
                            <div className="flex items-center gap-1.5 text-[10px] text-gray-400 font-semibold">
                              <span>ID: {item.channelId}</span>
                              <button
                                type="button"
                                onClick={() => handleCopyId(item.channelId)}
                                className="p-0.5 hover:bg-gray-100 rounded text-gray-400 hover:text-blue-500 transition-all cursor-pointer"
                                title="Sao chép ID"
                              >
                                <Copy className="w-3 h-3" />
                              </button>
                            </div>
                          </div>
                        </div>
                      </td>

                      {/* Gian hàng column showing Platform and Channel Name */}
                      <td className="p-4">
                        <div className="flex items-center gap-1.5 font-bold text-gray-700">
                          {item.platform === 'shopee' && <span className="bg-orange-500 text-white w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-black shrink-0">S</span>}
                          {item.platform === 'tiktok' && <span className="bg-black text-white w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-black shrink-0">T</span>}
                          {item.platform === 'lazada' && <span className="bg-blue-600 text-white w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-black shrink-0">L</span>}
                          {item.platform === 'woocommerce' && <span className="bg-indigo-600 text-white w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-black shrink-0">W</span>}
                          <span className="truncate max-w-[140px] text-xs font-semibold">{item.shopName}</span>
                        </div>
                      </td>

                      {/* Connection status badge */}
                      <td className="p-4">
                        {item.status === 'success' && (
                          <span className="text-blue-600 font-bold text-[11px] bg-blue-50/50 border border-blue-200 px-2 py-1 rounded-lg">
                            Liên kết thành công
                          </span>
                        )}
                        {item.status === 'unlinked' && (
                          <span className="text-amber-600 font-bold text-[11px] bg-amber-50/80 border border-amber-200 px-2 py-1 rounded-lg flex items-center gap-1 w-fit">
                            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                            <span>Chưa liên kết</span>
                          </span>
                        )}
                        {item.status === 'failed' && (
                          <span className="text-rose-600 font-bold text-[11px] bg-rose-50/80 border border-rose-200 px-2 py-1 rounded-lg flex items-center gap-1 w-fit">
                            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                            <span>Liên kết thất bại</span>
                          </span>
                        )}
                      </td>

                      {/* Linked master product info */}
                      <td className="p-4">
                        {showLinked ? (
                          <div className="space-y-0.5">
                            <p className="font-extrabold text-blue-600 text-xs hover:underline cursor-pointer line-clamp-1 max-w-[280px]">
                              {linkedTitle || `Kho gốc #${item.linkedProductId}`}
                            </p>
                            <p className="font-mono font-bold text-gray-400 text-[10px]">
                              SKU: {linkedSku || '—'}
                            </p>
                          </div>
                        ) : (
                          <span className="text-gray-400 font-bold text-xs">—</span>
                        )}
                      </td>

                      {/* Action buttons exactly matching mockup */}
                      <td className="p-4 text-center">
                        {item.status === 'success' ? (
                          <button
                            onClick={() => handleUnlink(item.id)}
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
                                onClick={() => handleAutoLinkIndividual(item)}
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
                onClick={() => setInitListing(null)}
                className="p-1 hover:bg-gray-200 rounded-full transition-all text-gray-400 hover:text-gray-700"
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
                  <p className="text-xs text-gray-500 font-mono mt-0.5">ID sàn: {initListing.channelId}</p>
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
                <h4 className="text-xs font-black text-gray-700 uppercase tracking-wide">Phiên bản sản phẩm</h4>
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
                className="px-5 py-2.5 bg-white hover:bg-gray-100 border border-gray-200 text-gray-700 font-extrabold text-xs rounded-xl"
              >
                Hủy
              </button>
              <button
                type="button"
                onClick={handleConfirmInitToWarehouse}
                disabled={!initTitle.trim()}
                className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 text-white font-extrabold text-xs rounded-xl flex items-center gap-1.5"
              >
                <ArrowDownToLine className="w-3.5 h-3.5" />
                Khởi tạo về Kho
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
                    <span>ID: <strong className="text-gray-700 font-mono">{mappingListing.channelId}</strong></span>
                  </div>
                </div>
              </div>

              {/* Master products search section */}
              <div className="space-y-2">
                <label className="text-xs font-black text-gray-700 block">
                  Tìm sản phẩm trong Kho chính để liên kết
                </label>
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
                    Không tìm thấy sản phẩm Kho chính nào khớp với từ khóa tìm kiếm.
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
