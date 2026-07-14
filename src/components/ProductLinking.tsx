import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Product, SyncLog, ConnectedShop } from '../types';
import { purgeLegacyCatalogCache } from '../utils/catalogStorage';
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
    linked.shopeeId = listing.channelId;
    linked.shopeeItemId = listing.channelId;
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

export default function ProductLinking({ products, shops, onAddLog, onUpdateProduct, onAddProduct, onRefreshProducts }: ProductLinkingProps) {
  const [listings, setListings] = useState<ChannelListing[]>([]);
  const [listingsLoading, setListingsLoading] = useState(true);
  const listingsHydratedRef = useRef(false);

  const persistListings = useCallback(async (rows: ChannelListing[]): Promise<boolean> => {
    const token = localStorage.getItem('admin_token');
    if (!token) return false;
    try {
      const res = await fetch('/api/mapping-products', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ listings: rows }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        console.error('[ProductLinking] Lưu mapping thất bại:', errBody);
        return false;
      }
      return true;
    } catch (err) {
      console.error('[ProductLinking] Lưu mapping thất bại:', err);
      return false;
    }
  }, []);

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

  useEffect(() => {
    const load = async () => {
      const token = localStorage.getItem('admin_token');
      if (!token) {
        setListingsLoading(false);
        return;
      }
      setListingsLoading(true);
      try {
        const res = await fetch('/api/mapping-products', {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
          console.error('[ProductLinking] Tải mapping thất bại:', data);
          return;
        }
        const rows: ChannelListing[] = Array.isArray(data.listings) ? data.listings : [];
        listingsHydratedRef.current = true;
        setListings(rows);
        // #region agent log
        fetch('http://127.0.0.1:7554/ingest/bc993c61-1b63-4f42-8c97-c42133e3ec03',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'aebe04'},body:JSON.stringify({sessionId:'aebe04',runId:'mapping-fix',hypothesisId:'H5',location:'ProductLinking.tsx:load',message:'mapping loaded on mount',data:{count:rows.length,success:data.success},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
      } catch (err) {
        console.error('[ProductLinking] Tải mapping thất bại:', err);
      } finally {
        setListingsLoading(false);
      }
    };
    void load();
  }, []);

  useEffect(() => {
    if (!listingsHydratedRef.current || listings.length > 0 || products.length === 0) return;
    const derived = buildListingsFromProducts(products, shops);
    if (derived.length > 0) saveListings(derived);
  }, [products, shops, listings.length, saveListings]);

  // Tab state matching Image 1
  const [activeSubTab, setActiveSubTab] = useState<'all' | 'success' | 'unlinked' | 'failed'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedShopFilter, setSelectedShopFilter] = useState<string>('all');
  const [showShopFilterDropdown, setShowShopFilterDropdown] = useState(false);
  
  // Modals state
  const [showSyncModal, setShowSyncModal] = useState(false);
  const [syncShopId, setSyncShopId] = useState('');

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
  const [syncTimeframe, setSyncTimeframe] = useState<'all' | '24h' | 'custom'>('24h');
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<string[]>([]);

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
  
  // Toast notifications
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage(null);
    }, 3500);
  };

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
        shopeeId: initListing.platform === 'shopee' ? initListing.channelId : undefined,
        shopeeItemId: initListing.platform === 'shopee' ? initListing.channelId : undefined,
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

  // 4. Quick Auto Link ("Liên kết nhanh")
  const handleQuickLink = () => {
    let linkCount = 0;
    const newListings = listings.map(listing => {
      if (listing.status !== 'success') {
        // Try to match by SKU
        if (listing.sku) {
          const matchedBySku = products.find(p => p.sku.toLowerCase() === listing.sku.toLowerCase());
          if (matchedBySku) {
            linkCount++;
            return {
              ...listing,
              status: 'success' as const,
              linkedProductId: matchedBySku.id
            };
          }
        }
        
        // Try to match by name similarity
        const matchedByName = products.find(p => {
          const masterTitle = p.title.toLowerCase();
          const listingTitle = listing.title.toLowerCase();
          return masterTitle.includes(listingTitle) || listingTitle.includes(masterTitle);
        });

        if (matchedByName) {
          linkCount++;
          return {
            ...listing,
            status: 'success' as const,
            linkedProductId: matchedByName.id,
            sku: listing.sku || matchedByName.sku
          };
        }
      }
      return listing;
    });

    if (linkCount > 0) {
      saveListings(newListings);
      newListings.forEach((listing) => {
        if (listing.status === 'success' && listing.linkedProductId) {
          const master = products.find((p) => p.id === listing.linkedProductId);
          if (master) onUpdateProduct(applyProductChannelLink(master, listing), { save: true });
        }
      });
      showToast(`⚡ Thành công: Đã liên kết tự động thành công ${linkCount} sản phẩm có SKU/Tên tương đồng!`);
      onAddLog({
        id: `log-${Date.now()}`,
        timestamp: new Date().toISOString(),
        channel: 'all',
        type: 'product_sync',
        status: 'success',
        message: `Đồng bộ liên kết tự động hàng loạt thành công cho ${linkCount} sản phẩm sàn.`
      });
    } else {
      showToast(`Không tìm thấy sản phẩm nào có SKU hoặc Tên tương tự để tự động liên kết.`);
    }
  };

  // 5. Trigger Sync listings from channel — pulls the REAL listed items from
  // Shopee (same v2.product.get_item_list -> get_item_base_info flow used by
  // "Khởi tạo từ Shopee API" in the warehouse tab) and reconciles them against
  // the master product list to refresh each listing's mapping status.
  const handleStartListingSync = async () => {
    setIsSyncing(true);
    setSyncProgress(["🔌 Đang kết nối API v2 Shopee (get_item_list)..."]);

    const shop = shops.find(s => s.id === syncShopId) || shops.find(s => s.platform === 'shopee');

    if (!shop || shop.platform !== 'shopee') {
      const message = 'Chức năng đồng bộ dữ liệu thật hiện chỉ hỗ trợ gian hàng Shopee.';
      setSyncProgress(prev => [...prev, `❌ Lỗi: ${message}`]);
      alert(message);
      setIsSyncing(false);
      return;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 90000);

    try {
      const token = localStorage.getItem('admin_token');
      const res = await fetch('/api/shopee/products/sync', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify({ shopId: shop.shopId })
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data?.message || data?.error || 'Đồng bộ dữ liệu sản phẩm sàn thất bại.');
      }

      const realItems: Product[] = data.products || [];
      if (realItems.length === 0) {
        throw new Error('Shopee không trả về sản phẩm nào (0 item). Vui lòng thử lại.');
      }

      const serverListings: ChannelListing[] = Array.isArray(data.listings) ? data.listings : [];

      setSyncProgress(prev => [
        ...prev,
        `📥 Đã lấy ${realItems.length} sản phẩm thật đang bán từ get_item_list + get_item_base_info...`,
        "⚙️ Đang đối chiếu với Kho chính & nạp lại danh sách Liên kết...",
      ]);

      if (serverListings.length > 0) {
        listingsHydratedRef.current = true;
        setListings(serverListings);
        await persistListings(serverListings);
      } else {
        saveListings(prev => {
          const byKey = new Map<string, ChannelListing>(prev.map(l => [`${l.platform}::${l.channelId}`, l]));

          realItems.forEach(item => {
            const channelId = String(item.shopeeId || item.shopeeItemId || '');
            if (!channelId) return;
            const key = `shopee::${channelId}`;
            const existing = byKey.get(key);

            const matchedMaster =
              products.find(p => (p.shopeeItemId && String(p.shopeeItemId) === channelId) || (p.shopeeId && p.shopeeId === channelId)) ||
              (item.sku ? products.find(p => p.sku.toLowerCase() === item.sku.toLowerCase()) : undefined);

            const status: ChannelListing['status'] = matchedMaster
              ? 'success'
              : (existing?.status === 'failed' ? 'failed' : 'unlinked');

            byKey.set(key, {
              id: existing?.id || `cl-shopee-${channelId}`,
              title: item.title,
              sku: item.sku,
              imageUrl: item.avatarUrl || item.imageUrl,
              channelId,
              platform: 'shopee',
              shopName: shop.shopName,
              status,
              linkedProductId: matchedMaster?.id || existing?.linkedProductId,
            });
          });

          return Array.from(byKey.values());
        });
      }

      if (onRefreshProducts) {
        await onRefreshProducts();
      }

      setSyncProgress(prev => [...prev, `🎉 HOÀN TẤT: Đã đồng bộ ${realItems.length} sản phẩm thật từ gian hàng [${shop.shopName}] và cập nhật trạng thái liên kết!`]);
      showToast(`Đã đồng bộ thành công ${realItems.length} sản phẩm thật từ gian hàng ${shop.shopName}!`);

      onAddLog({
        id: `log-${Date.now()}`,
        timestamp: new Date().toISOString(),
        channel: 'shopee',
        type: 'product_sync',
        status: 'success',
        message: `Đồng bộ ${realItems.length} sản phẩm thật từ gian hàng [${shop.shopName}] qua API v2 Shopee và cập nhật trạng thái liên kết thành công.`
      });

      setShowSyncModal(false);
    } catch (err: any) {
      const message = err?.name === 'AbortError'
        ? 'Quá thời gian chờ (90s) khi đồng bộ với Shopee. Vui lòng thử lại.'
        : (err?.message || 'Đồng bộ dữ liệu sản phẩm sàn thất bại.');
      setSyncProgress(prev => [...prev, `❌ Lỗi: ${message}`]);
      alert(`Đồng bộ dữ liệu sản phẩm sàn thất bại: ${message}`);

      onAddLog({
        id: `log-${Date.now()}`,
        timestamp: new Date().toISOString(),
        channel: 'shopee',
        type: 'product_sync',
        status: 'failed',
        message: `Đồng bộ dữ liệu sản phẩm sàn thất bại: ${message}`
      });
    } finally {
      clearTimeout(timeoutId);
      setIsSyncing(false);
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
                          item.channelId.includes(searchQuery);
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

        {/* Action Buttons: "Liên kết nhanh" & "Cập nhật dữ liệu sản phẩm" exactly as shown in Image 1 */}
        <div className="flex items-center gap-2.5 w-full sm:w-auto">
          <button
            onClick={handleQuickLink}
            type="button"
            className="flex-1 sm:flex-none px-4 py-2.5 bg-white border border-blue-500 hover:bg-blue-50 text-blue-600 text-xs font-extrabold rounded-xl transition-all shadow-2xs flex items-center justify-center gap-1.5 cursor-pointer"
          >
            <Link2 className="w-3.5 h-3.5" />
            <span>Liên kết nhanh</span>
          </button>

          <button
            onClick={() => setShowSyncModal(true)}
            type="button"
            className="flex-1 sm:flex-none px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-extrabold rounded-xl transition-all shadow-sm flex items-center justify-center gap-1.5 cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Cập nhật dữ liệu sản phẩm</span>
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
                  const linkedProduct = products.find(p => p.id === item.linkedProductId);
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
                        {item.status === 'success' && linkedProduct ? (
                          <div className="space-y-0.5">
                            <p className="font-extrabold text-blue-600 text-xs hover:underline cursor-pointer line-clamp-1 max-w-[280px]">
                              {linkedProduct.title}
                            </p>
                            <p className="font-mono font-bold text-gray-400 text-[10px]">
                              SKU: {linkedProduct.sku}
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
      {/* MODAL: SYNC PRODUCTS FROM CHANNELS (MATCHING IMAGE 2 EXACTLY) */}
      {/* ========================================================================= */}
      {showSyncModal && (
        <div className="fixed inset-0 bg-gray-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in">
          <div className="bg-white rounded-3xl max-w-lg w-full overflow-hidden shadow-2xl flex flex-col border border-gray-100">
            {/* Header with 'X' close button */}
            <div className="p-5 border-b border-gray-100 flex items-center justify-between bg-slate-50">
              <h3 className="text-sm font-black text-gray-800 uppercase tracking-wider">
                Cập nhật dữ liệu sản phẩm từ gian hàng
              </h3>
              <button
                onClick={() => { if (!isSyncing) setShowSyncModal(false); }}
                className="p-1 hover:bg-gray-200 rounded-full transition-all text-gray-400 hover:text-gray-700"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-6 space-y-5">
              {/* Informative text box exactly like Image 2 */}
              <div className="bg-amber-50/70 border border-amber-200/50 p-4 rounded-xl text-xs text-amber-800 leading-relaxed font-semibold">
                Sapo sẽ đồng bộ các cập nhật dữ liệu của sản phẩm trong khoảng thời gian mà bạn đã chọn. 
                Các thao tác phát sinh ngoài thời gian bạn đã chọn sẽ không được đồng bộ.
              </div>

              {/* Shop Selector Dropdown */}
              <div className="space-y-1.5">
                <label className="text-xs font-black text-gray-700">Lựa chọn gian hàng</label>
                <div className="relative">
                  <select
                    value={syncShopId}
                    onChange={(e) => setSyncShopId(e.target.value)}
                    disabled={isSyncing}
                    className="w-full pl-4 pr-10 py-3 bg-white border border-gray-250 rounded-xl text-xs font-bold text-gray-700 focus:outline-none focus:border-blue-500 cursor-pointer disabled:bg-gray-50"
                  >
                    {shops.map(shop => (
                      <option key={shop.id} value={shop.id}>
                        {shop.platform.toUpperCase()} - {shop.shopName}
                      </option>
                    ))}
                    <option value="shop-lazada-1">LAZADA - Lazada - Linh Kiện Audio HCM</option>
                  </select>
                  <Store className="w-4 h-4 text-gray-400 absolute right-3 top-3.5 pointer-events-none" />
                </div>
              </div>

              {/* Timeframe Radios */}
              <div className="space-y-2.5">
                <label className="text-xs font-black text-gray-700 block">Lựa chọn thời gian cập nhật</label>
                
                <div className="space-y-2">
                  <label className="flex items-center gap-3 p-3 bg-slate-50 hover:bg-slate-100/70 rounded-xl border border-gray-100 cursor-pointer transition-all">
                    <input
                      type="radio"
                      name="sync_timeframe"
                      checked={syncTimeframe === 'all'}
                      onChange={() => setSyncTimeframe('all')}
                      disabled={isSyncing}
                      className="w-4 h-4 text-blue-600 focus:ring-blue-500 border-gray-300"
                    />
                    <div>
                      <p className="text-xs font-bold text-gray-800">Toàn thời gian</p>
                      <p className="text-[10px] text-gray-400 mt-0.5">Hệ thống sẽ xử lý chậm khi bạn có nhiều sản phẩm</p>
                    </div>
                  </label>

                  <label className="flex items-center gap-3 p-3 bg-slate-50 hover:bg-slate-100/70 rounded-xl border border-gray-100 cursor-pointer transition-all">
                    <input
                      type="radio"
                      name="sync_timeframe"
                      checked={syncTimeframe === '24h'}
                      onChange={() => setSyncTimeframe('24h')}
                      disabled={isSyncing}
                      className="w-4 h-4 text-blue-600 focus:ring-blue-500 border-gray-300"
                    />
                    <div>
                      <p className="text-xs font-bold text-gray-800">Từ 24h trước</p>
                      <p className="text-[10px] text-gray-400 mt-0.5">Chỉ đồng bộ các sản phẩm phát sinh thay đổi trong vòng 24 giờ qua (Khuyên dùng)</p>
                    </div>
                  </label>

                  <label className="flex items-center gap-3 p-3 bg-slate-50 hover:bg-slate-100/70 rounded-xl border border-gray-100 cursor-pointer transition-all">
                    <input
                      type="radio"
                      name="sync_timeframe"
                      checked={syncTimeframe === 'custom'}
                      onChange={() => setSyncTimeframe('custom')}
                      disabled={isSyncing}
                      className="w-4 h-4 text-blue-600 focus:ring-blue-500 border-gray-300"
                    />
                    <div>
                      <p className="text-xs font-bold text-gray-800">Cập nhật theo sản phẩm</p>
                      <p className="text-[10px] text-gray-400 mt-0.5">Lựa chọn các sản phẩm sỉ cụ thể để đồng bộ tức thời</p>
                    </div>
                  </label>
                </div>
              </div>

              {/* Progress Logger during sync */}
              {isSyncing && (
                <div className="p-4 bg-slate-950 rounded-2xl text-xs font-mono text-emerald-400 space-y-1.5 max-h-40 overflow-y-auto shadow-inner border border-slate-800">
                  <div className="flex items-center gap-2 mb-1.5">
                    <RefreshCw className="w-3.5 h-3.5 animate-spin text-emerald-400" />
                    <span className="font-bold">TIẾN TRÌNH API ĐỒNG BỘ:</span>
                  </div>
                  {syncProgress.map((p, idx) => (
                    <p key={idx} className="animate-pulse">{p}</p>
                  ))}
                </div>
              )}
            </div>

            {/* Footer Buttons exactly like Image 2 */}
            <div className="p-4 bg-slate-50 border-t border-gray-100 flex justify-end gap-3.5">
              <button
                type="button"
                onClick={() => { if (!isSyncing) setShowSyncModal(false); }}
                disabled={isSyncing}
                className="px-5 py-2.5 bg-white hover:bg-gray-100 border border-gray-200 text-gray-700 font-extrabold text-xs rounded-xl transition-all cursor-pointer disabled:opacity-50"
              >
                Thoát
              </button>
              
              <button
                type="button"
                onClick={handleStartListingSync}
                disabled={isSyncing}
                className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-extrabold text-xs rounded-xl transition-all shadow-md shadow-blue-500/15 flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
              >
                {isSyncing ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>Đang đồng bộ...</span>
                  </>
                ) : (
                  <span>Cập nhật dữ liệu sản phẩm</span>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

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
