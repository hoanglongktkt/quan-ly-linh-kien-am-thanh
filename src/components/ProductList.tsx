import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Product, ConnectedShop, SyncLog, Supplier, BulkSaveProductUpdate, SystemFee, getProductChildren } from '../types';
import ProductDetailModal, {
  buildProductGroups,
  formatPriceRange,
  isJunkCategoryLabel,
  type ProductGroupRow,
} from './ProductDetailModal';
import BulkEditModal from './BulkEditModal';
import BulkPriceEditModal from './BulkPriceEditModal';
import ImportPriceModal from './ImportPriceModal';
import ProductLinking from './ProductLinking';
import InventoryAudit from './InventoryAudit';
import { parseJsonResponse, formatShopeeSyncAlertLines } from '../utils/apiClient';
import { calculateProfitWithSystemFees } from '../utils/profitCalculator';
import { buildShopeeSyncPayload } from '../utils/shopeeSyncPayload';
import { clearInventoryBrowserCache } from '../utils/catalogStorage';
import CurrencyInput from './CurrencyInput';
import { 
  Plus, 
  Search, 
  Filter, 
  Edit3, 
  Trash2, 
  Check, 
  Sparkles, 
  AlertCircle, 
  TrendingUp, 
  ShoppingBag,
  Store,
  ExternalLink,
  Package,
  RefreshCw,
  Coins,
  Database,
  ArrowRightLeft,
  ClipboardList,
  X,
  CheckCircle2,
  AlertTriangle,
  ChevronRight,
  ChevronDown,
  Save,
  Loader2,
  ArrowUp,
  ArrowDown,
  ArrowUpDown
} from 'lucide-react';

interface ProductListProps {
  products: Product[];
  onAddProduct: (product: Product) => void;
  onUpdateProduct: (product: Product, opts?: { save?: boolean }) => void;
  onDeleteProduct: (id: string) => void;
  onReplaceProducts?: (products: Product[]) => void;
  onBulkSave?: (updates: BulkSaveProductUpdate[]) => Promise<boolean>;
  onSyncItemVariants?: (itemId: string) => Promise<Product[] | null>;
  onRefreshProducts?: (opts?: {
    page?: number;
    append?: boolean;
    pageSize?: number;
    forceRefresh?: boolean;
    search?: string;
  }) => Promise<void>;
  onProductsUpdated?: (products: Product[]) => void;
  onBulkSelect: (selectedIds: string[]) => void;
  selectedIds: string[];
  highlightProductId?: string | null;
  onClearHighlight?: () => void;
  shops?: ConnectedShop[];
  suppliers?: Supplier[];
  onAddLog?: (log: SyncLog) => void;
  productsLoading?: boolean;
  systemFees?: SystemFee[];
  productsMeta?: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
    hasMore: boolean;
  };
}

function calculateEstimatedProductProfit(product: Product, systemFees: SystemFee[]): number {
  return calculateProfitWithSystemFees(product.sellingPrice, product.importPrice, systemFees);
}

/**
 * Map Shop ID → tên hiển thị trên toast đồng bộ thành công.
 * Thêm cặp ID mới tại đây khi có shop khác.
 */
const SHOPEE_SYNC_SUCCESS_SHOP_NAMES: Record<string, string> = {
  '831052930': 'ÂM THANH',
  '4127421': 'LK AT',
};

function resolveShopeeSyncShopName(shopId: string): string {
  return SHOPEE_SYNC_SUCCESS_SHOP_NAMES[shopId] || `Shop ${shopId}`;
}

/** Đổi `[831052930] ...` thành toast thân thiện với tên shop. */
function formatShopeeSyncSuccessToast(shopeeMessage?: string | null): string {
  const raw = String(shopeeMessage ?? '');
  const ids = [...raw.matchAll(/\[(\d+)\]/g)].map((m) => m[1]);
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) {
    return 'Đồng bộ Shopee thành công! Đã cập nhật giá và tồn kho.';
  }
  const names = uniqueIds.map(resolveShopeeSyncShopName).join(', ');
  return `Đồng bộ Shopee (${names}) thành công! Đã cập nhật giá và tồn kho.`;
}

