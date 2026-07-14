import React, { useState, useEffect, useMemo } from 'react';
import { Product, ConnectedShop, SyncLog, Supplier, BulkSaveProductUpdate } from '../types';
import ProductDetailModal, {
  buildProductGroups,
  formatPriceRange,
  isJunkCategoryLabel,
  type ProductGroupRow,
} from './ProductDetailModal';
import BulkEditModal from './BulkEditModal';
import ProductLinking from './ProductLinking';
import InventoryAudit from './InventoryAudit';
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
  AlertTriangle
} from 'lucide-react';

interface ProductListProps {
  products: Product[];
  onAddProduct: (product: Product) => void;
  onUpdateProduct: (product: Product, opts?: { save?: boolean }) => void;
  onDeleteProduct: (id: string) => void;
  onReplaceProducts?: (products: Product[]) => void;
  onBulkSave?: (updates: BulkSaveProductUpdate[]) => Promise<boolean>;
  onSyncItemVariants?: (itemId: string) => Promise<Product[] | null>;
  onRefreshProducts?: () => Promise<void>;
  onProductsUpdated?: (products: Product[]) => void;
  onBulkSelect: (selectedIds: string[]) => void;
  selectedIds: string[];
  onTabChange: (tab: string) => void;
  highlightProductId?: string | null;
  onClearHighlight?: () => void;
  shops?: ConnectedShop[];
  suppliers?: Supplier[];
  onAddLog?: (log: SyncLog) => void;
  productsLoading?: boolean;
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
  onTabChange,
  highlightProductId,
  onClearHighlight,
  shops = [],
  suppliers = [],
  onAddLog = () => {},
  productsLoading = false,
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
  const [subTab, setSubTab] = useState<'warehouse' | 'linking' | 'audit'>('audit');

  // Shopee API initialization state
  const [showShopeeImportModal, setShowShopeeImportModal] = useState(false);
  const [shopeeImportShopId, setShopeeImportShopId] = useState('');

  useEffect(() => {
    const shopeeShops = shops.filter((s) => s.platform === 'shopee');
    if (shopeeShops.length === 0) {
      setShopeeImportShopId('');
      return;
    }
    if (!shopeeShops.some((s) => s.id === shopeeImportShopId)) {
      setShopeeImportShopId(shopeeShops[0].id);
    }
  }, [shops, shopeeImportShopId]);
  const [isShopeeImporting, setIsShopeeImporting] = useState(false);
  const [shopeeImportProgress, setShopeeImportProgress] = useState<string[]>([]);
  const [shopeeImportToast, setShopeeImportToast] = useState<string | null>(null);