export default function ProductList({ 
  products, 
  onAddProduct, 
  onUpdateProduct, 
  onDeleteProduct, 
  onReplaceProducts,
  onBulkSave,
  onSyncItemVariants,
  onRefreshProducts,
  onProductsUpdated,
  onBulkSelect,
  selectedIds,
  highlightProductId,
  onClearHighlight,
  shops = [],
  suppliers = [],
  onAddLog = () => {},
  productsLoading = false,
  systemFees = [],
  productsMeta,
}: ProductListProps) {
  // Listen for external highlight trigger
  React.useEffect(() => {
    if (highlightProductId) {
      const prod = products.find(p => p.id === highlightProductId);
      if (prod) {
        setActiveProduct(prod);
      }
      if (onClearHighlight) {
        onClearHighlight();
      }
    }
  }, [highlightProductId, products, onClearHighlight]);

  // Master sub-tab selection: 'warehouse' (Kho sản phẩm chính) or 'linking' (Liên kết sản phẩm)
  const [subTab, setSubTab] = useState<'warehouse' | 'linking' | 'audit'>('warehouse');

  // F5 / mở tab Kho gốc → tự động tải danh sách từ DB (không bắt user bấm nút).
  const warehouseLoadedRef = React.useRef(false);
  useEffect(() => {
    if (subTab !== 'warehouse') return;
    if (warehouseLoadedRef.current) return;
    if (products.length > 0) {
      warehouseLoadedRef.current = true;
      return;
    }
    warehouseLoadedRef.current = true;
    void onRefreshProducts?.({ page: 1, append: false });
  }, [subTab, products.length, onRefreshProducts]);

  // Marketplace initialization state
  const [showInitModal, setShowInitModal] = useState(false);
  const [showImportPriceModal, setShowImportPriceModal] = useState(false);
  const [initPlatform, setInitPlatform] = useState<'shopee' | 'tiktok'>('shopee');
  const [initShopId, setInitShopId] = useState('');
  const [isInitializing, setIsInitializing] = useState(false);
  const [initProgress, setInitProgress] = useState<string[]>([]);
  const [initToast, setInitToast] = useState<string | null>(null);
  const [isClearingInventory, setIsClearingInventory] = useState(false);

  const initPlatformShops = useMemo(
    () => shops.filter((s) => s.platform === initPlatform),
    [shops, initPlatform]
  );

  useEffect(() => {
    if (initPlatformShops.length === 0) {
      setInitShopId('');
      return;
    }
    if (!initPlatformShops.some((s) => s.id === initShopId)) {
      setInitShopId(initPlatformShops[0].id);
    }
  }, [initPlatformShops, initShopId]);

  // Search & Filter state
  const [search, setSearch] = useState('');
  const [serverSearch, setServerSearch] = useState('');
  const searchDebounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchInitRef = React.useRef(true);
  const onRefreshProductsRef = React.useRef(onRefreshProducts);
  onRefreshProductsRef.current = onRefreshProducts;
  const [channelFilter, setChannelFilter] = useState<'all' | 'shopee' | 'tiktok' | 'none'>('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [stockFilter, setStockFilter] = useState<'all' | 'low' | 'out'>('all');
  const [sortField, setSortField] = useState<'stock' | 'sellingPrice' | null>(null);
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc' | null>(null);

  const runProductSearch = (raw: string) => {
    const q = raw.replace(/\s+/g, ' ').trim();
    setServerSearch(q);
    void onRefreshProductsRef.current?.({ page: 1, append: false, search: q });
  };

  const triggerSearchNow = () => {
    if (searchDebounceRef.current) {
      clearTimeout(searchDebounceRef.current);
      searchDebounceRef.current = null;
    }
    runProductSearch(search);
  };

  // Server-side search: debounce 400ms, luôn reset page về 1 khi đổi từ khóa.
  useEffect(() => {
    if (searchInitRef.current) {
      searchInitRef.current = false;
      return;
    }
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => {
      runProductSearch(search);
    }, 400);
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, [search]);

  // Image zoom overlay
  const [selectedImage, setSelectedImage] = useState<string | null>(null);

  // Detail Modal state
  const [activeProduct, setActiveProduct] = useState<Product | null>(null);
  const [syncingProductId, setSyncingProductId] = useState<string | null>(null);
  const [savingImportPriceId, setSavingImportPriceId] = useState<string | null>(null);
  const [savingAllVariantsParentId, setSavingAllVariantsParentId] = useState<string | null>(null);
  const [actionToast, setActionToast] = useState<string | null>(null);
  const [actionToastOk, setActionToastOk] = useState(false);
  const [shopeeSyncError, setShopeeSyncError] = useState<string[] | null>(null);
  const actionToastTimerRef = useRef<number | null>(null);

  const showActionToast = (message: string, ok = false, durationMs = 4500) => {
    setActionToastOk(ok);
    setActionToast(message);
    if (actionToastTimerRef.current) window.clearTimeout(actionToastTimerRef.current);
    actionToastTimerRef.current = window.setTimeout(() => {
      setActionToast(null);
      actionToastTimerRef.current = null;
    }, durationMs);
  };

  const handleSaveImportPrice = async (product: Product) => {
    const token = localStorage.getItem('admin_token');
    if (!token) {
      showActionToast('Chưa đăng nhập.');
      return;
    }
    const importPrice = Math.max(0, Math.round(Number(product.importPrice) || 0));
    const sellingPrice = Math.max(0, Math.round(Number(product.sellingPrice) || 0));
    const stock = Math.max(0, Math.round(Number(product.stock) || 0));
    const sku = String(product.sku ?? '').trim();
    setSavingImportPriceId(product.id);
    try {
      // Chỉ lưu kho nội bộ — đồng bộ Shopee dùng nút Refresh riêng.
      const response = await fetch(`/api/products/${encodeURIComponent(product.id)}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          importPrice,
          sellingPrice,
          stock,
          sku,
          shopeeItemId: product.shopeeItemId,
          shopeeModelId: product.shopeeModelId,
          shopeeId: product.shopeeId,
        }),
      });
      const data = await parseJsonResponse(response);
      if (!response.ok || data?.success === false) {
        throw new Error(
          data?.error || data?.message || `Cập nhật phân loại thất bại (HTTP ${response.status})`
        );
      }
      const savedPrice = Math.max(0, Math.round(Number(data?.importPrice ?? importPrice) || 0));
      const savedSelling = Math.max(0, Math.round(Number(data?.sellingPrice ?? sellingPrice) || 0));
      const savedStock = Math.max(0, Math.round(Number(data?.stock ?? stock) || 0));
      const savedSku = String(data?.sku ?? sku);
      onUpdateProduct({
        ...product,
        importPrice: savedPrice,
        sellingPrice: savedSelling,
        stock: savedStock,
        sku: savedSku,
      });
      showActionToast('Lưu thành công', true);
    } catch (err: any) {
      showActionToast(`Lỗi: ${err?.message || 'Lưu phân loại thất bại.'}`);
    } finally {
      setSavingImportPriceId(null);
    }
  };

  /** Lưu hàng loạt toàn bộ SKU con của 1 sản phẩm cha (không ảnh hưởng lưu lẻ từng dòng). */
  const handleSaveAllVariants = async (parentId: string, variantsInput?: Product[]) => {
    const token = localStorage.getItem('admin_token');
    if (!token) {
      showActionToast('Chưa đăng nhập.');
      return;
    }

    let variants: Product[] = Array.isArray(variantsInput) ? variantsInput : [];
    if (variants.length === 0) {
      const parent = products.find((p) => p.id === parentId);
      variants = parent ? getProductChildren(parent) : [];
    }

    if (variants.length === 0) {
      showActionToast('Không có phân loại nào để lưu.');
      return;
    }

    const updates: BulkSaveProductUpdate[] = variants.map((v) => ({
      id: v.id,
      importPrice: Math.max(0, Math.round(Number(v.importPrice) || 0)),
      sellingPrice: Math.max(0, Math.round(Number(v.sellingPrice) || 0)),
      stock: Math.max(0, Math.round(Number(v.stock) || 0)),
      sku: String(v.sku ?? '').trim(),
    }));

    setSavingAllVariantsParentId(parentId);
    try {
      if (onBulkSave) {
        const ok = await onBulkSave(updates);
        if (!ok) throw new Error('Lưu hàng loạt thất bại.');
      } else {
        // Fallback: gọi PATCH song song từng SKU (giới hạn batch + delay chống rate limit).
        const BATCH = 10;
        for (let i = 0; i < variants.length; i += BATCH) {
          const chunk = variants.slice(i, i + BATCH);
          await Promise.all(
            chunk.map(async (product) => {
              const importPrice = Math.max(0, Math.round(Number(product.importPrice) || 0));
              const sellingPrice = Math.max(0, Math.round(Number(product.sellingPrice) || 0));
              const stock = Math.max(0, Math.round(Number(product.stock) || 0));
              const sku = String(product.sku ?? '').trim();
              const response = await fetch(`/api/products/${encodeURIComponent(product.id)}`, {
                method: 'PATCH',
                headers: {
                  Authorization: `Bearer ${token}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  importPrice,
                  sellingPrice,
                  stock,
                  sku,
                  shopeeItemId: product.shopeeItemId,
                  shopeeModelId: product.shopeeModelId,
                  shopeeId: product.shopeeId,
                }),
              });
              const data = await parseJsonResponse(response);
              if (!response.ok || data?.success === false) {
                throw new Error(
                  data?.error || data?.message || `Lưu thất bại: ${product.sku || product.id}`
                );
              }
              onUpdateProduct({
                ...product,
                importPrice: Math.max(0, Math.round(Number(data?.importPrice ?? importPrice) || 0)),
                sellingPrice: Math.max(0, Math.round(Number(data?.sellingPrice ?? sellingPrice) || 0)),
                stock: Math.max(0, Math.round(Number(data?.stock ?? stock) || 0)),
                sku: String(data?.sku ?? sku),
              });
            })
          );
          if (i + BATCH < variants.length) {
            await new Promise((r) => setTimeout(r, 200));
          }
        }
      }
      setExpandedParentIds((prev) => {
        const next = new Set(prev);
        next.add(parentId);
        return next;
      });
      showActionToast(`Đã lưu thành công ${updates.length} phân loại!`, true);
    } catch (err: any) {
      showActionToast(`Lỗi: ${err?.message || 'Lưu toàn bộ phân loại thất bại.'}`);
    } finally {
      setSavingAllVariantsParentId(null);
    }
  };

  const handleToggleSort = (field: 'stock' | 'sellingPrice') => {
    if (sortField !== field) {
      setSortField(field);
      setSortOrder('asc');
      return;
    }
    if (sortOrder === 'asc') {
      setSortOrder('desc');
      return;
    }
    if (sortOrder === 'desc') {
      setSortField(null);
      setSortOrder(null);
      return;
    }
    setSortOrder('asc');
  };

  const handleQuickSyncShopee = async (productId: string) => {
    const token = localStorage.getItem('admin_token');
    if (!token) {
      showActionToast('Chưa đăng nhập.');
      return;
    }
    setSyncingProductId(productId);
    setShopeeSyncError(null);
    if (actionToastTimerRef.current) {
      window.clearTimeout(actionToastTimerRef.current);
      actionToastTimerRef.current = null;
    }
    setActionToastOk(false);
    setActionToast('Đang đồng bộ giá và tồn kho lên Shopee...');
    try {
      const payload = buildShopeeSyncPayload(productId);
      console.log('PAYLOAD TỪ NÚT NGOÀI:', payload);
      const response = await fetch('/api/products/sync-shopee', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      const data = await parseJsonResponse(response);
      if (!response.ok || data?.success === false) {
        throw new Error(data?.error || data?.message || data?.shopeeMessage || `Đồng bộ Shopee thất bại (HTTP ${response.status})`);
      }
      showActionToast(formatShopeeSyncSuccessToast(data?.shopeeMessage), true, 3000);
      onAddLog({
        id: `sync-${Date.now()}`,
        timestamp: new Date().toISOString(),
        channel: 'shopee',
        type: 'stock_sync',
        status: 'success',
        message: data?.shopeeMessage || `Đồng bộ nhanh sản phẩm ${productId} lên Shopee thành công.`,
      });
    } catch (err: any) {
      const msg = err?.message || 'Đồng bộ Shopee thất bại.';
      setActionToast(null);
      const lines = formatShopeeSyncAlertLines(msg);
      setShopeeSyncError(lines.length > 0 ? lines : [msg]);
      onAddLog({
        id: `sync-${Date.now()}`,
        timestamp: new Date().toISOString(),
        channel: 'shopee',
        type: 'stock_sync',
        status: 'failed',
        message: (lines.length > 0 ? lines : [msg]).join(' | '),
      });
    } finally {
      setSyncingProductId(null);
    }
  };

  // Bulk edit modal (Sapo-style)
  const [showBulkModal, setShowBulkModal] = useState(false);
  const [showBulkPriceModal, setShowBulkPriceModal] = useState(false);
  /** Parent đã mở — chỉ render children khi expand. */
  const [expandedParentIds, setExpandedParentIds] = useState<Set<string>>(new Set());

  const toggleParentExpand = (parentId: string) => {
    setExpandedParentIds((prev) => {
      const next = new Set(prev);
      if (next.has(parentId)) next.delete(parentId);
      else next.add(parentId);
      return next;
    });
  };

  const handleBulkSave = async (updates: BulkSaveProductUpdate[]) => {
    if (!onBulkSave) return false;
    const ok = await onBulkSave(updates);
    if (ok) {
      onAddLog({
        id: `log-${Date.now()}`,
        timestamp: new Date().toISOString(),
        channel: 'all',
        type: 'stock_sync',
        status: 'success',
        message: `Cập nhật hàng loạt ${updates.length} sản phẩm vào kho gốc thành công.`,
      });
      onBulkSelect([]);
    }
    return ok;
  };

  const handleBulkPriceApply = async (
    updates: { id: string; new_price: number }[],
  ): Promise<boolean> => {
    const token = localStorage.getItem('admin_token');
    if (!token) {
      showActionToast('Chưa đăng nhập.');
      return false;
    }
    try {
      const response = await fetch('/api/products/bulk-update-prices', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ updates }),
      });
      const data = await parseJsonResponse<{
        success?: boolean;
        message?: string;
        error?: string;
        products?: Product[];
      }>(response);
      if (!response.ok || data?.success === false) {
        throw new Error(data?.message || data?.error || 'Cập nhật giá hàng loạt thất bại.');
      }
      if (Array.isArray(data.products) && onProductsUpdated) {
        onProductsUpdated(data.products);
      }
      await onRefreshProducts?.({ page: 1, append: false, forceRefresh: true });
      onAddLog({
        id: `log-${Date.now()}`,
        timestamp: new Date().toISOString(),
        channel: 'shopee',
        type: 'price_update',
        status: 'success',
        message: data.message || `Cập nhật giá hàng loạt cho ${updates.length} sản phẩm thành công.`,
      });
      showActionToast(
        data.message || `Đã cập nhật giá cho ${updates.length} sản phẩm và đồng bộ Shopee.`,
      );
      onBulkSelect([]);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Cập nhật giá hàng loạt thất bại.';
      showActionToast(message);
      return false;
    }
  };

  const openProductDetail = (prod: Product) => {
    setActiveProduct(prod);
  };

  const handleProductsRefresh = (updated: Product[]) => {
    const current = activeProduct;
    if (!current) return;
    const key = current.shopeeItemId || current.id.match(/^shopee-item-(\d+)/)?.[1];
    if (key) {
      const siblings = updated.filter(
        p => p.shopeeItemId === key || p.id.startsWith(`shopee-item-${key}`)
      );
      const prefer = siblings.find(p => p.shopeeModelId) || siblings[0];
      if (prefer) setActiveProduct(prefer);
    } else {
      const match = updated.find(p => p.id === current.id);
      if (match) setActiveProduct(match);
    }
    onRefreshProducts?.();
  };

  const persistInlineProduct = (id: string) => {
    for (const p of products) {
      if (p.id === id) {
        onUpdateProduct(p, { save: true });
        return;
      }
      const child = getProductChildren(p).find((c) => c.id === id);
      if (child) {
        onUpdateProduct(child, { save: true });
        return;
      }
    }
  };

  // Add Product Modal state
  const [showAddModal, setShowAddModal] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newSku, setNewSku] = useState('');
  const [newCategory, setNewCategory] = useState('Gia dụng');
  const [newStock, setNewStock] = useState(10);
  const [newImportPrice, setNewImportPrice] = useState(100000);
  const [newSellingPrice, setNewSellingPrice] = useState(180000);
  const [newDescription, setNewDescription] = useState('');
  const [newChannels, setNewChannels] = useState<('shopee' | 'tiktok')[]>(['shopee']);
  const [newImageUrl, setNewImageUrl] = useState('');

  // AI loading state
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState('');

  // Bulk operation check state
  const handleToggleSelectGroup = (group: ProductGroupRow) => {
    const ids = group.variants.map((v) => v.id);
    const allSelected = ids.every((id) => selectedIds.includes(id));
    if (allSelected) {
      onBulkSelect(selectedIds.filter((id) => !ids.includes(id)));
    } else {
      onBulkSelect([...new Set([...selectedIds, ...ids])]);
    }
  };

  const isGroupSelected = (group: ProductGroupRow) =>
    group.variants.length > 0 && group.variants.every((v) => selectedIds.includes(v.id));

  // FE gom nhóm theo item_id (API trả flat để server ổn định) — hiển thị Parent + >> children
  const productGroups = useMemo((): ProductGroupRow[] => {
    try {
      return buildProductGroups(products);
    } catch (err) {
      console.error('[ProductList] buildProductGroups failed, fallback flat:', err);
      return products.map((p) => ({
        groupId: p.id,
        representative: p,
        variants: [p],
        variantCount: 1,
        hasVariants: false,
        displayTitle: p.title,
        totalStock: Number(p.stock) || 0,
        minSellingPrice: Number(p.sellingPrice) || 0,
        maxSellingPrice: Number(p.sellingPrice) || 0,
      }));
    }
  }, [products]);

  // Filter Categories
  const categories = ['all', ...Array.from(new Set(products.map(p => p.category).filter(c => !isJunkCategoryLabel(c))))];

  const filteredGroups = useMemo(() => {
    const filtered = productGroups.filter((group) => {
      const rep = group.representative;
      // Search đã lọc server-side (toàn DB) — không filter lại theo search trên trang hiện tại.
      const channels = Array.isArray(rep.channels) ? rep.channels : [];

      const matchesChannel =
        channelFilter === 'all' ? true :
        channelFilter === 'shopee' ? channels.includes('shopee') :
        channelFilter === 'tiktok' ? channels.includes('tiktok') :
        channels.length === 0;

      const matchesCategory = categoryFilter === 'all' ? true : rep.category === categoryFilter;

      const matchesStock =
        stockFilter === 'all' ? true :
        stockFilter === 'low' ? group.totalStock > 0 && group.totalStock <= 10 :
        group.totalStock === 0;

      return matchesChannel && matchesCategory && matchesStock;
    });

    if (!sortField || !sortOrder) return filtered;

    const dir = sortOrder === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      if (sortField === 'stock') {
        return (a.totalStock - b.totalStock) * dir;
      }
      const priceA = (a.minSellingPrice + a.maxSellingPrice) / 2;
      const priceB = (b.minSellingPrice + b.maxSellingPrice) / 2;
      return (priceA - priceB) * dir;
    });
  }, [productGroups, channelFilter, categoryFilter, stockFilter, sortField, sortOrder]);

  const allFilteredIds = filteredGroups.flatMap((g) => g.variants.map((v) => v.id));
  const allFilteredSelected = allFilteredIds.length > 0 && allFilteredIds.every((id) => selectedIds.includes(id));

  const handleSelectAll = () => {
    if (allFilteredSelected) {
      onBulkSelect([]);
    } else {
      onBulkSelect(allFilteredIds);
    }
  };

  // Smart AI Generation of Product Content
  const handleAIGenerate = async () => {
    if (!newTitle) {
      setAiError('Vui lòng nhập tiêu đề thô để AI tối ưu hóa.');
      return;
    }
    setAiLoading(true);
    setAiError('');

    try {
      // 1. Optimize Title
      const titleRes = await fetch('/api/gemini/optimize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'optimize-title',
          text: newTitle,
          context: `Danh mục: ${newCategory}. Giá bán đề xuất: ${newSellingPrice.toLocaleString('vi-VN')} VNĐ.`
        })
      });
      const titleData = await titleRes.json();
      if (titleData.error) throw new Error(titleData.error);

      // Select first optimized title
      const lines = titleData.result.split('\n').filter((l: string) => l.trim().length > 0);
      const chosenTitle = lines[0]?.replace(/^\d+[\.\-\s]+/, '').trim() || newTitle;
      setNewTitle(chosenTitle);

      // 2. Generate Description
      const descRes = await fetch('/api/gemini/optimize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'generate-description',
          text: chosenTitle,
          context: `Giá bán sỉ (nhập): ${newImportPrice} đ, Giá bán lẻ: ${newSellingPrice} đ, SKU: ${newSku || 'Chưa có'}`
        })
      });
      const descData = await descRes.json();
      if (descData.error) throw new Error(descData.error);
      setNewDescription(descData.result);

      // Suggest SKU if empty
      if (!newSku) {
        const words = chosenTitle.split(' ');
        const suggestedSku = words.slice(0, 3).map((w: string) => w.substring(0, 2).toUpperCase()).join('-') + '-' + Math.floor(Math.random() * 1000);
        setNewSku(suggestedSku);
      }
    } catch (err: any) {
      console.error(err);
      setAiError(err.message || 'Lỗi không thể kết nối tới máy chủ AI.');
    } finally {
      setAiLoading(false);
    }
  };

  const handleCreateProduct = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle || !newSku) return;

    const prod: Product = {
      id: `prod-${Date.now()}`,
      title: newTitle,
      sku: newSku,
      category: newCategory,
      stock: Number(newStock),
      importPrice: Number(newImportPrice),
      sellingPrice: Number(newSellingPrice),
      channels: newChannels,
      description: newDescription || `${newTitle} là sản phẩm chất lượng cao, phân phối chính hãng.`,
      status: newStock === 0 ? 'out_of_stock' : 'active',
      shopeeId: newChannels.includes('shopee') ? `SP-${Math.floor(100000 + Math.random() * 900000)}` : undefined,
      tiktokId: newChannels.includes('tiktok') ? `TT-${Math.floor(100000 + Math.random() * 900000)}` : undefined,
      imageUrl: newImageUrl || 'https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=400&auto=format&fit=crop&q=60&ixlib=rb-4.0.3',
      lastSynced: new Date().toISOString()
    };

    onAddProduct(prod);
    
    // Reset form
    setNewTitle('');
    setNewSku('');
    setNewStock(10);
    setNewImportPrice(100000);
    setNewSellingPrice(180000);
    setNewDescription('');
    setNewChannels(['shopee']);
    setNewImageUrl('');
    setShowAddModal(false);
  };

  const handleClearAllInventory = async () => {
    const ok = window.confirm(
      'CẢNH BÁO: Bạn sắp XÓA TOÀN BỘ Kho gốc và dữ liệu Liên kết (Mapping).\n\nThao tác này không thể hoàn tác. Bạn có chắc chắn muốn tiếp tục?'
    );
    if (!ok) return;

    const ok2 = window.confirm('Xác nhận lần cuối: Xóa sạch toàn bộ sản phẩm kho và mapping?');
    if (!ok2) return;

    setIsClearingInventory(true);
    try {
      const token = localStorage.getItem('admin_token');
      const res = await fetch('/api/inventory/clear-all', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ confirmation: 'CLEAR_INVENTORY' }),
      });
      const data = await parseJsonResponse<{ success?: boolean; message?: string; error?: string }>(res);
      if (!res.ok || data.success === false) {
        throw new Error(data?.message || data?.error || 'Xóa toàn bộ kho thất bại.');
      }
      onBulkSelect([]);
      setExpandedParentIds(new Set());
      warehouseLoadedRef.current = false;
      clearInventoryBrowserCache();
      await onRefreshProducts?.({ page: 1, append: false, forceRefresh: true });
      setInitToast(data.message || 'Đã xóa toàn bộ Kho gốc và Mapping.');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Xóa toàn bộ kho thất bại.';
      alert(message);
    } finally {
      setIsClearingInventory(false);
    }
  };

  const handleConfirmMarketplaceInit = async () => {
    if (initPlatform === 'tiktok') return;

    setIsInitializing(true);
    setInitProgress(["🔌 Đang kết nối API sàn để khởi tạo Kho chính..."]);

    const shop =
      initPlatformShops.find((s) => s.id === initShopId) ||
      shops.find((s) => s.platform === initPlatform && s.connected);
    if (!shop?.shopId) {
      alert(`Chưa có gian hàng ${initPlatform === 'shopee' ? 'Shopee' : 'TikTok'} nào được kết nối.`);
      setIsInitializing(false);
      return;
    }

    try {
      const token = localStorage.getItem('admin_token');
      const endpoint =
        initPlatform === 'shopee' ? '/api/shopee/products/sync' : '/api/tiktok/products/sync';
      let offset = 0;
      let hasMore = true;
      let pageIndex = 0;
      let total = 0;
      let variantCount = 0;
      let shouldForceRefresh = false;
      const initStartedAt = Date.now();
      // #region agent log
      const agentLog = (hypothesisId: string, location: string, message: string, data: Record<string, unknown>) => {
        const body = { sessionId: '556dce', runId: 'post-fix', hypothesisId, location, message, data, timestamp: Date.now() };
        fetch('http://127.0.0.1:7554/ingest/bc993c61-1b63-4f42-8c97-c42133e3ec03', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '556dce' }, body: JSON.stringify(body) }).catch(() => {});
        fetch('/api/debug/client-log', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }).catch(() => {});
      };
      agentLog('A,B,C,D,E', 'ProductList.tsx:init-start', 'marketplace init started', { shopId: shop.shopId, endpoint, timeoutPerPageMs: 300000 });
      // #endregion

      while (hasMore) {
        // Giới hạn cho từng trang, không phải toàn bộ phiên khởi tạo. Catalog nhiều
        // trang có thể cần hơn 5 phút nhưng các trang đã lưu vẫn tiếp tục được xử lý.
        const pageController = new AbortController();
        const pageTimeoutId = setTimeout(() => pageController.abort(), 300000);
        const pageStartedAt = Date.now();
        const requestOffset = offset;
        let res: Response;
        try {
          res = await fetch(endpoint, {
            method: 'POST',
            signal: pageController.signal,
            headers: {
              'Content-Type': 'application/json',
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            // Trang đầu: reset=true để thay toàn bộ Kho gốc bằng dữ liệu mới từ sàn.
            body: JSON.stringify({
              shopId: shop.shopId,
              offset,
              reset: offset === 0,
            }),
          });
        } finally {
          clearTimeout(pageTimeoutId);
        }
        const pageElapsedMs = Date.now() - pageStartedAt;
        const data = await parseJsonResponse<{
          success?: boolean;
          productCount?: number;
          stats?: {
            rowCount?: number;
            variantItemCount?: number;
            pageCount?: number;
            itemsInPage?: number;
            savedCount?: number;
            skippedCount?: number;
          };
          shopId?: string;
          message?: string;
          error?: string;
          forceRefresh?: boolean;
          refresh?: { forceRefresh?: boolean };
          nextOffset?: number;
          hasMore?: boolean;
          pageIndex?: number;
          _debug?: {
            durationMs?: number;
            existingCount?: number;
            upsertCount?: number;
            batchRows?: number;
            loadMs?: number;
            upsertMs?: number;
          };
        }>(res);

        // #region agent log
        agentLog('A,B,C,D,E', 'ProductList.tsx:init-page', 'marketplace init page response', {
          httpStatus: res.status,
          ok: res.ok,
          success: data?.success,
          requestOffset,
          pageElapsedMs,
          serverDebug: data?._debug || null,
          pageIndex: data?.pageIndex,
          hasMore: data?.hasMore,
          nextOffset: data?.nextOffset,
          itemsInPage: data?.stats?.itemsInPage,
          savedCount: data?.stats?.savedCount,
          productCount: data?.productCount,
          error: data?.error || null,
          message: data?.message || null,
          elapsedTotalMs: Date.now() - initStartedAt,
        });
        // #endregion

        if (!res.ok || data.success === false) {
          const detail = [data?.message, data?.error, data?.snippet]
            .filter(Boolean)
            .map(String)
            .join(' — ');
          throw new Error(detail || `Khởi tạo sản phẩm thất bại (HTTP ${res.status}).`);
        }

        pageIndex = Number(data.pageIndex ?? pageIndex + 1);
        total = Number(data.productCount ?? total);
        variantCount += Number(data.stats?.variantItemCount ?? 0);
        shouldForceRefresh =
          data.forceRefresh === true || data.refresh?.forceRefresh === true || shouldForceRefresh;
        const dbg = data._debug;
        setInitProgress((prev) => [
          ...prev,
          `📄 Đã xử lý trang ${pageIndex}: ${Number(data.stats?.itemsInPage ?? 0)} sản phẩm, lưu ${Number(data.stats?.savedCount ?? 0)} dòng (${pageElapsedMs}ms, upsert ${dbg?.upsertCount ?? '?'}/${dbg?.batchRows ?? '?'} batch, catalog ${dbg?.existingCount ?? '?'})`,
        ]);

        const prevOffset = offset;
        hasMore = data.hasMore === true;
        offset = Number(data.nextOffset ?? offset);
        // #region agent log
        if (hasMore && (!Number.isFinite(offset) || offset === prevOffset)) {
          agentLog('D', 'ProductList.tsx:init-offset-stuck', 'hasMore true but offset did not advance', {
            prevOffset,
            nextOffset: offset,
            hasMore,
            pageIndex,
          });
        }
        // #endregion
      }

      setInitProgress((prev) => [
        ...prev,
        "🔄 Đang tải lại Kho chính từ Database...",
      ]);

      // Sync xong có thể đọc DB chậm — thử lại vài lần thay vì đóng modal với bảng trống.
      let refreshed = false;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          await onRefreshProducts?.({ page: 1, append: false, forceRefresh: shouldForceRefresh || true });
          refreshed = true;
          break;
        } catch (refreshErr) {
          setInitProgress((prev) => [
            ...prev,
            `⚠️ Tải lại kho lần ${attempt}/3 thất bại, thử lại...`,
          ]);
          if (attempt < 3) {
            await new Promise((r) => setTimeout(r, 800 * attempt));
          } else {
            console.error('Refresh after init failed:', refreshErr);
          }
        }
      }

      setInitProgress((prev) => [
        ...prev,
        `📦 ${variantCount} sản phẩm có phân loại (children).`,
        refreshed
          ? `🎉 HOÀN TẤT: ${total} sản phẩm đã được khởi tạo vào Kho chính!`
          : `🎉 Đã lưu ${total} sản phẩm. Nếu bảng còn trống, bấm F5 để tải lại.`,
      ]);
      // #region agent log
      agentLog('C', 'ProductList.tsx:init-success', 'marketplace init completed', {
        total,
        variantCount,
        refreshed,
        elapsedTotalMs: Date.now() - initStartedAt,
      });
      // #endregion
      setInitToast(
        refreshed
          ? `Khởi tạo kho thành công! ${total} sản phẩm (${variantCount} có phân loại).`
          : `Đã lưu ${total} sản phẩm. Hãy tải lại trang nếu danh sách chưa hiện.`
      );

      onAddLog({
        id: `log-${Date.now()}`,
        timestamp: new Date().toISOString(),
        channel: initPlatform,
        type: 'product_sync',
        status: 'success',
        message: `Khởi tạo ${total} sản phẩm từ ${shop.shopName} vào Kho chính thành công.`,
      });

      setShowInitModal(false);
    } catch (err: any) {
      const message =
        err?.name === 'AbortError'
          ? `Một trang dữ liệu đã quá thời gian chờ (5 phút) khi khởi tạo từ ${
              initPlatform === 'shopee' ? 'Shopee' : 'TikTok'
            }.`
          : err?.message || 'Khởi tạo sản phẩm thất bại.';
      // #region agent log
      {
        const token = localStorage.getItem('admin_token');
        const body = { sessionId: '556dce', runId: 'post-fix', hypothesisId: 'A,B,E', location: 'ProductList.tsx:init-error', message: 'marketplace init failed', data: { errName: err?.name || null, errMessage: String(err?.message || message), isAbort: err?.name === 'AbortError' }, timestamp: Date.now() };
        fetch('http://127.0.0.1:7554/ingest/bc993c61-1b63-4f42-8c97-c42133e3ec03', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '556dce' }, body: JSON.stringify(body) }).catch(() => {});
        fetch('/api/debug/client-log', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }).catch(() => {});
      }
      // #endregion
      setInitProgress((prev) => [...prev, `❌ Lỗi: ${message}`]);
      alert(`Khởi tạo sản phẩm thất bại: ${message}`);

      onAddLog({
        id: `log-${Date.now()}`,
        timestamp: new Date().toISOString(),
        channel: initPlatform,
        type: 'product_sync',
        status: 'failed',
        message: `Khởi tạo sản phẩm thất bại: ${message}`,
      });
    } finally {
      setIsInitializing(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Toast Notification for Shopee Import */}
      {initToast && (
        <div className="fixed top-5 right-5 z-50 bg-slate-900 text-white font-bold text-xs px-5 py-3 rounded-2xl shadow-2xl border border-slate-700 animate-bounce flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          <span>{initToast}</span>
          <button onClick={() => setInitToast(null)} className="ml-1 text-gray-400 hover:text-white cursor-pointer">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
      {actionToast && (
        <div
          className={`fixed top-5 right-5 z-50 text-white font-bold text-xs px-5 py-3 rounded-2xl shadow-2xl flex items-center gap-2 max-w-sm ${
            actionToastOk
              ? 'bg-blue-600 border border-blue-500'
              : 'bg-slate-900 border border-slate-700'
          }`}
        >
          {actionToastOk ? (
            <CheckCircle2 className="w-4 h-4 text-white shrink-0" />
          ) : (
            <RefreshCw className={`w-4 h-4 shrink-0 ${syncingProductId || savingImportPriceId ? 'animate-spin text-orange-400' : 'text-orange-400'}`} />
          )}
          <span>{actionToast}</span>
          <button
            onClick={() => {
              if (actionToastTimerRef.current) {
                window.clearTimeout(actionToastTimerRef.current);
                actionToastTimerRef.current = null;
              }
              setActionToast(null);
            }}
            className="ml-1 text-white/70 hover:text-white cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
      {shopeeSyncError && shopeeSyncError.length > 0 && (
        <div
          role="alert"
          className="w-full flex items-start gap-3 bg-white text-red-600 border border-red-500 rounded-lg px-4 py-3.5 shadow-md"
        >
          <AlertCircle className="w-5 h-5 shrink-0 mt-0.5 text-red-600" />
          <ul className="flex-1 min-w-0 list-disc pl-5 space-y-1 text-[15px] sm:text-base font-semibold leading-snug">
            {shopeeSyncError.map((line) => (
              <li key={line} className="break-words">
                {line}
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => setShopeeSyncError(null)}
            className="shrink-0 p-1 rounded text-red-500 hover:bg-red-50 hover:text-red-700 cursor-pointer"
            aria-label="Đóng thông báo lỗi"
            title="Đóng"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      )}

      {/* TOP NAVIGATION SUB-TABS */}
      <div className="flex border-b border-gray-150 overflow-x-auto">
        <button
          onClick={() => setSubTab('warehouse')}
          className={`flex items-center gap-2 px-6 py-3.5 border-b-2 transition-all cursor-pointer text-xs font-black uppercase tracking-wider whitespace-nowrap ${
            subTab === 'warehouse'
              ? 'border-blue-600 text-blue-600 font-extrabold'
              : 'border-transparent text-gray-500 hover:text-gray-950 hover:border-gray-300'
          }`}
        >
          <Database className="w-4 h-4" />
          <span>Kho sản phẩm chính (Kho gốc)</span>
        </button>

        <button
          onClick={() => { setSubTab('audit'); onBulkSelect([]); }}
          className={`flex items-center gap-2 px-6 py-3.5 border-b-2 transition-all cursor-pointer text-xs font-black uppercase tracking-wider whitespace-nowrap ${
            subTab === 'audit'
              ? 'border-blue-600 text-blue-600 font-extrabold'
              : 'border-transparent text-gray-500 hover:text-gray-950 hover:border-gray-300'
          }`}
        >
          <ClipboardList className="w-4 h-4" />
          <span>Kiểm hàng</span>
        </button>

        <button
          onClick={() => { setSubTab('linking'); onBulkSelect([]); }}
          className={`flex items-center gap-2 px-6 py-3.5 border-b-2 transition-all cursor-pointer text-xs font-black uppercase tracking-wider whitespace-nowrap ${
            subTab === 'linking'
              ? 'border-blue-600 text-blue-600 font-extrabold'
              : 'border-transparent text-gray-500 hover:text-gray-950 hover:border-gray-300'
          }`}
        >
          <ArrowRightLeft className="w-4 h-4" />
          <span>Liên kết sản phẩm (Mapping)</span>
        </button>
      </div>

      <div className={subTab === 'linking' ? 'block' : 'hidden'}>
        <ProductLinking 
          products={products}
          shops={shops}
          onAddLog={onAddLog}
          onUpdateProduct={onUpdateProduct}
          onAddProduct={onAddProduct}
          onRefreshProducts={onRefreshProducts}
        />
      </div>

      <div className={subTab === 'audit' ? 'block' : 'hidden'}>
        <InventoryAudit
          products={products}
          shopId={shops.find(s => s.platform === 'shopee' && s.connected)?.shopId}
          onRefreshProducts={onRefreshProducts}
        />
      </div>

      <div className={subTab === 'warehouse' ? 'block space-y-6' : 'hidden'}>
          {/* Main Warehouse explanation & API integration banner */}
          <div className="max-md:hidden md:flex md:flex-row md:items-center bg-slate-50 border border-gray-150 p-4 rounded-2xl justify-between gap-4">
            <div className="space-y-1">
              <h4 className="text-xs font-black text-slate-800 uppercase tracking-wider flex items-center gap-1.5">
                <Database className="w-3.5 h-3.5 text-blue-500" />
                <span>CƠ SỞ DỮ LIỆU KHO SẢN PHẨM GỐC</span>
              </h4>
              <p className="text-[11px] text-gray-500 leading-relaxed font-semibold">
                Kho gốc (Master Inventory): chỉ tạo / sửa / xóa thông tin, giá và tồn kho. Liên kết sàn được thực hiện riêng tại tab &quot;Liên kết sản phẩm&quot;. Đồng bộ giá &amp; tồn là 1 chiều: Kho gốc → Sàn.
              </p>
            </div>
            
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => void handleClearAllInventory()}
                type="button"
                disabled={isClearingInventory}
                className="px-4 py-2.5 bg-red-600 hover:bg-red-700 disabled:bg-red-300 text-white text-xs font-extrabold rounded-xl transition-all shadow-md shadow-red-500/10 flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <Trash2 className={`w-3.5 h-3.5 ${isClearingInventory ? 'animate-pulse' : ''}`} />
                <span>{isClearingInventory ? 'Đang xóa...' : 'Xóa toàn bộ Kho'}</span>
              </button>
              <button
                onClick={() => setShowImportPriceModal(true)}
                type="button"
                className="px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-extrabold rounded-xl transition-all shadow-md shadow-emerald-500/10 flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <span>📥 Import Giá Nhập</span>
              </button>
              <button
                onClick={() => setShowInitModal(true)}
                type="button"
                className="px-4 py-2.5 bg-orange-500 hover:bg-orange-600 text-white text-xs font-extrabold rounded-xl transition-all shadow-md shadow-orange-500/10 flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5 text-white" style={{ animationDuration: isInitializing ? '2s' : '0s' }} />
                <span>Khởi tạo từ sàn</span>
              </button>
            </div>
          </div>

          {/* Search and Filters Bar */}
          <div className="bg-white p-4 rounded-2xl border border-gray-100 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex-1 flex flex-col sm:flex-row gap-3">
          {/* Search input */}
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-gray-400 absolute left-3 top-3.5" />
            <input 
              type="text" 
              placeholder="Tìm kiếm theo Tên sản phẩm, SKU..." 
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  triggerSearchNow();
                }
              }}
              className="pl-9 pr-4 py-2.5 w-full bg-gray-50/50 hover:bg-gray-50 focus:bg-white text-sm rounded-xl border border-gray-100 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none transition-all"
            />
          </div>

          {/* Channel selector */}
          <div className="relative max-md:hidden md:block">
            <select
              value={channelFilter}
              onChange={(e) => setChannelFilter(e.target.value as any)}
              className="pl-3 pr-8 py-2.5 bg-gray-50/50 hover:bg-gray-50 text-sm rounded-xl border border-gray-100 outline-none cursor-pointer appearance-none min-w-[140px]"
            >
              <option value="all">Sàn: Tất cả</option>
              <option value="shopee">Sàn Shopee</option>
              <option value="tiktok">Sàn TikTok</option>
              <option value="none">Sàn: Chưa đăng</option>
            </select>
            <Filter className="w-3.5 h-3.5 text-gray-400 absolute right-3 top-3.5 pointer-events-none" />
          </div>

          {/* Stock selector */}
          <div className="relative max-md:hidden md:block">
            <select
              value={stockFilter}
              onChange={(e) => setStockFilter(e.target.value as any)}
              className="pl-3 pr-8 py-2.5 bg-gray-50/50 hover:bg-gray-50 text-sm rounded-xl border border-gray-100 outline-none cursor-pointer appearance-none min-w-[140px]"
            >
              <option value="all">Tồn kho: Tất cả</option>
              <option value="low">Sắp hết hàng (≤10)</option>
              <option value="out">Đã hết hàng (0)</option>
            </select>
            <Filter className="w-3.5 h-3.5 text-gray-400 absolute right-3 top-3.5 pointer-events-none" />
          </div>
        </div>

        {/* Add Product Button */}
        <button 
          onClick={() => setShowAddModal(true)}
          className="max-md:hidden md:flex px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-semibold transition-all items-center justify-center gap-2 shadow-sm shrink-0"
          id="add-new-product-btn"
        >
          <Plus className="w-4.5 h-4.5" /> Thêm Sản Phẩm Mới
        </button>
      </div>

      {/* Selected floating actions */}
      {selectedIds.length > 0 && (
        <div className="max-md:hidden md:flex bg-indigo-50 border border-indigo-100 rounded-xl p-4 items-center justify-between gap-4 text-indigo-900 animate-in fade-in slide-in-from-bottom-2">
          <div className="flex items-center gap-2">
            <Package className="w-5 h-5 text-indigo-600" />
            <span className="text-sm font-semibold">Đang chọn {selectedIds.length} sản phẩm</span>
          </div>
          <div className="flex gap-2">
            <button 
              onClick={() => setShowBulkPriceModal(true)}
              className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-xs rounded-lg transition-all flex items-center gap-1.5"
            >
              <TrendingUp className="w-3.5 h-3.5" /> 📈 Sửa giá hàng loạt
            </button>
            <button 
              onClick={() => setShowBulkModal(true)}
              className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold text-xs rounded-lg transition-all flex items-center gap-1.5"
            >
              <Edit3 className="w-3.5 h-3.5" /> Sửa hàng loạt
            </button>
            <button 
              onClick={() => onBulkSelect([])}
              className="px-3 py-1.5 bg-white border border-indigo-200 hover:bg-indigo-100 text-indigo-700 font-medium text-xs rounded-lg transition-all"
            >
              Bỏ chọn
            </button>
          </div>
        </div>
      )}

      {/* Products Table - Desktop Only */}
      <div className="max-md:hidden md:block bg-white rounded-2xl border border-gray-100 shadow-xs overflow-hidden">
        {!productsLoading && products.length === 0 && !serverSearch && (
          <div className="p-8 text-center space-y-3 border-b border-gray-50">
            <p className="text-sm text-gray-500 font-semibold">
              Chưa có dữ liệu trong Kho gốc. Hãy dùng nút "Khởi tạo từ sàn" để lấy dữ liệu.
            </p>
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-gray-50/50 border-b border-gray-100 text-xs font-bold text-gray-500 uppercase tracking-wider">
                <th className="p-4 w-12 text-center">
                  <input 
                    type="checkbox" 
                    checked={allFilteredSelected}
                    onChange={handleSelectAll}
                    className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 w-4 h-4 cursor-pointer"
                  />
                </th>
                <th className="p-4">Sản phẩm</th>
                <th className="p-4">SKU / Phân loại</th>
                <th className="p-4">
                  <button
                    type="button"
                    onClick={() => handleToggleSort('stock')}
                    className="inline-flex items-center gap-1 uppercase tracking-wider hover:text-indigo-600 transition-colors"
                    title="Sắp xếp theo tồn kho"
                  >
                    Tồn Kho
                    {sortField === 'stock' && sortOrder === 'asc' ? (
                      <ArrowUp className="w-3.5 h-3.5 text-indigo-600" />
                    ) : sortField === 'stock' && sortOrder === 'desc' ? (
                      <ArrowDown className="w-3.5 h-3.5 text-indigo-600" />
                    ) : (
                      <ArrowUpDown className="w-3.5 h-3.5 text-gray-400" />
                    )}
                  </button>
                </th>
                <th className="p-4 text-right">Giá Nhập</th>
                <th className="p-4 text-right">
                  <button
                    type="button"
                    onClick={() => handleToggleSort('sellingPrice')}
                    className="inline-flex items-center gap-1 uppercase tracking-wider hover:text-indigo-600 transition-colors ml-auto"
                    title="Sắp xếp theo giá bán"
                  >
                    Giá Bán
                    {sortField === 'sellingPrice' && sortOrder === 'asc' ? (
                      <ArrowUp className="w-3.5 h-3.5 text-indigo-600" />
                    ) : sortField === 'sellingPrice' && sortOrder === 'desc' ? (
                      <ArrowDown className="w-3.5 h-3.5 text-indigo-600" />
                    ) : (
                      <ArrowUpDown className="w-3.5 h-3.5 text-gray-400" />
                    )}
                  </button>
                </th>
                <th className="p-4">Đăng Kênh</th>
                <th className="p-4 text-center">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50 text-sm">
              {filteredGroups.length === 0 ? (
                <tr>
                  <td colSpan={8} className="p-16 text-center">
                    <p className="text-sm font-semibold text-gray-400 tracking-wide">
                      {productsLoading ? 'Đang tải...' : 'Không tìm thấy sản phẩm'}
                    </p>
                  </td>
                </tr>
              ) : (
                filteredGroups.flatMap((group) => {
                  const prod = group.representative;
                  const priceLabel = formatPriceRange(group.minSellingPrice, group.maxSellingPrice);
                  const estimatedProfit = calculateEstimatedProductProfit(prod, systemFees);
                  const isExpanded = expandedParentIds.has(group.groupId);
                  const rows: React.ReactNode[] = [];

                  rows.push(
                    <tr
                      key={group.groupId}
                      className="hover:bg-gray-50/50 transition-colors cursor-pointer"
                      onClick={(e) => {
                        const tag = (e.target as HTMLElement).tagName;
                        if (tag === 'INPUT' || tag === 'BUTTON' || (e.target as HTMLElement).closest('button, input')) return;
                        if (group.hasVariants) {
                          toggleParentExpand(group.groupId);
                          return;
                        }
                        openProductDetail(prod);
                      }}
                    >
                      <td className="p-4 text-center">
                        <input
                          type="checkbox"
                          checked={isGroupSelected(group)}
                          onChange={() => handleToggleSelectGroup(group)}
                          className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 w-4 h-4 cursor-pointer"
                        />
                      </td>
                      <td className="p-4 max-w-xs">
                        <div className="flex items-center gap-2">
                          {group.hasVariants ? (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleParentExpand(group.groupId);
                              }}
                              className="w-7 h-7 flex items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-indigo-700 font-black text-sm shrink-0"
                              title={isExpanded ? 'Thu gọn phân loại' : 'Mở phân loại'}
                            >
                              {isExpanded ? '▼' : '>>'}
                            </button>
                          ) : (
                            <span className="w-7 shrink-0" />
                          )}
                          {(prod.avatarUrl || prod.imageUrl) ? (
                            <img
                              src={prod.avatarUrl || prod.imageUrl}
                              alt={group.displayTitle}
                              className="w-11 h-11 rounded-lg object-cover border border-gray-100 shrink-0 cursor-zoom-in hover:opacity-90 transition-opacity"
                              referrerPolicy="no-referrer"
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedImage(prod.avatarUrl || prod.imageUrl || null);
                              }}
                              title="Nhấn để phóng to"
                            />
                          ) : (
                            <div className="w-11 h-11 rounded-lg bg-gray-100 text-gray-400 flex items-center justify-center text-xs font-bold shrink-0">SP</div>
                          )}
                          <div className="space-y-0.5 min-w-0">
                            <button
                              onClick={(e) => { e.stopPropagation(); openProductDetail(prod); }}
                              className="font-bold text-gray-900 hover:text-blue-600 transition-colors text-left line-clamp-1 block text-sm"
                            >
                              {group.displayTitle}
                            </button>
                            {!isJunkCategoryLabel(prod.category) && (
                              <span className="text-[11px] text-gray-400 px-1.5 py-0.2 bg-gray-100 rounded">
                                {prod.category}
                              </span>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="p-4">
                        {group.hasVariants ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-bold bg-indigo-50 text-indigo-700 border border-indigo-100">
                            {group.variantCount} phân loại
                          </span>
                        ) : (
                          <span className="font-mono text-xs text-gray-600 font-semibold">{prod.sku}</span>
                        )}
                      </td>
                      <td className="p-4">
                        <div className="flex items-center gap-2">
                          {group.hasVariants ? (
                            <span className="font-mono text-xs font-semibold text-gray-800 px-1.5 py-1 bg-gray-50 rounded border border-gray-100">
                              {group.totalStock}
                            </span>
                          ) : (
                            <input
                              type="number"
                              value={prod.stock}
                              onClick={(e) => e.stopPropagation()}
                              onChange={(e) => onUpdateProduct({ ...prod, stock: Math.max(0, Number(e.target.value)) })}
                              onBlur={() => persistInlineProduct(prod.id)}
                              className="w-16 px-1.5 py-1 text-center bg-gray-50 hover:bg-gray-100 focus:bg-white rounded border border-gray-100 outline-none text-xs focus:border-blue-500 font-mono"
                            />
                          )}
                          {group.totalStock === 0 && <span className="w-2 h-2 bg-rose-500 rounded-full" title="Hết hàng"></span>}
                          {group.totalStock > 0 && group.totalStock <= 10 && <span className="w-2 h-2 bg-amber-500 rounded-full" title="Sắp hết hàng"></span>}
                        </div>
                      </td>
                      <td className="p-4 text-right font-mono font-medium text-gray-600">
                        {group.hasVariants ? (
                          <span className="text-xs text-gray-500">
                            {prod.importPrice.toLocaleString('vi-VN')} đ
                          </span>
                        ) : (
                          <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                            <CurrencyInput
                              value={Math.max(0, Number(prod.importPrice) || 0)}
                              onChange={(v) => onUpdateProduct({ ...prod, importPrice: v })}
                              onClick={(e) => e.stopPropagation()}
                              className="w-28 px-1.5 py-1 text-right bg-gray-50 hover:bg-gray-100 focus:bg-white rounded border border-gray-100 outline-none text-xs focus:border-blue-500 font-mono"
                              title="Giá nhập"
                            />
                            <span className="text-[10px] text-gray-400">đ</span>
                          </div>
                        )}
                      </td>
                      <td className="p-4 text-right font-mono font-bold text-gray-900">
                        {group.hasVariants ? (
                          <>
                            <div className="text-xs font-bold text-gray-900">{priceLabel}</div>
                            <div className={`text-[10px] flex items-center justify-end gap-0.5 mt-0.5 ${estimatedProfit >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                              <TrendingUp className="w-3 h-3" /> Lãi: {estimatedProfit.toLocaleString('vi-VN')}đ
                            </div>
                          </>
                        ) : (
                          <>
                            <div className="flex items-center justify-end gap-1.5">
                              <input
                                type="number"
                                value={prod.sellingPrice}
                                onClick={(e) => e.stopPropagation()}
                                onChange={(e) => onUpdateProduct({ ...prod, sellingPrice: Math.max(0, Number(e.target.value)) })}
                                onBlur={() => persistInlineProduct(prod.id)}
                                className="w-24 px-1.5 py-1 text-right bg-gray-50 hover:bg-gray-100 focus:bg-white rounded border border-gray-100 outline-none text-xs focus:border-blue-500 font-bold font-mono"
                              />
                              <span className="text-[10px] text-gray-400">đ</span>
                            </div>
                            <div className={`text-[10px] flex items-center justify-end gap-0.5 mt-0.5 ${estimatedProfit >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                              <TrendingUp className="w-3 h-3" /> Lãi: {estimatedProfit.toLocaleString('vi-VN')}đ
                            </div>
                          </>
                        )}
                      </td>
                      <td className="p-4">
                        <div className="flex gap-1">
                          <span className={`inline-flex items-center text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${
                            prod.channels.includes('shopee') ? 'bg-orange-50 text-orange-600 border border-orange-100' : 'bg-gray-100 text-gray-400'
                          }`}>
                            Shopee
                          </span>
                          <span className={`inline-flex items-center text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${
                            prod.channels.includes('tiktok') ? 'bg-zinc-950 text-white' : 'bg-gray-100 text-gray-400'
                          }`}>
                            TikTok
                          </span>
                        </div>
                      </td>
                      <td className="p-4 text-center">
                        <div className="flex items-center justify-center gap-1">
                          <button
                            onClick={(e) => { e.stopPropagation(); openProductDetail(prod); }}
                            className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-all"
                            title="Sửa sản phẩm"
                          >
                            <Edit3 className="w-4 h-4" />
                          </button>
                          {group.hasVariants && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                void handleSaveAllVariants(group.groupId, group.variants);
                              }}
                              disabled={savingAllVariantsParentId === group.groupId}
                              className="p-1.5 text-gray-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg transition-all disabled:opacity-60"
                              title="Lưu toàn bộ phân loại"
                              aria-label="Lưu toàn bộ"
                            >
                              {savingAllVariantsParentId === group.groupId ? (
                                <Loader2 className="w-4 h-4 animate-spin text-emerald-600" />
                              ) : (
                                <Save className="w-4 h-4" />
                              )}
                            </button>
                          )}
                          {!group.hasVariants && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                void handleSaveImportPrice(prod);
                              }}
                              disabled={savingImportPriceId === prod.id}
                              className="p-1.5 text-gray-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg transition-all disabled:opacity-60"
                              title="Lưu giá nhập"
                            >
                              <Save className={`w-4 h-4 ${savingImportPriceId === prod.id ? 'animate-pulse text-emerald-600' : ''}`} />
                            </button>
                          )}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleQuickSyncShopee(prod.id);
                            }}
                            disabled={syncingProductId === prod.id}
                            className="p-1.5 text-gray-400 hover:text-orange-600 hover:bg-orange-50 rounded-lg transition-all disabled:opacity-60"
                            title="Cập nhật / Đồng bộ lên Shopee"
                          >
                            <RefreshCw className={`w-4 h-4 ${syncingProductId === prod.id ? 'animate-spin text-orange-600' : ''}`} />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              if (group.hasVariants) {
                                const ok = confirm(
                                  `Xóa sản phẩm "${group.displayTitle}" và ${group.variantCount} phân loại khỏi Kho gốc?`
                                );
                                if (!ok) return;
                                group.variants.forEach((v) => onDeleteProduct(v.id));
                                if (!group.variants.some((v) => v.id === prod.id)) {
                                  onDeleteProduct(prod.id);
                                }
                              } else {
                                if (!confirm(`Xóa sản phẩm "${group.displayTitle}" khỏi Kho gốc?`)) return;
                                onDeleteProduct(prod.id);
                              }
                            }}
                            className="p-1.5 text-gray-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-all"
                            title="Xóa sản phẩm"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );

                  if (group.hasVariants && isExpanded) {
                    for (const child of group.variants) {
                      rows.push(
                        <tr key={`${group.groupId}-${child.id}`} className="bg-slate-50/80 hover:bg-slate-100/80">
                          <td className="p-3 pl-4 text-center">
                            <input
                              type="checkbox"
                              checked={selectedIds.includes(child.id)}
                              onChange={() => {
                                if (selectedIds.includes(child.id)) {
                                  onBulkSelect(selectedIds.filter((id) => id !== child.id));
                                } else {
                                  onBulkSelect([...selectedIds, child.id]);
                                }
                              }}
                              className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 w-4 h-4 cursor-pointer"
                            />
                          </td>
                          <td className="p-3 pl-12 max-w-xs">
                            <div className="flex items-center gap-2 border-l-2 border-indigo-200 pl-3">
                              {(child.avatarUrl || child.imageUrl) ? (
                                <img
                                  src={child.avatarUrl || child.imageUrl}
                                  alt={child.modelName || child.title}
                                  className="w-8 h-8 rounded-md object-cover border border-gray-100 shrink-0 cursor-zoom-in hover:opacity-90 transition-opacity"
                                  referrerPolicy="no-referrer"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setSelectedImage(child.avatarUrl || child.imageUrl || null);
                                  }}
                                  title="Nhấn để phóng to"
                                />
                              ) : (
                                <div className="w-8 h-8 rounded-md bg-indigo-50 text-indigo-400 flex items-center justify-center text-[10px] font-bold shrink-0">SK</div>
                              )}
                              <div className="min-w-0">
                                <button
                                  type="button"
                                  onClick={() => openProductDetail(child)}
                                  className="text-xs font-semibold text-gray-800 hover:text-blue-600 line-clamp-1 text-left"
                                >
                                  {child.modelName || child.title}
                                </button>
                              </div>
                            </div>
                          </td>
                          <td className="p-3">
                            <div className="space-y-0.5">
                              <input
                                type="text"
                                value={child.sku || ''}
                                onClick={(e) => e.stopPropagation()}
                                onChange={(e) => onUpdateProduct({ ...child, sku: e.target.value })}
                                className="w-full max-w-[140px] px-1.5 py-1 font-mono text-xs text-indigo-700 font-semibold bg-white hover:bg-indigo-50/50 focus:bg-white rounded border border-indigo-100 outline-none focus:border-indigo-400"
                                title="Sửa SKU"
                              />
                              {child.modelName && (
                                <span className="text-[10px] text-gray-400 block">{child.modelName}</span>
                              )}
                            </div>
                          </td>
                          <td className="p-3">
                            <input
                              type="number"
                              value={child.stock}
                              onChange={(e) => onUpdateProduct({ ...child, stock: Math.max(0, Number(e.target.value)) })}
                              onBlur={() => persistInlineProduct(child.id)}
                              className="w-16 px-1.5 py-1 text-center bg-white hover:bg-gray-50 focus:bg-white rounded border border-gray-200 outline-none text-xs focus:border-blue-500 font-mono"
                            />
                          </td>
                          <td className="p-3 text-right">
                            <div className="flex items-center justify-end gap-1">
                              <CurrencyInput
                                value={Math.max(0, Number(child.importPrice) || 0)}
                                onChange={(v) => onUpdateProduct({ ...child, importPrice: v })}
                                className="w-28 px-1.5 py-1 text-right bg-white hover:bg-gray-50 focus:bg-white rounded border border-gray-200 outline-none text-xs focus:border-blue-500 font-mono"
                                title="Giá nhập"
                              />
                              <span className="text-[10px] text-gray-400">đ</span>
                            </div>
                          </td>
                          <td className="p-3 text-right">
                            {(() => {
                              const childProfit = calculateEstimatedProductProfit(child, systemFees);
                              return (
                                <>
                                  <div className="flex items-center justify-end gap-1">
                                    <input
                                      type="number"
                                      value={child.sellingPrice}
                                      onChange={(e) => onUpdateProduct({ ...child, sellingPrice: Math.max(0, Number(e.target.value)) })}
                                      onBlur={() => persistInlineProduct(child.id)}
                                      className="w-24 px-1.5 py-1 text-right bg-white rounded border border-gray-200 outline-none text-xs focus:border-blue-500 font-bold font-mono"
                                    />
                                    <span className="text-[10px] text-gray-400">đ</span>
                                  </div>
                                  <div className={`text-[10px] flex items-center justify-end gap-0.5 mt-0.5 ${childProfit >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                                    <TrendingUp className="w-3 h-3" /> Lãi: {childProfit.toLocaleString('vi-VN')}đ
                                  </div>
                                </>
                              );
                            })()}
                          </td>
                          <td className="p-3">
                            <span className="inline-flex items-center text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-orange-50 text-orange-600 border border-orange-100">
                              Shopee
                            </span>
                          </td>
                          <td className="p-3 text-center">
                            <div className="flex items-center justify-center gap-1">
                              <button
                                onClick={() => openProductDetail(child)}
                                className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-all"
                                title="Sửa phân loại"
                              >
                                <Edit3 className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => void handleSaveImportPrice(child)}
                                disabled={savingImportPriceId === child.id}
                                className="p-1.5 text-gray-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg transition-all disabled:opacity-60"
                                title="Lưu phân loại (SKU / giá nhập)"
                              >
                                <Save className={`w-3.5 h-3.5 ${savingImportPriceId === child.id ? 'animate-pulse text-emerald-600' : ''}`} />
                              </button>
                              <button
                                onClick={() => void handleQuickSyncShopee(child.id)}
                                disabled={syncingProductId === child.id}
                                className="p-1.5 text-gray-400 hover:text-orange-600 hover:bg-orange-50 rounded-lg transition-all disabled:opacity-60"
                                title="Cập nhật / Đồng bộ lên Shopee"
                              >
                                <RefreshCw className={`w-3.5 h-3.5 ${syncingProductId === child.id ? 'animate-spin text-orange-600' : ''}`} />
                              </button>
                              <button
                                onClick={() => {
                                  if (!confirm(`Xóa phân loại "${child.modelName || child.sku}" khỏi Kho gốc?`)) return;
                                  onDeleteProduct(child.id);
                                }}
                                className="p-1.5 text-gray-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-all"
                                title="Xóa phân loại"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    }
                  }

                  return rows;
                })
              )}
            </tbody>
          </table>
        </div>
        {(productsMeta?.total != null && productsMeta.total > 0) && (
          <div className="px-4 py-3 bg-gray-50/80 border-t border-gray-100 flex flex-wrap items-center justify-between gap-2 text-xs text-gray-600">
            <span>
              Trang <b>{productsMeta.page}</b>/{productsMeta.totalPages} — hiển thị {products.length}/{productsMeta.total} sản phẩm mẹ
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={productsLoading || productsMeta.page <= 1}
                onClick={() => onRefreshProducts?.({ page: productsMeta.page - 1, append: false, search: serverSearch })}
                className="px-3 py-1.5 rounded-lg border border-gray-200 bg-white disabled:opacity-40 font-semibold"
              >
                Trang trước
              </button>
              <button
                type="button"
                disabled={productsLoading || !productsMeta.hasMore}
                onClick={() => onRefreshProducts?.({ page: productsMeta.page + 1, append: false, search: serverSearch })}
                className="px-3 py-1.5 rounded-lg border border-gray-200 bg-white disabled:opacity-40 font-semibold"
              >
                Trang sau
              </button>
              {productsMeta.hasMore && (
                <button
                  type="button"
                  disabled={productsLoading}
                  onClick={() => onRefreshProducts?.({ page: productsMeta.page + 1, append: true, search: serverSearch })}
                  className="px-3 py-1.5 rounded-lg bg-indigo-50 text-indigo-700 border border-indigo-100 font-semibold"
                >
                  Tải thêm
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Products Card List - Mobile-First */}
      <div className="max-md:block md:hidden space-y-4">
        {filteredGroups.length === 0 ? (
          <div className="bg-white rounded-2xl border border-gray-150 p-16 text-center">
            <p className="text-sm font-semibold text-gray-400 tracking-wide">
              {productsLoading ? 'Đang tải...' : 'Không tìm thấy sản phẩm'}
            </p>
          </div>
        ) : (
          filteredGroups.map((group) => {
            const prod = group.representative;
            const isLowStock = group.totalStock > 0 && group.totalStock <= 10;
            const isOutStock = group.totalStock === 0;
            const priceLabel = formatPriceRange(group.minSellingPrice, group.maxSellingPrice);
            const isExpanded = expandedParentIds.has(group.groupId);
            const estimatedProfit = calculateEstimatedProductProfit(prod, systemFees);

            return (
              <div key={group.groupId} className="bg-white rounded-2xl border border-gray-150 p-4 shadow-xs space-y-3">
                <div className="flex items-center gap-3">
                  {group.hasVariants && (
                    <button
                      type="button"
                      onClick={() => toggleParentExpand(group.groupId)}
                      className="w-8 h-8 flex items-center justify-center rounded-lg bg-gray-50 text-gray-600 font-black text-sm shrink-0"
                    >
                      {isExpanded ? '▼' : '>>'}
                    </button>
                  )}
                  {(prod.avatarUrl || prod.imageUrl) ? (
                    <img 
                      src={prod.avatarUrl || prod.imageUrl} 
                      alt={group.displayTitle} 
                      className="w-12 h-12 rounded-xl object-cover border border-gray-100 shrink-0 cursor-zoom-in active:opacity-80" 
                      referrerPolicy="no-referrer"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedImage(prod.avatarUrl || prod.imageUrl || null);
                      }}
                      title="Nhấn để phóng to"
                    />
                  ) : (
                    <div className="w-12 h-12 rounded-xl bg-gray-100 text-gray-400 flex items-center justify-center text-xs font-bold shrink-0">
                      SP
                    </div>
                  )}
                  <div className="space-y-0.5 flex-1 min-w-0">
                    <button 
                      onClick={() => openProductDetail(prod)}
                      className="font-black text-slate-900 hover:text-blue-600 transition-colors text-left block text-sm truncate w-full"
                    >
                      {group.displayTitle}
                    </button>
                    {group.hasVariants ? (
                      <span className="text-[10px] font-bold text-indigo-600 block">
                        {group.variantCount} phân loại
                      </span>
                    ) : (
                      <span className="text-[10px] text-gray-400 font-mono font-bold block">
                        SKU: {prod.sku}
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => openProductDetail(prod)}
                    className="w-9 h-9 flex items-center justify-center rounded-xl bg-blue-50 text-blue-600 hover:bg-blue-100 border border-blue-100 shrink-0 transition-all"
                    title="Sửa sản phẩm"
                    aria-label="Sửa sản phẩm"
                  >
                    <Edit3 className="w-4 h-4" />
                  </button>
                  {group.hasVariants && (
                    <button
                      type="button"
                      onClick={() => void handleSaveAllVariants(group.groupId, group.variants)}
                      disabled={savingAllVariantsParentId === group.groupId}
                      className="w-9 h-9 flex items-center justify-center rounded-xl bg-emerald-50 text-emerald-600 hover:bg-emerald-100 border border-emerald-100 shrink-0 transition-all disabled:opacity-60"
                      title="Lưu toàn bộ phân loại"
                      aria-label="Lưu toàn bộ"
                    >
                      {savingAllVariantsParentId === group.groupId ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Save className="w-4 h-4" />
                      )}
                    </button>
                  )}
                </div>

                {group.hasVariants && isExpanded && (
                  <div className="space-y-2 border-t border-gray-50 pt-2">
                    {group.variants.map((child) => {
                      const childProfit = calculateEstimatedProductProfit(child, systemFees);
                      return (
                      <div key={child.id} className="flex items-center gap-2 bg-slate-50 rounded-xl p-2.5">
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-semibold text-gray-800 truncate">{child.modelName || child.title}</p>
                          <p className="text-[10px] font-mono text-indigo-600 flex items-center gap-1">
                            <span className="shrink-0">SKU:</span>
                            <input
                              type="text"
                              value={child.sku || ''}
                              onChange={(e) => onUpdateProduct({ ...child, sku: e.target.value })}
                              className="flex-1 min-w-0 px-1 py-0.5 font-mono text-[10px] text-indigo-700 font-semibold bg-white rounded border border-indigo-100 outline-none focus:border-indigo-400"
                              title="Sửa SKU"
                            />
                          </p>
                          <p className={`text-[10px] font-semibold mt-0.5 ${childProfit >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                            Lãi: {childProfit.toLocaleString('vi-VN')}đ
                          </p>
                          <div className="flex items-center gap-1 mt-1">
                            <CurrencyInput
                              value={Math.max(0, Number(child.importPrice) || 0)}
                              onChange={(v) => onUpdateProduct({ ...child, importPrice: v })}
                              className="w-24 px-1 py-0.5 text-right bg-white rounded border border-gray-200 outline-none text-[10px] focus:border-blue-500 font-mono"
                            />
                            <span className="text-[9px] text-gray-400">đ</span>
                          </div>
                        </div>
                        <span className="text-xs font-mono font-bold text-slate-700">{child.stock}</span>
                        <button
                          type="button"
                          onClick={() => void handleSaveImportPrice(child)}
                          disabled={savingImportPriceId === child.id}
                          className="w-8 h-8 flex items-center justify-center rounded-lg bg-white text-emerald-600 hover:bg-emerald-50 border border-emerald-100 shrink-0 transition-all disabled:opacity-60"
                          title="Lưu phân loại (SKU / giá nhập)"
                          aria-label="Lưu phân loại"
                        >
                          <Save className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => openProductDetail(child)}
                          className="w-8 h-8 flex items-center justify-center rounded-lg bg-white text-blue-600 hover:bg-blue-50 border border-blue-100 shrink-0 transition-all"
                          title="Sửa phân loại"
                          aria-label="Sửa phân loại"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      );
                    })}
                  </div>
                )}

                <div className="grid grid-cols-3 gap-2 pt-2.5 border-t border-gray-50 text-xs font-semibold">
                  <div>
                    <span className="text-gray-400 text-[9px] block uppercase font-bold tracking-wider">Giá nhập:</span>
                    {group.hasVariants ? (
                      <span className="font-mono font-bold text-gray-700 text-[11px]">
                        {prod.importPrice.toLocaleString('vi-VN')} đ
                      </span>
                    ) : (
                      <div className="flex items-center gap-1 mt-0.5">
                        <CurrencyInput
                          value={Math.max(0, Number(prod.importPrice) || 0)}
                          onChange={(v) => onUpdateProduct({ ...prod, importPrice: v })}
                          className="w-full px-1.5 py-1 text-right bg-gray-50 rounded border border-gray-100 outline-none text-[11px] focus:border-blue-500 font-mono"
                        />
                        <button
                          type="button"
                          onClick={() => void handleSaveImportPrice(prod)}
                          disabled={savingImportPriceId === prod.id}
                          className="p-1 text-emerald-600 hover:bg-emerald-50 rounded disabled:opacity-60 shrink-0"
                          title="Lưu giá nhập"
                        >
                          <Save className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}
                  </div>
                  <div>
                    <span className="text-gray-400 text-[9px] block uppercase font-bold tracking-wider">Giá bán:</span>
                    <span className="font-mono font-black text-blue-600 text-[11px]">
                      {priceLabel}
                    </span>
                    <span className={`text-[10px] font-semibold mt-0.5 block ${estimatedProfit >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                      Lãi: {estimatedProfit.toLocaleString('vi-VN')}đ
                    </span>
                  </div>
                  <div>
                    <span className="text-gray-400 text-[9px] block uppercase font-bold tracking-wider">Tồn kho:</span>
                    <div className="flex items-center gap-1">
                      <span className={`font-mono font-bold text-[11px] ${isOutStock ? 'text-rose-600 font-black' : isLowStock ? 'text-amber-600 font-black' : 'text-slate-800'}`}>
                        {group.totalStock}
                      </span>
                      {isOutStock && (
                        <AlertCircle className="w-3.5 h-3.5 text-rose-500 shrink-0" title="Hết hàng" />
                      )}
                      {isLowStock && (
                        <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0" title="Sắp hết hàng" />
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-end pt-2 border-t border-gray-50">
                  <button 
                    onClick={() => openProductDetail(prod)}
                    className="w-full min-h-11 px-3 py-3 bg-blue-50 hover:bg-blue-100 text-blue-700 font-bold text-xs rounded-xl flex items-center justify-center gap-1 transition-all border border-blue-100"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    <span>Xem chi tiết</span>
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {activeProduct && (
        <ProductDetailModal
          product={activeProduct}
          allProducts={products}
          onClose={() => setActiveProduct(null)}
          onUpdateProduct={onUpdateProduct}
          onSyncItemVariants={onSyncItemVariants}
          onProductsRefresh={handleProductsRefresh}
          systemFees={systemFees}
        />
      )}

      {showBulkPriceModal && (
        <BulkPriceEditModal
          products={products}
          selectedIds={selectedIds}
          onClose={() => setShowBulkPriceModal(false)}
          onApply={handleBulkPriceApply}
        />
      )}

      {showBulkModal && onBulkSave && (
        <BulkEditModal
          products={products}
          selectedIds={selectedIds}
          suppliers={suppliers}
          onClose={() => setShowBulkModal(false)}
          onSave={handleBulkSave}
        />
      )}

      </div>

      {/* Modal: Add Product */}
      {showAddModal && (
        <div className="fixed inset-0 bg-gray-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in">
          <div className="bg-white rounded-3xl max-w-2xl w-full max-h-[90vh] overflow-hidden shadow-2xl flex flex-col">
            <div className="p-6 border-b border-gray-100 flex items-start justify-between">
              <div>
                <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                  <Package className="w-5 h-5 text-blue-600" /> Thêm Sản Phẩm Mới Vào Hệ Thống
                </h3>
                <p className="text-xs text-gray-400 mt-1">Điền tay thông tin cơ bản hoặc dùng AI để tối ưu hóa tiêu đề & viết mô tả tự động.</p>
              </div>
              <button 
                onClick={() => setShowAddModal(false)}
                className="p-1.5 hover:bg-gray-100 rounded-full transition-all text-gray-400 hover:text-gray-600"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleCreateProduct} className="overflow-y-auto p-6 space-y-4 flex-1">
              {aiError && (
                <div className="p-3 bg-red-50 border border-red-100 text-red-700 text-xs rounded-xl flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{aiError}</span>
                </div>
              )}

              {/* Title Input & AI Generate Trigger */}
              <div className="space-y-1.5">
                <div className="flex justify-between items-center">
                  <label className="text-xs font-semibold text-gray-700">Tên sản phẩm / Tiêu đề gốc</label>
                  <button
                    type="button"
                    onClick={handleAIGenerate}
                    disabled={aiLoading || !newTitle}
                    className="inline-flex items-center gap-1 px-3 py-1 bg-linear-to-r from-purple-500 to-indigo-600 text-white rounded-lg text-xs font-semibold hover:from-purple-600 hover:to-indigo-700 disabled:from-gray-200 disabled:to-gray-300 disabled:text-gray-400 cursor-pointer transition-all shadow-xs"
                    title="AI tự động nâng cấp tiêu đề chuẩn SEO và viết mô tả bán hàng chuyên nghiệp"
                  >
                    <Sparkles className={`w-3.5 h-3.5 ${aiLoading ? 'animate-spin' : ''}`} />
                    {aiLoading ? 'AI đang viết...' : 'Tạo Tự Động (AI)'}
                  </button>
                </div>
                <input 
                  type="text" 
                  required
                  placeholder="Ví dụ: nồi chiên không dầu philips 5 lít"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  className="w-full px-3 py-2.5 bg-gray-50/50 rounded-xl border border-gray-100 focus:border-blue-500 focus:bg-white text-sm outline-none transition-all"
                />
              </div>

              {/* SKU, Category & Channels */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-gray-700">Mã SKU nội bộ</label>
                  <input 
                    type="text" 
                    required
                    placeholder="VD: PH-NCKD-5L"
                    value={newSku}
                    onChange={(e) => setNewSku(e.target.value)}
                    className="w-full px-3 py-2.5 bg-gray-50/50 rounded-xl border border-gray-100 focus:border-blue-500 focus:bg-white text-sm outline-none font-mono"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-gray-700">Danh mục</label>
                  <select 
                    value={newCategory}
                    onChange={(e) => setNewCategory(e.target.value)}
                    className="w-full px-3 py-2.5 bg-gray-50/50 rounded-xl border border-gray-100 focus:border-blue-500 focus:bg-white text-sm outline-none cursor-pointer"
                  >
                    <option value="Gia dụng">Gia dụng</option>
                    <option value="Mỹ phẩm">Mỹ phẩm</option>
                    <option value="Thời trang">Thời trang</option>
                    <option value="Điện tử">Điện tử</option>
                    <option value="Mẹ & Bé">Mẹ & Bé</option>
                    <option value="Khác">Khác</option>
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-gray-700">Tồn kho ban đầu</label>
                  <input 
                    type="number" 
                    min="0"
                    required
                    value={newStock}
                    onChange={(e) => setNewStock(Math.max(0, Number(e.target.value)))}
                    className="w-full px-3 py-2.5 bg-gray-50/50 rounded-xl border border-gray-100 focus:border-blue-500 focus:bg-white text-sm outline-none font-mono"
                  />
                </div>
              </div>

              {/* Cost & Selling Prices */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-gray-700 flex items-center gap-1">
                    <Coins className="w-3.5 h-3.5 text-gray-400" /> Giá nhập sỉ (Vốn đầu vào VNĐ)
                  </label>
                  <input 
                    type="number" 
                    min="0"
                    required
                    value={newImportPrice}
                    onChange={(e) => setNewImportPrice(Math.max(0, Number(e.target.value)))}
                    className="w-full px-3 py-2.5 bg-gray-50/50 rounded-xl border border-gray-100 focus:border-blue-500 focus:bg-white text-sm outline-none font-mono text-gray-700 font-medium"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-gray-700 flex items-center gap-1">
                    <TrendingUp className="w-3.5 h-3.5 text-emerald-500" /> Giá bán lẻ đề xuất (VNĐ)
                  </label>
                  <input 
                    type="number" 
                    min="0"
                    required
                    value={newSellingPrice}
                    onChange={(e) => setNewSellingPrice(Math.max(0, Number(e.target.value)))}
                    className="w-full px-3 py-2.5 bg-gray-50/50 rounded-xl border border-gray-100 focus:border-blue-500 focus:bg-white text-sm outline-none font-mono text-emerald-700 font-bold"
                  />
                </div>
              </div>

              {/* Image URL & Channel Options */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-gray-700">Link ảnh sản phẩm (Nếu có)</label>
                  <input 
                    type="url" 
                    placeholder="https://..."
                    value={newImageUrl}
                    onChange={(e) => setNewImageUrl(e.target.value)}
                    className="w-full px-3 py-2.5 bg-gray-50/50 rounded-xl border border-gray-100 focus:border-blue-500 focus:bg-white text-sm outline-none text-gray-600"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-gray-700">Kênh đăng tải lên</label>
                  <div className="flex gap-4 pt-2">
                    <label className="inline-flex items-center gap-2 text-xs font-bold text-gray-700 cursor-pointer">
                      <input 
                        type="checkbox"
                        checked={newChannels.includes('shopee')}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setNewChannels([...newChannels, 'shopee']);
                          } else {
                            setNewChannels(newChannels.filter(c => c !== 'shopee'));
                          }
                        }}
                        className="rounded border-gray-300 text-orange-500 focus:ring-orange-400 w-4.5 h-4.5 cursor-pointer"
                      />
                      <span className="text-orange-600">Shopee</span>
                    </label>

                    <label className="inline-flex items-center gap-2 text-xs font-bold text-gray-700 cursor-pointer">
                      <input 
                        type="checkbox"
                        checked={newChannels.includes('tiktok')}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setNewChannels([...newChannels, 'tiktok']);
                          } else {
                            setNewChannels(newChannels.filter(c => c !== 'tiktok'));
                          }
                        }}
                        className="rounded border-gray-300 text-zinc-950 focus:ring-zinc-800 w-4.5 h-4.5 cursor-pointer"
                      />
                      <span>TikTok Shop</span>
                    </label>
                  </div>
                </div>
              </div>

              {/* Description */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-gray-700">Mô tả sản phẩm (Markdown hỗ trợ)</label>
                <textarea 
                  rows={4}
                  placeholder="Hãy giới thiệu chi tiết về sản phẩm, đặc điểm, công năng..."
                  value={newDescription}
                  onChange={(e) => setNewDescription(e.target.value)}
                  className="w-full px-3 py-2.5 bg-gray-50/50 rounded-xl border border-gray-100 focus:border-blue-500 focus:bg-white text-xs outline-none transition-all font-sans leading-relaxed"
                />
              </div>
            </form>

            <div className="p-4 bg-gray-50 border-t border-gray-100 flex justify-end gap-3">
              <button 
                type="button"
                onClick={() => setShowAddModal(false)}
                className="px-5 py-2 bg-white hover:bg-gray-100 border border-gray-200 text-gray-700 font-semibold text-sm rounded-xl transition-all"
              >
                Hủy bỏ
              </button>
              <button 
                type="button"
                onClick={handleCreateProduct}
                disabled={!newTitle || !newSku}
                className="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white font-semibold text-sm rounded-xl transition-all shadow-sm disabled:bg-gray-300 disabled:cursor-not-allowed"
              >
                Tạo sản phẩm
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Image Zoom Overlay */}
      {selectedImage && (
        <div
          className="fixed inset-0 z-[9999] bg-black/80 flex items-center justify-center p-4"
          onClick={() => setSelectedImage(null)}
          role="dialog"
          aria-modal="true"
          aria-label="Phóng to ảnh sản phẩm"
        >
          <button
            type="button"
            onClick={() => setSelectedImage(null)}
            className="absolute top-4 right-4 z-[10000] w-10 h-10 flex items-center justify-center rounded-full bg-white/15 hover:bg-white/25 text-white transition-colors cursor-pointer"
            aria-label="Đóng"
            title="Đóng"
          >
            <X className="w-6 h-6" />
          </button>
          <img
            src={selectedImage}
            alt="Ảnh sản phẩm phóng to"
            className="max-w-full max-h-[90vh] w-auto h-auto object-contain rounded-lg shadow-2xl"
            style={{ objectFit: 'contain' }}
            referrerPolicy="no-referrer"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}

      <ImportPriceModal
        open={showImportPriceModal}
        onClose={() => setShowImportPriceModal(false)}
        onError={(message) => showActionToast(message, false)}
        onImported={({ updatedCount, notFoundCount }) => {
          setShowImportPriceModal(false);
          const extra =
            notFoundCount > 0 ? ` (${notFoundCount} SKU không tìm thấy trong kho)` : '';
          showActionToast(
            `Thành công: Cập nhật giá nhập cho ${updatedCount} sản phẩm.${extra}`,
            true,
            6000,
          );
          void onRefreshProducts?.({ page: 1, append: false, forceRefresh: true });
        }}
      />

      {/* ========================================================================= */}
      {/* MODAL: INITIALIZE MAIN WAREHOUSE FROM MARKETPLACE */}
      {/* ========================================================================= */}
      {showInitModal && (
        <div className="fixed inset-0 bg-gray-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in">
          <div className="bg-white rounded-3xl max-w-lg w-full overflow-hidden shadow-2xl flex flex-col border border-gray-100">
            {/* Header with 'X' close button */}
            <div className="p-5 border-b border-gray-100 flex items-center justify-between bg-orange-50">
              <h3 className="text-sm font-black text-orange-700 uppercase tracking-wider flex items-center gap-2">
                <Store className="w-4 h-4 text-orange-600" />
                <span>Khởi tạo Kho chính từ sàn</span>
              </h3>
              <button
                onClick={() => { if (!isInitializing) setShowInitModal(false); }}
                className="p-1 hover:bg-orange-100 rounded-full transition-all text-orange-500 hover:text-orange-800 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-6 space-y-5">
              <div className="bg-orange-50/70 border border-orange-200/50 p-4 rounded-xl text-xs text-orange-800 leading-relaxed font-semibold">
                Hệ thống sẽ kết nối tới sàn bạn chọn để lấy dữ liệu sản phẩm và lưu trực tiếp vào Kho gốc.
                Sau khi khởi tạo thành công, bảng Kho gốc sẽ được tải lại ngay mà không cần làm mới trang.
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-black text-gray-700">Chọn sàn khởi tạo</label>
                <div className="relative">
                  <select
                    value={initPlatform}
                    onChange={(e) => setInitPlatform(e.target.value as 'shopee' | 'tiktok')}
                    disabled={isInitializing}
                    className="w-full pl-4 pr-10 py-3 bg-white border border-gray-250 rounded-xl text-xs font-bold text-gray-700 focus:outline-none focus:border-blue-500 cursor-pointer disabled:bg-gray-50"
                  >
                    <option value="shopee">Shopee</option>
                    <option value="tiktok">TikTok</option>
                  </select>
                  <Store className="w-4 h-4 text-gray-400 absolute right-3 top-3.5 pointer-events-none" />
                </div>
              </div>

              {/* Shop Selector */}
              <div className="space-y-1.5">
                <label className="text-xs font-black text-gray-700">
                  {`Lựa chọn gian hàng ${initPlatform === 'shopee' ? 'Shopee' : 'TikTok'} nguồn`}
                </label>
                <div className="relative">
                  <select
                    value={initShopId}
                    onChange={(e) => setInitShopId(e.target.value)}
                    disabled={isInitializing}
                    className="w-full pl-4 pr-10 py-3 bg-white border border-gray-250 rounded-xl text-xs font-bold text-gray-700 focus:outline-none focus:border-blue-500 cursor-pointer disabled:bg-gray-50"
                  >
                    {initPlatformShops.map((shop) => (
                      <option key={shop.id} value={shop.id}>
                        {shop.shopName} (Mã shop: {shop.shopId})
                      </option>
                    ))}
                    {initPlatformShops.length === 0 && (
                      <option value="" disabled>{`Chưa có gian hàng ${initPlatform === 'shopee' ? 'Shopee' : 'TikTok'}`}</option>
                    )}
                  </select>
                  <Store className="w-4 h-4 text-gray-400 absolute right-3 top-3.5 pointer-events-none" />
                </div>
              </div>

              {initPlatform === 'tiktok' && (
                <div className="bg-amber-50 border border-amber-200 p-4 rounded-xl text-xs text-amber-800 font-semibold">
                  Tính năng chưa tích hợp API
                </div>
              )}

              {/* Progress Logger during import */}
              {isInitializing && (
                <div className="p-4 bg-slate-950 rounded-2xl text-xs font-mono text-orange-400 space-y-1.5 max-h-40 overflow-y-auto shadow-inner border border-slate-800">
                  <div className="flex items-center gap-2 mb-1.5">
                    <RefreshCw className="w-3.5 h-3.5 animate-spin text-orange-400" />
                    <span className="font-bold">{`TIẾN TRÌNH KẾT NỐI ${initPlatform.toUpperCase()} API:`}</span>
                  </div>
                  {initProgress.map((p, idx) => (
                    <p key={idx} className="animate-pulse">{p}</p>
                  ))}
                </div>
              )}
            </div>

            {/* Footer Buttons */}
            <div className="p-4 bg-slate-50 border-t border-gray-100 flex justify-end gap-3.5">
              <button
                type="button"
                onClick={() => { if (!isInitializing) setShowInitModal(false); }}
                disabled={isInitializing}
                className="px-5 py-2.5 bg-white hover:bg-gray-100 border border-gray-200 text-gray-700 font-extrabold text-xs rounded-xl transition-all cursor-pointer disabled:opacity-50"
              >
                Thoát
              </button>
              
              <button
                type="button"
                onClick={handleConfirmMarketplaceInit}
                disabled={isInitializing || initPlatform === 'tiktok' || !initShopId}
                className="px-5 py-2.5 bg-orange-600 hover:bg-orange-700 text-white font-extrabold text-xs rounded-xl transition-all shadow-md shadow-orange-500/15 flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
              >
                {isInitializing ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>Đang khởi tạo...</span>
                  </>
                ) : (
                  <span>Xác nhận khởi tạo</span>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