  // Search & Filter state
  const [search, setSearch] = useState('');
  const [channelFilter, setChannelFilter] = useState<'all' | 'shopee' | 'tiktok' | 'none'>('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [stockFilter, setStockFilter] = useState<'all' | 'low' | 'out'>('all');

  // Detail Modal state
  const [activeProduct, setActiveProduct] = useState<Product | null>(null);

  // Bulk edit modal (Sapo-style)
  const [showBulkModal, setShowBulkModal] = useState(false);

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
    const current = products.find(p => p.id === id);
    if (current) onUpdateProduct(current, { save: true });
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

  const productGroups = useMemo(() => buildProductGroups(products), [products]);

  // Filter Categories
  const categories = ['all', ...Array.from(new Set(products.map(p => p.category).filter(c => !isJunkCategoryLabel(c))))];

  const filteredGroups = productGroups.filter((group) => {
    const rep = group.representative;
    const q = search.toLowerCase();
    const matchesSearch = !q || group.displayTitle.toLowerCase().includes(q) ||
      group.variants.some(v =>
        v.title.toLowerCase().includes(q) || v.sku.toLowerCase().includes(q)
      );

    const matchesChannel =
      channelFilter === 'all' ? true :
      channelFilter === 'shopee' ? rep.channels.includes('shopee') :
      channelFilter === 'tiktok' ? rep.channels.includes('tiktok') :
      rep.channels.length === 0;

    const matchesCategory = categoryFilter === 'all' ? true : rep.category === categoryFilter;

    const matchesStock =
      stockFilter === 'all' ? true :
      stockFilter === 'low' ? group.totalStock > 0 && group.totalStock <= 10 :
      group.totalStock === 0;

    return matchesSearch && matchesChannel && matchesCategory && matchesStock;
  });

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

  const handleTriggerShopeeImport = async () => {
    setIsShopeeImporting(true);
    setShopeeImportProgress(["🔌 Đang kết nối API v2 Shopee (get_item_list)..."]);

    const shop = shops.find(s => s.id === shopeeImportShopId) || shops.find(s => s.platform === 'shopee' && s.connected);
    if (!shop?.shopId) {
      alert('Chưa có gian hàng Shopee nào được kết nối. Vui lòng cấu hình trong Cài đặt trước.');
      setIsShopeeImporting(false);
      return;
    }
    const apiShopId = shop.shopId;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 300000);

    try {
      const token = localStorage.getItem('admin_token');
      const res = await fetch('/api/shopee/products/sync', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify({ shopId: apiShopId })
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data?.message || data?.error || 'Đồng bộ sản phẩm Shopee thất bại.');
      }

      const realProducts: Product[] = data.products || [];
      if (realProducts.length === 0) {
        // Never wipe an existing, working warehouse with an empty result —
        // treat a 0-item response as a failure so the user can retry safely.
        throw new Error('Shopee không trả về sản phẩm nào (0 item). Giữ nguyên Kho chính hiện tại, vui lòng thử lại.');
      }

      setShopeeImportProgress(prev => [
        ...prev,
        `📥 Đã lấy ${realProducts.length} sản phẩm thật từ get_item_list + get_item_base_info...`,
        "🧹 Đang làm trống Kho chính và nạp dữ liệu thật...",
      ]);

      // Full re-initialization: wipe the old/mock warehouse list and load only
      // what Shopee actually returned for this shop.
      if (onReplaceProducts) {
        await onReplaceProducts(realProducts);
      } else {
        realProducts.forEach(p => onAddProduct(p));
      }

      if (onRefreshProducts) {
        await onRefreshProducts();
      }

      const variantRows = realProducts.filter(p => p.shopeeModelId).length;
      setShopeeImportProgress(prev => [
        ...prev,
        `📦 Đã tách ${variantRows} dòng phân loại (model_sku) từ Shopee.`,
        `🎉 HOÀN TẤT: ${realProducts.length} dòng kho (gồm SKU phân loại con)!`,
      ]);
      setShopeeImportToast(`Khởi tạo kho thành công! ${realProducts.length} dòng (${variantRows} phân loại).`);

      onAddLog({
        id: `log-${Date.now()}`,
        timestamp: new Date().toISOString(),
        channel: 'shopee',
        type: 'product_sync',
        status: 'success',
        message: `Đồng bộ ${realProducts.length} sản phẩm thật từ Shopee (shop_id=${data.shopId}) vào Kho chính qua API v2 thành công.`
      });

      setShowShopeeImportModal(false);
    } catch (err: any) {
      const message = err?.name === 'AbortError'
        ? 'Quá thời gian chờ (5 phút) khi đồng bộ với Shopee. Kho chính hiện tại được giữ nguyên, vui lòng thử lại.'
        : (err?.message || 'Đồng bộ sản phẩm Shopee thất bại.');
      setShopeeImportProgress(prev => [...prev, `❌ Lỗi: ${message}`]);
      alert(`Đồng bộ sản phẩm Shopee thất bại: ${message}`);

      onAddLog({
        id: `log-${Date.now()}`,
        timestamp: new Date().toISOString(),
        channel: 'shopee',
        type: 'product_sync',
        status: 'failed',
        message: `Đồng bộ sản phẩm Shopee thất bại: ${message}`
      });
    } finally {
      clearTimeout(timeoutId);
      setIsShopeeImporting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Toast Notification for Shopee Import */}
      {shopeeImportToast && (
        <div className="fixed top-5 right-5 z-50 bg-slate-900 text-white font-bold text-xs px-5 py-3 rounded-2xl shadow-2xl border border-slate-700 animate-bounce flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          <span>{shopeeImportToast}</span>
          <button onClick={() => setShopeeImportToast(null)} className="ml-1 text-gray-400 hover:text-white cursor-pointer">
            <X className="w-3.5 h-3.5" />
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

      {subTab === 'linking' ? (
        <ProductLinking 
          products={products}
          shops={shops}
          onAddLog={onAddLog}
          onUpdateProduct={onUpdateProduct}
          onAddProduct={onAddProduct}
          onRefreshProducts={onRefreshProducts}
        />
      ) : subTab === 'audit' ? (
        <InventoryAudit
          products={products}
          shopId={shops.find(s => s.platform === 'shopee' && s.connected)?.shopId}
          onRefreshProducts={onRefreshProducts}
        />
      ) : (
        <>
          {/* Main Warehouse explanation & API integration banner */}
          <div className="max-md:hidden md:flex md:flex-row md:items-center bg-slate-50 border border-gray-150 p-4 rounded-2xl justify-between gap-4">
            <div className="space-y-1">
              <h4 className="text-xs font-black text-slate-800 uppercase tracking-wider flex items-center gap-1.5">
                <Database className="w-3.5 h-3.5 text-blue-500" />
                <span>CƠ SỞ DỮ LIỆU KHO SẢN PHẨM GỐC</span>
              </h4>
              <p className="text-[11px] text-gray-500 leading-relaxed font-semibold">
                Đây là kho chính chứa toàn bộ thông tin sản phẩm của doanh nghiệp. Bạn có thể tự động kéo danh sách sản phẩm đang bán trên Shopee về để khởi tạo kho chính này tự động chỉ bằng một cú click.
              </p>
            </div>
            
            <button
              onClick={() => setShowShopeeImportModal(true)}
              type="button"
              className="px-4 py-2.5 bg-orange-500 hover:bg-orange-600 text-white text-xs font-extrabold rounded-xl transition-all shadow-md shadow-orange-500/10 flex items-center justify-center gap-1.5 cursor-pointer shrink-0"
            >
              <RefreshCw className="w-3.5 h-3.5 text-white animate-spin" style={{ animationDuration: isShopeeImporting ? '2s' : '0s' }} />
              <span>Khởi tạo từ Shopee API</span>
            </button>
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
              onClick={() => setShowBulkModal(true)}
              className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold text-xs rounded-lg transition-all flex items-center gap-1.5"
            >
              <Edit3 className="w-3.5 h-3.5" /> Sửa hàng loạt
            </button>
            <button 
              onClick={() => onTabChange('bulk')}
              className="px-3 py-1.5 bg-white border border-indigo-200 hover:bg-indigo-100 text-indigo-700 font-medium text-xs rounded-lg transition-all flex items-center gap-1.5"
            >
              <Sparkles className="w-3.5 h-3.5" /> AI
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
                <th className="p-4">Tồn Kho</th>
                <th className="p-4 text-right">Giá Nhập</th>
                <th className="p-4 text-right">Giá Bán</th>
                <th className="p-4">Đăng Kênh</th>
                <th className="p-4 text-center">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50 text-sm">
              {filteredGroups.length === 0 ? (
                <tr>
                  <td colSpan={8} className="p-12 text-center text-gray-400">
                    Không tìm thấy sản phẩm nào khớp với bộ lọc.
                  </td>
                </tr>
              ) : (
                filteredGroups.map((group) => {
                  const prod = group.representative;
                  const priceLabel = formatPriceRange(group.minSellingPrice, group.maxSellingPrice);

                  return (
                    <tr
                      key={group.groupId}
                      className="hover:bg-gray-50/50 transition-colors cursor-pointer"
                      onClick={(e) => {
                        const tag = (e.target as HTMLElement).tagName;
                        if (tag === 'INPUT' || tag === 'BUTTON' || (e.target as HTMLElement).closest('button, input')) return;
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
                        <div className="flex items-center gap-3">
                          {(prod.avatarUrl || prod.imageUrl) ? (
                            <img src={prod.avatarUrl || prod.imageUrl} alt={group.displayTitle} className="w-11 h-11 rounded-lg object-cover border border-gray-100 shrink-0" referrerPolicy="no-referrer" />
                          ) : (
                            <div className="w-11 h-11 rounded-lg bg-gray-100 text-gray-400 flex items-center justify-center text-xs font-bold shrink-0">SP</div>
                          )}
                          <div className="space-y-0.5">
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
                            {group.variantCount} phiên bản
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
                        {prod.importPrice.toLocaleString('vi-VN')} đ
                      </td>
                      <td className="p-4 text-right font-mono font-bold text-gray-900">
                        {group.hasVariants ? (
                          <div className="text-xs font-bold text-gray-900">{priceLabel}</div>
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
                            <div className="text-[10px] text-emerald-600 flex items-center justify-end gap-0.5 mt-0.5">
                              <TrendingUp className="w-3 h-3" /> {prod.sellingPrice > 0 ? (((prod.sellingPrice - prod.importPrice) / prod.sellingPrice) * 100).toFixed(0) : 0}% lãi
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
                          {!group.hasVariants && (
                            <button 
                              onClick={(e) => { e.stopPropagation(); onDeleteProduct(prod.id); }}
                              className="p-1.5 text-gray-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-all"
                              title="Xóa sản phẩm"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Products Card List - Mobile-First */}
      <div className="max-md:block md:hidden space-y-4">
        {filteredGroups.length === 0 ? (
          <div className="bg-white rounded-2xl border border-gray-150 p-12 text-center text-gray-400 text-xs">
            Không tìm thấy sản phẩm nào khớp với bộ lọc.
          </div>
        ) : (
          filteredGroups.map((group) => {
            const prod = group.representative;
            const isLowStock = group.totalStock > 0 && group.totalStock <= 10;
            const isOutStock = group.totalStock === 0;
            const priceLabel = formatPriceRange(group.minSellingPrice, group.maxSellingPrice);

            return (
              <div key={group.groupId} className="bg-white rounded-2xl border border-gray-150 p-4 shadow-xs space-y-3">
                <div className="flex items-center gap-3">
                  {(prod.avatarUrl || prod.imageUrl) ? (
                    <img 
                      src={prod.avatarUrl || prod.imageUrl} 
                      alt={group.displayTitle} 
                      className="w-12 h-12 rounded-xl object-cover border border-gray-100 shrink-0" 
                      referrerPolicy="no-referrer" 
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
                        {group.variantCount} phiên bản
                      </span>
                    ) : (
                      <span className="text-[10px] text-gray-400 font-mono font-bold block">
                        SKU: {prod.sku}
                      </span>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2 pt-2.5 border-t border-gray-50 text-xs font-semibold">
                  <div>
                    <span className="text-gray-400 text-[9px] block uppercase font-bold tracking-wider">Giá nhập:</span>
                    <span className="font-mono font-bold text-gray-700 text-[11px]">
                      {prod.importPrice.toLocaleString('vi-VN')} đ
                    </span>
                  </div>
                  <div>
                    <span className="text-gray-400 text-[9px] block uppercase font-bold tracking-wider">Giá bán:</span>
                    <span className="font-mono font-black text-blue-600 text-[11px]">
                      {priceLabel}
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

        </>
      )}

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

      {/* ========================================================================= */}
      {/* MODAL: INITIALIZE MAIN WAREHOUSE FROM SHOPEE API */}
      {/* ========================================================================= */}
      {showShopeeImportModal && (
        <div className="fixed inset-0 bg-gray-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in">
          <div className="bg-white rounded-3xl max-w-lg w-full overflow-hidden shadow-2xl flex flex-col border border-gray-100">
            {/* Header with 'X' close button */}
            <div className="p-5 border-b border-gray-100 flex items-center justify-between bg-orange-50">
              <h3 className="text-sm font-black text-orange-700 uppercase tracking-wider flex items-center gap-2">
                <Store className="w-4 h-4 text-orange-600" />
                <span>Khởi tạo kho chính từ Shopee API</span>
              </h3>
              <button
                onClick={() => { if (!isShopeeImporting) setShowShopeeImportModal(false); }}
                className="p-1 hover:bg-orange-100 rounded-full transition-all text-orange-500 hover:text-orange-800 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-6 space-y-5">
              <div className="bg-orange-50/70 border border-orange-200/50 p-4 rounded-xl text-xs text-orange-800 leading-relaxed font-semibold">
                Hệ thống sẽ kết nối trực tiếp với API sàn Shopee để lấy danh mục sản phẩm đang bán. 
                Các sản phẩm này sẽ được tự động khởi tạo thành các sản phẩm gốc trong Kho chính và đồng thời ánh xạ liên kết sang danh mục liên kết.
              </div>

              {/* Shop Selector */}
              <div className="space-y-1.5">
                <label className="text-xs font-black text-gray-700">Lựa chọn gian hàng Shopee nguồn</label>
                <div className="relative">
                  <select
                    value={shopeeImportShopId}
                    onChange={(e) => setShopeeImportShopId(e.target.value)}
                    disabled={isShopeeImporting}
                    className="w-full pl-4 pr-10 py-3 bg-white border border-gray-250 rounded-xl text-xs font-bold text-gray-700 focus:outline-none focus:border-blue-500 cursor-pointer disabled:bg-gray-50"
                  >
                    {shops.filter(s => s.platform === 'shopee').map(shop => (
                      <option key={shop.id} value={shop.id}>
                        {shop.shopName} (Mã shop: {shop.shopId})
                      </option>
                    ))}
                    {shops.filter(s => s.platform === 'shopee').length === 0 && (
                      <option value="" disabled>Chưa có gian hàng Shopee</option>
                    )}
                  </select>
                  <Store className="w-4 h-4 text-gray-400 absolute right-3 top-3.5 pointer-events-none" />
                </div>
              </div>

              {/* Progress Logger during import */}
              {isShopeeImporting && (
                <div className="p-4 bg-slate-950 rounded-2xl text-xs font-mono text-orange-400 space-y-1.5 max-h-40 overflow-y-auto shadow-inner border border-slate-800">
                  <div className="flex items-center gap-2 mb-1.5">
                    <RefreshCw className="w-3.5 h-3.5 animate-spin text-orange-400" />
                    <span className="font-bold">TIẾN TRÌNH KẾT NỐI SHOPEE API:</span>
                  </div>
                  {shopeeImportProgress.map((p, idx) => (
                    <p key={idx} className="animate-pulse">{p}</p>
                  ))}
                </div>
              )}
            </div>

            {/* Footer Buttons */}
            <div className="p-4 bg-slate-50 border-t border-gray-100 flex justify-end gap-3.5">
              <button
                type="button"
                onClick={() => { if (!isShopeeImporting) setShowShopeeImportModal(false); }}
                disabled={isShopeeImporting}
                className="px-5 py-2.5 bg-white hover:bg-gray-100 border border-gray-200 text-gray-700 font-extrabold text-xs rounded-xl transition-all cursor-pointer disabled:opacity-50"
              >
                Thoát
              </button>
              
              <button
                type="button"
                onClick={handleTriggerShopeeImport}
                disabled={isShopeeImporting}
                className="px-5 py-2.5 bg-orange-600 hover:bg-orange-700 text-white font-extrabold text-xs rounded-xl transition-all shadow-md shadow-orange-500/15 flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
              >
                {isShopeeImporting ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>Đang khởi tạo...</span>
                  </>
                ) : (
                  <span>Khởi tạo ngay</span>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
