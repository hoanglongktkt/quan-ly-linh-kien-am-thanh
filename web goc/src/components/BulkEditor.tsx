import React, { useState, useEffect, useMemo } from 'react';
import { Product, SyncLog, BulkUpdatePayload, ConnectedShop } from '../types';
import {
  buildProductGroups,
  formatPriceRange,
  type ProductGroupRow,
} from './ProductDetailModal';
import { 
  Sparkles, 
  TrendingUp, 
  Settings2, 
  AlertCircle, 
  RefreshCw,
  ShoppingBag,
  Search,
  ChevronRight,
  ChevronDown,
  X,
} from 'lucide-react';

type SyncLogLine = { type: 'info' | 'success' | 'error'; text: string };

interface BulkEditorProps {
  products: Product[];
  selectedIds: string[];
  shops?: ConnectedShop[];
  onUpdateBulk: (updatedProducts: Product[]) => void;
  onBulkUpdate?: (payload: BulkUpdatePayload) => Promise<boolean>;
  onAddLog: (log: SyncLog) => void;
}

export default function BulkEditor({ products, selectedIds, shops = [], onUpdateBulk, onBulkUpdate, onAddLog }: BulkEditorProps) {
  // Local state for product selection and search query
  const [searchQuery, setSearchQuery] = useState('');
  const [localSelectedIds, setLocalSelectedIds] = useState<string[]>(() => {
    return selectedIds.length > 0 ? selectedIds : products.map(p => p.id);
  });

  // Sync selectedIds from parent (outer table) if changed
  useEffect(() => {
    if (selectedIds.length > 0) {
      setLocalSelectedIds(selectedIds);
    }
  }, [selectedIds]);

  // Popover state triggers
  const [showPricePopover, setShowPricePopover] = useState(false);
  const [showStockPopover, setShowStockPopover] = useState(false);

  // Pricing edit states
  const [priceAdjustmentType, setPriceAdjustmentType] = useState<'percent_up' | 'percent_down' | 'fixed_up' | 'fixed_down'>('percent_up');
  const [priceValue, setPriceValue] = useState<number>(10);

  // Stock edit states
  const [stockAdjustmentType, setStockAdjustmentType] = useState<'flat' | 'add'>('flat');
  const [stockValue, setStockValue] = useState<number>(50);

  // AI Actions states
  const [aiAction, setAiAction] = useState<'optimize-title' | 'suggest-prices' | 'bulk-tag'>('optimize-title');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiResponse, setAiResponse] = useState<string>('');
  const [aiError, setAiError] = useState('');
  
  // Specific single-product target for AI Advice
  const [aiTargetProdId, setAiTargetProdId] = useState(products[0]?.id || '');

  // Publish / Sync progress states
  const [syncChannel, setSyncChannel] = useState<'shopee' | 'tiktok' | 'woocommerce' | 'all'>('all');
  const [syncProgress, setSyncProgress] = useState(-1);
  const [syncLogs, setSyncLogs] = useState<SyncLogLine[]>([]);
  const [syncing, setSyncing] = useState(false);

  const [aiPanelOpen, setAiPanelOpen] = useState(false);

  const productGroups = useMemo(() => buildProductGroups(products), [products]);

  const filteredGroups = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return productGroups;
    return productGroups.filter(
      (group) =>
        group.displayTitle.toLowerCase().includes(q) ||
        group.variants.some(
          (v) =>
            v.title.toLowerCase().includes(q) || v.sku.toLowerCase().includes(q)
        )
    );
  }, [productGroups, searchQuery]);

  const allFilteredIds = useMemo(
    () => filteredGroups.flatMap((g) => g.variants.map((v) => v.id)),
    [filteredGroups]
  );

  const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(new Set());

  const toggleExpandGroup = (groupId: string) => {
    setExpandedGroupIds((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  const handleToggleGroup = (group: ProductGroupRow) => {
    const ids = group.variants.map((v) => v.id);
    const allSelected = ids.every((id) => localSelectedIds.includes(id));
    if (allSelected) {
      setLocalSelectedIds((prev) => prev.filter((id) => !ids.includes(id)));
    } else {
      setLocalSelectedIds((prev) => Array.from(new Set([...prev, ...ids])));
    }
  };

  const isGroupAllSelected = (group: ProductGroupRow) =>
    group.variants.length > 0 &&
    group.variants.every((v) => localSelectedIds.includes(v.id));

  const isGroupPartialSelected = (group: ProductGroupRow) => {
    const ids = group.variants.map((v) => v.id);
    const n = ids.filter((id) => localSelectedIds.includes(id)).length;
    return n > 0 && n < ids.length;
  };

  const toggleVariantSelect = (variantId: string) => {
    setLocalSelectedIds((prev) =>
      prev.includes(variantId)
        ? prev.filter((id) => id !== variantId)
        : [...prev, variantId]
    );
  };

  // targetProducts = các SKU con đang được chọn
  const targetProducts = products.filter((p) => localSelectedIds.includes(p.id));

  // Sync aiTargetProdId with target list if current one becomes unselected
  useEffect(() => {
    if (targetProducts.length > 0 && !localSelectedIds.includes(aiTargetProdId)) {
      setAiTargetProdId(targetProducts[0].id);
    }
  }, [localSelectedIds, targetProducts, aiTargetProdId]);

  const [bulkMsg, setBulkMsg] = useState<string | null>(null);

  // Apply math operations to price or stock
  const handleApplyMath = async (type: 'price' | 'stock') => {
    if (targetProducts.length === 0) {
      setBulkMsg('Vui lòng tích chọn ít nhất một sản phẩm để áp dụng chỉnh sửa hàng loạt!');
      return;
    }

    if (onBulkUpdate) {
      const payload: BulkUpdatePayload = {
        productIds: targetProducts.map(p => p.id),
      };
      if (type === 'price') {
        payload.price = { mode: priceAdjustmentType, value: priceValue };
      } else {
        payload.stock = {
          mode: stockAdjustmentType === 'flat' ? 'set' : 'delta',
          value: stockValue,
        };
      }

      const ok = await onBulkUpdate(payload);
      if (!ok) {
        setBulkMsg('Cập nhật hàng loạt thất bại. Vui lòng thử lại.');
        return;
      }

      onAddLog({
        id: `log-${Date.now()}`,
        timestamp: new Date().toISOString(),
        channel: 'all',
        type: type === 'price' ? 'price_update' : 'stock_sync',
        status: 'success',
        message: type === 'price'
          ? `Cập nhật giá hàng loạt cho ${targetProducts.length} sản phẩm thành công.`
          : `Đã chỉnh sửa tồn kho hàng loạt cho ${targetProducts.length} sản phẩm.`,
      });

      if (type === 'price') setShowPricePopover(false);
      else setShowStockPopover(false);
      setBulkMsg(`Đã áp dụng chỉnh sửa ${type === 'price' ? 'giá bán' : 'tồn kho'} cho ${targetProducts.length} sản phẩm.`);
      setTimeout(() => setBulkMsg(null), 3000);
      return;
    }

    const updated = targetProducts.map(prod => {
      let newSellingPrice = prod.sellingPrice;
      let newStock = prod.stock;

      if (type === 'price') {
        if (priceAdjustmentType === 'percent_up') {
          newSellingPrice = Math.round(prod.sellingPrice * (1 + priceValue / 100));
        } else if (priceAdjustmentType === 'percent_down') {
          newSellingPrice = Math.round(prod.sellingPrice * (1 - priceValue / 100));
        } else if (priceAdjustmentType === 'fixed_up') {
          newSellingPrice = prod.sellingPrice + priceValue;
        } else if (priceAdjustmentType === 'fixed_down') {
          newSellingPrice = Math.max(prod.importPrice, prod.sellingPrice - priceValue);
        }
      } else {
        if (stockAdjustmentType === 'flat') {
          newStock = stockValue;
        } else if (stockAdjustmentType === 'add') {
          newStock = prod.stock + stockValue;
        }
      }

      return {
        ...prod,
        sellingPrice: newSellingPrice,
        stock: newStock,
        status: newStock === 0 ? 'out_of_stock' as const : 'active' as const,
        lastSynced: new Date().toISOString()
      };
    });

    onUpdateBulk(updated);

    // Create a sync log
    const logMsg = type === 'price'
      ? `Cập nhật giá hàng loạt cho ${targetProducts.length} sản phẩm thành công.`
      : `Đã chỉnh sửa tồn kho hàng loạt cho ${targetProducts.length} sản phẩm.`;

    onAddLog({
      id: `log-${Date.now()}`,
      timestamp: new Date().toISOString(),
      channel: 'all',
      type: type === 'price' ? 'price_update' : 'stock_sync',
      status: 'success',
      message: logMsg
    });

    // Close active popover and notify
    if (type === 'price') {
      setShowPricePopover(false);
    } else {
      setShowStockPopover(false);
    }

    alert(`Đã áp dụng chỉnh sửa ${type === 'price' ? 'giá bán' : 'tồn kho'} thành công cho ${targetProducts.length} sản phẩm!`);
  };

  // Run AI optimization
  const handleRunAI = async () => {
    setAiLoading(true);
    setAiError('');
    setAiResponse('');

    const activeProd = products.find(p => p.id === aiTargetProdId) || targetProducts[0];
    if (!activeProd) {
      setAiError('Không tìm thấy sản phẩm nào để xử lý AI.');
      setAiLoading(false);
      return;
    }

    try {
      const token = localStorage.getItem('admin_token');
      const res = await fetch('/api/gemini/optimize', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': token ? `Bearer ${token}` : ''
        },
        body: JSON.stringify({
          action: aiAction,
          text: activeProd.title,
          context: aiAction === 'suggest-prices' 
            ? { importPrice: activeProd.importPrice, sellingPrice: activeProd.sellingPrice }
            : `Mô tả gốc: ${activeProd.description}. SKU: ${activeProd.sku}`
        })
      });

      const data = await res.json();
      if (data.error) {
        throw new Error(data.error);
      }

      setAiResponse(data.result);
    } catch (err: any) {
      console.error(err);
      setAiError(err.message || 'Có lỗi xảy ra trong lúc yêu cầu máy chủ AI.');
    } finally {
      setAiLoading(false);
    }
  };

  const handleBulkPublish = async () => {
    if (targetProducts.length === 0) {
      alert('Vui lòng chọn sản phẩm cần đồng bộ!');
      return;
    }

    const channelsToSync: ('shopee' | 'tiktok' | 'woocommerce')[] =
      syncChannel === 'shopee' ? ['shopee'] :
      syncChannel === 'tiktok' ? ['tiktok'] :
      syncChannel === 'woocommerce' ? ['woocommerce'] : ['shopee', 'tiktok', 'woocommerce'];

    setSyncing(true);
    setSyncProgress(5);
    setSyncLogs([
      {
        type: 'info',
        text: `[Hệ thống] Đang gọi API đồng bộ ${targetProducts.length} SKU lên ${channelsToSync.map((c) => c.toUpperCase()).join(', ')}...`,
      },
    ]);

    try {
      const token = localStorage.getItem('admin_token');
      const res = await fetch('/api/products/bulk-channel-sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          productIds: targetProducts.map((p) => p.id),
          channels: channelsToSync,
          shops: shops.filter((s) => s.connected),
        }),
      });

      const rawText = await res.text();
      let data: Record<string, unknown> = {};
      if (rawText.trim()) {
        try {
          data = JSON.parse(rawText);
        } catch {
          setSyncLogs((prev) => [
            ...prev,
            { type: 'error', text: `[Lỗi] Server trả về dữ liệu không hợp lệ (HTTP ${res.status}).` },
          ]);
          setSyncProgress(100);
          return;
        }
      } else if (!res.ok) {
        setSyncLogs((prev) => [
          ...prev,
          {
            type: 'error',
            text: `[Lỗi] API đồng bộ không phản hồi (HTTP ${res.status}). Hãy khởi động lại server (npm run dev).`,
          },
        ]);
        setSyncProgress(100);
        return;
      }

      setSyncProgress(50);

      if (!res.ok && !Array.isArray(data.logs)) {
        setSyncLogs((prev) => [
          ...prev,
          { type: 'error', text: `[Lỗi] ${String(data.error || 'Đồng bộ thất bại')}` },
        ]);
        setSyncProgress(100);
        return;
      }

      const apiLogs: Array<{
        sku: string;
        channel: string;
        action: string;
        success: boolean;
        message: string;
      }> = Array.isArray(data.logs) ? data.logs : [];

      const channelLabel: Record<string, string> = {
        shopee: 'Shopee',
        tiktok: 'TikTok',
        woocommerce: 'WooCommerce',
      };

      for (let i = 0; i < apiLogs.length; i++) {
        const line = apiLogs[i];
        const ch = channelLabel[line.channel] || line.channel;
        const prefix = line.success ? '[Hoàn tất]' : '[Lỗi]';
        const actionLabel = line.action ? ` (${line.action})` : '';
        const text = line.success
          ? `${prefix} SKU [${line.sku}] cập nhật ${ch}${actionLabel}: ${line.message}`
          : `${prefix} SKU [${line.sku}] cập nhật ${ch}${actionLabel} thất bại: ${line.message}`;

        setSyncLogs((prev) => [...prev, { type: line.success ? 'success' : 'error', text }]);
        setSyncProgress(50 + Math.round(((i + 1) / Math.max(apiLogs.length, 1)) * 45));
        await new Promise((r) => setTimeout(r, 40));
      }

      const ok = data.successCount ?? apiLogs.filter((l) => l.success).length;
      const fail = data.failCount ?? apiLogs.filter((l) => !l.success).length;

      setSyncLogs((prev) => [
        ...prev,
        {
          type: fail === 0 ? 'success' : fail > 0 && ok > 0 ? 'info' : 'error',
          text:
            fail === 0
              ? `[Kết quả] Đồng bộ hoàn tất: ${ok}/${apiLogs.length} thao tác thành công.`
              : `[Kết quả] Hoàn tất: ${ok} thành công, ${fail} thất bại (tổng ${apiLogs.length} thao tác).`,
        },
      ]);
      setSyncProgress(100);

      if (Array.isArray(data.products)) {
        onUpdateBulk(data.products as Product[]);
      }

      const channelsWithSuccess = new Set(
        apiLogs.filter((l) => l.success).map((l) => l.channel)
      );
      channelsWithSuccess.forEach((channel) => {
        onAddLog({
          id: `log-${Date.now()}-${channel}`,
          timestamp: new Date().toISOString(),
          channel: channel as SyncLog['channel'],
          type: 'publish',
          status: fail === 0 ? 'success' : 'failed',
          message:
            fail === 0
              ? `Đồng bộ đa kênh thành công cho ${targetProducts.length} SKU lên ${channel}.`
              : `Đồng bộ ${channel}: ${ok} OK, ${fail} lỗi.`,
        });
      });
    } catch (err: any) {
      setSyncLogs((prev) => [
        ...prev,
        { type: 'error', text: `[Lỗi] Không kết nối được server: ${err?.message || 'network error'}` },
      ]);
      setSyncProgress(100);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Search and Selection Area Card */}
      <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-xs space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-gray-50 pb-3">
          <div>
            <h3 className="font-bold text-gray-900 text-base">
              Bộ Lọc Sản Phẩm & Điều Chỉnh Hàng Loạt
            </h3>
            <p className="text-xs text-gray-400 mt-0.5">
              Tích chọn sản phẩm muốn chỉnh sửa, nhập từ khóa tìm kiếm theo Tên hoặc SKU và thao tác chỉnh sửa giá bán, tồn kho ngay kế bên.
            </p>
          </div>
        </div>

        {/* Search input with adjustment buttons next to it */}
        <div className="flex flex-col lg:flex-row lg:items-center gap-3">
          {/* Search box */}
          <div className="relative flex-1">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              placeholder="Tìm kiếm sản phẩm theo tên hoặc mã SKU..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2.5 bg-gray-50/50 hover:bg-gray-50 focus:bg-white rounded-xl border border-gray-100 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/15 text-xs outline-none transition-all font-medium placeholder-gray-400 text-gray-800 shadow-2xs"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Popover 1: Sửa giá hàng loạt */}
            <div className="relative">
              <button
                onClick={() => {
                  setShowPricePopover(!showPricePopover);
                  setShowStockPopover(false);
                }}
                className={`px-4 py-2.5 border rounded-xl text-xs font-bold transition-all flex items-center gap-2 cursor-pointer shadow-2xs ${
                  showPricePopover 
                    ? 'bg-blue-50 border-blue-200 text-blue-700 ring-2 ring-blue-500/20' 
                    : 'bg-white border-gray-200 hover:bg-gray-50 text-gray-700'
                }`}
              >
                <TrendingUp className="w-4 h-4 text-blue-500" />
                <span>Sửa giá hàng loạt</span>
              </button>

              {showPricePopover && (
                <div className="absolute right-0 mt-2 z-30 w-80 p-5 bg-white border border-gray-100 rounded-2xl shadow-xl space-y-4 animate-in fade-in duration-150">
                  <div className="flex items-center gap-2 border-b border-gray-50 pb-2.5">
                    <TrendingUp className="w-4 h-4 text-blue-500" />
                    <span className="font-bold text-gray-800 text-xs uppercase tracking-wide">Chỉnh sửa giá hàng loạt</span>
                  </div>
                  
                  <div className="space-y-3">
                    <div className="space-y-1">
                      <label className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Cách thức điều chỉnh</label>
                      <select
                        value={priceAdjustmentType}
                        onChange={(e) => setPriceAdjustmentType(e.target.value as any)}
                        className="w-full px-3 py-2 bg-gray-50 hover:bg-gray-100 rounded-xl border border-gray-100 outline-none text-xs font-semibold cursor-pointer text-gray-700"
                      >
                        <option value="percent_up">Tăng theo phần trăm (%)</option>
                        <option value="percent_down">Giảm theo phần trăm (%)</option>
                        <option value="fixed_up">Tăng số tiền cố định (đ)</option>
                        <option value="fixed_down">Giảm số tiền cố định (đ)</option>
                      </select>
                    </div>

                    <div className="space-y-1">
                      <label className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Giá trị thay đổi</label>
                      <div className="flex items-center gap-2 bg-gray-50 px-3 py-2 rounded-xl border border-gray-100">
                        <input 
                          type="number" 
                          min="1"
                          value={priceValue}
                          onChange={(e) => setPriceValue(Math.max(1, Number(e.target.value)))}
                          className="w-full bg-transparent font-bold text-gray-800 text-sm outline-none font-mono"
                        />
                        <span className="text-xs font-bold text-gray-400 shrink-0">
                          {priceAdjustmentType.includes('percent') ? '%' : 'đ'}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="bg-blue-50/50 p-2.5 rounded-xl border border-blue-100/50 text-[11px] text-blue-700 leading-normal">
                    Áp dụng cho <strong className="font-extrabold">{targetProducts.length}</strong> sản phẩm đang được tích chọn bên dưới.
                  </div>

                  <div className="flex items-center gap-2 pt-1">
                    <button
                      onClick={() => setShowPricePopover(false)}
                      className="flex-1 py-2 bg-gray-50 hover:bg-gray-100 text-gray-500 rounded-xl font-bold text-xs transition-all border border-gray-100"
                    >
                      Hủy
                    </button>
                    <button
                      onClick={() => handleApplyMath('price')}
                      className="flex-1 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-bold text-xs transition-all shadow-xs"
                    >
                      Xác nhận áp dụng
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Popover 2: Cài đặt tồn kho hàng loạt */}
            <div className="relative">
              <button
                onClick={() => {
                  setShowStockPopover(!showStockPopover);
                  setShowPricePopover(false);
                }}
                className={`px-4 py-2.5 border rounded-xl text-xs font-bold transition-all flex items-center gap-2 cursor-pointer shadow-2xs ${
                  showStockPopover 
                    ? 'bg-indigo-50 border-indigo-200 text-indigo-700 ring-2 ring-indigo-500/20' 
                    : 'bg-white border-gray-200 hover:bg-gray-50 text-gray-700'
                }`}
              >
                <Settings2 className="w-4 h-4 text-indigo-500" />
                <span>Cài tồn kho hàng loạt</span>
              </button>

              {showStockPopover && (
                <div className="absolute right-0 mt-2 z-30 w-80 p-5 bg-white border border-gray-100 rounded-2xl shadow-xl space-y-4 animate-in fade-in duration-150">
                  <div className="flex items-center gap-2 border-b border-gray-50 pb-2.5">
                    <Settings2 className="w-4 h-4 text-indigo-500" />
                    <span className="font-bold text-gray-800 text-xs uppercase tracking-wide">Cài đặt tồn kho hàng loạt</span>
                  </div>
                  
                  <div className="space-y-3">
                    <div className="space-y-1">
                      <label className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Cách thức điều chỉnh</label>
                      <select
                        value={stockAdjustmentType}
                        onChange={(e) => setStockAdjustmentType(e.target.value as any)}
                        className="w-full px-3 py-2 bg-gray-50 hover:bg-gray-100 rounded-xl border border-gray-100 outline-none text-xs font-semibold cursor-pointer text-gray-700"
                      >
                        <option value="flat">Gán tồn kho về mức cố định</option>
                        <option value="add">Cộng thêm số lượng tồn kho</option>
                      </select>
                    </div>

                    <div className="space-y-1">
                      <label className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Số lượng tồn kho</label>
                      <div className="flex items-center gap-2 bg-gray-50 px-3 py-2 rounded-xl border border-gray-100">
                        <input 
                          type="number" 
                          min="0"
                          value={stockValue}
                          onChange={(e) => setStockValue(Math.max(0, Number(e.target.value)))}
                          className="w-full bg-transparent font-bold text-gray-800 text-sm outline-none font-mono"
                        />
                        <span className="text-xs font-bold text-gray-400 shrink-0">chiếc</span>
                      </div>
                    </div>
                  </div>

                  <div className="bg-indigo-50/50 p-2.5 rounded-xl border border-indigo-100/50 text-[11px] text-indigo-700 leading-normal">
                    Áp dụng cho <strong className="font-extrabold">{targetProducts.length}</strong> sản phẩm đang được tích chọn bên dưới.
                  </div>

                  <div className="flex items-center gap-2 pt-1">
                    <button
                      onClick={() => setShowStockPopover(false)}
                      className="flex-1 py-2 bg-gray-50 hover:bg-gray-100 text-gray-500 rounded-xl font-bold text-xs transition-all border border-gray-100"
                    >
                      Hủy
                    </button>
                    <button
                      onClick={() => handleApplyMath('stock')}
                      className="flex-1 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-bold text-xs transition-all shadow-xs"
                    >
                      Xác nhận áp dụng
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Product selector list */}
        <div className="border-t border-gray-100 pt-4 space-y-2">
          <div className="flex items-center justify-between text-xs text-gray-500 pb-1">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={allFilteredIds.length > 0 && allFilteredIds.every((id) => localSelectedIds.includes(id))}
                ref={(el) => {
                  if (el) {
                    const allChecked =
                      allFilteredIds.length > 0 &&
                      allFilteredIds.every((id) => localSelectedIds.includes(id));
                    const someChecked =
                      allFilteredIds.some((id) => localSelectedIds.includes(id)) && !allChecked;
                    el.indeterminate = someChecked;
                  }
                }}
                onChange={(e) => {
                  if (e.target.checked) {
                    setLocalSelectedIds((prev) =>
                      Array.from(new Set([...prev, ...allFilteredIds]))
                    );
                  } else {
                    setLocalSelectedIds((prev) =>
                      prev.filter((id) => !allFilteredIds.includes(id))
                    );
                  }
                }}
                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 w-4 h-4 cursor-pointer"
                id="toggle-all-bulk"
              />
              <label htmlFor="toggle-all-bulk" className="font-bold text-gray-700 cursor-pointer select-none">
                Chọn tất cả ({filteredGroups.length} sản phẩm tìm thấy)
              </label>
            </div>
            
            <span className="font-semibold text-gray-500">
              Đã chọn <strong className="text-blue-600 font-extrabold">{targetProducts.length}</strong> / {products.length} SKU
            </span>
          </div>

          <div className="max-h-[300px] overflow-y-auto divide-y divide-gray-100 border border-gray-100 rounded-2xl bg-gray-50/25 px-2 py-1 scrollbar-thin">
            {filteredGroups.length === 0 ? (
              <div className="py-12 text-center text-gray-400 text-xs">
                Không tìm thấy sản phẩm nào khớp với từ khóa tìm kiếm.
              </div>
            ) : (
              filteredGroups.map((group) => {
                const prod = group.representative;
                const isExpanded = expandedGroupIds.has(group.groupId);
                const priceLabel = formatPriceRange(group.minSellingPrice, group.maxSellingPrice);
                const groupAllSelected = isGroupAllSelected(group);
                const groupPartial = isGroupPartialSelected(group);

                return (
                  <div key={group.groupId}>
                    <div className="py-3 flex items-center justify-between gap-3 px-2">
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        {group.hasVariants ? (
                          <button
                            type="button"
                            onClick={() => toggleExpandGroup(group.groupId)}
                            className="p-0.5 text-gray-400 hover:text-gray-700 shrink-0 cursor-pointer"
                            aria-label={isExpanded ? 'Thu gọn' : 'Mở rộng'}
                          >
                            {isExpanded ? (
                              <ChevronDown className="w-4 h-4" />
                            ) : (
                              <ChevronRight className="w-4 h-4" />
                            )}
                          </button>
                        ) : (
                          <span className="w-5 shrink-0" />
                        )}

                        <input
                          type="checkbox"
                          checked={groupAllSelected}
                          ref={(el) => {
                            if (el) el.indeterminate = groupPartial;
                          }}
                          onChange={() => handleToggleGroup(group)}
                          className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 w-4 h-4 shrink-0 cursor-pointer"
                        />

                        {prod.imageUrl || prod.avatarUrl ? (
                          <img
                            src={prod.avatarUrl || prod.imageUrl}
                            alt={group.displayTitle}
                            className="w-10 h-10 object-cover rounded-lg shrink-0 border border-gray-100"
                            referrerPolicy="no-referrer"
                          />
                        ) : (
                          <div className="w-10 h-10 bg-gray-100 text-gray-400 flex items-center justify-center rounded-lg shrink-0 border border-gray-50 text-[10px] font-bold">
                            No Pic
                          </div>
                        )}

                        <div className="min-w-0 space-y-0.5">
                          <span className="font-bold text-gray-800 text-xs sm:text-sm line-clamp-1 leading-snug block">
                            {group.displayTitle}
                          </span>
                          {group.hasVariants ? (
                            <span className="text-[10px] font-semibold text-indigo-600">
                              {group.variantCount} phiên bản
                            </span>
                          ) : (
                            <span className="text-[10px] font-mono text-gray-400">
                              SKU: {prod.sku}
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-4 shrink-0">
                        <div className="text-right space-y-0.5 font-mono">
                          <div className="text-xs font-bold text-blue-600">{priceLabel}</div>
                          <div className="text-[10px] text-gray-400 font-medium">
                            Tồn:{' '}
                            <span
                              className={`font-bold ${group.totalStock > 0 ? 'text-gray-700' : 'text-rose-500'}`}
                            >
                              {group.totalStock}
                            </span>
                          </div>
                        </div>

                        <div className="max-sm:hidden sm:flex items-center gap-1">
                          {prod.channels.includes('shopee') && (
                            <span className="p-0.5 px-1.5 bg-orange-50 text-orange-600 text-[9px] font-extrabold rounded uppercase border border-orange-100/50">
                              S
                            </span>
                          )}
                          {prod.channels.includes('tiktok') && (
                            <span className="p-0.5 px-1.5 bg-zinc-950 text-white text-[9px] font-extrabold rounded uppercase">
                              T
                            </span>
                          )}
                          {prod.channels.includes('woocommerce') && (
                            <span className="p-0.5 px-1.5 bg-indigo-50 text-indigo-600 text-[9px] font-extrabold rounded uppercase border border-indigo-100/50">
                              W
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    {group.hasVariants && isExpanded && (
                      <div className="pb-2 pl-11 pr-2 space-y-1">
                        {group.variants.map((variant) => {
                          const childSelected = localSelectedIds.includes(variant.id);
                          return (
                            <div
                              key={variant.id}
                              className="flex items-center justify-between gap-3 py-2 px-3 bg-white/80 rounded-xl border border-gray-100"
                            >
                              <div className="flex items-center gap-2.5 min-w-0 flex-1">
                                <input
                                  type="checkbox"
                                  checked={childSelected}
                                  onChange={() => toggleVariantSelect(variant.id)}
                                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 w-3.5 h-3.5 shrink-0 cursor-pointer"
                                />
                                <div className="min-w-0">
                                  <span className="text-[11px] font-semibold text-gray-700 line-clamp-1 block">
                                    {variant.modelName || variant.title}
                                  </span>
                                  <span className="text-[10px] font-mono text-gray-400">
                                    SKU: {variant.sku}
                                  </span>
                                </div>
                              </div>
                              <div className="text-right font-mono shrink-0">
                                <div className="text-[11px] font-bold text-blue-600">
                                  {variant.sellingPrice.toLocaleString('vi-VN')}đ
                                </div>
                                <div className="text-[10px] text-gray-400">
                                  Tồn:{' '}
                                  <span
                                    className={`font-bold ${variant.stock > 0 ? 'text-gray-600' : 'text-rose-500'}`}
                                  >
                                    {variant.stock}
                                  </span>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      <div className="space-y-6">
        <div className="bg-white p-5 rounded-2xl border border-gray-100 shadow-xs space-y-4" id="bulk-publish-box">
            <h4 className="font-bold text-gray-800 text-sm flex items-center gap-2">
              <ShoppingBag className="w-4.5 h-4.5 text-orange-500" /> Xuất Bản & Đồng Bộ Đa Kênh Hàng Loạt
            </h4>

            <p className="text-xs text-gray-400">
              Hệ thống sẽ đồng bộ trực tiếp thông tin sản phẩm (bao gồm tiêu đề, giá bán lẻ đã sửa, tồn kho, mô tả) lên các website WooCommerce và gian hàng Shopee / TikTok Shop đã cấu hình kết nối.
            </p>

            <div className="flex flex-col md:flex-row md:items-center gap-4 text-xs sm:text-sm pt-2 justify-between">
              <div className="flex items-center flex-wrap gap-3 bg-gray-50 px-4 py-2.5 rounded-xl border border-gray-100">
                <span className="text-xs font-semibold text-gray-500">Kênh đích:</span>
                
                <label className="inline-flex items-center gap-1 cursor-pointer font-semibold text-gray-700">
                  <input 
                    type="radio" 
                    name="sync-chan" 
                    checked={syncChannel === 'shopee'}
                    onChange={() => setSyncChannel('shopee')}
                    className="text-orange-500 focus:ring-orange-400 w-4 h-4 cursor-pointer"
                  />
                  Shopee
                </label>

                <label className="inline-flex items-center gap-1 cursor-pointer font-semibold text-gray-700">
                  <input 
                    type="radio" 
                    name="sync-chan" 
                    checked={syncChannel === 'tiktok'}
                    onChange={() => setSyncChannel('tiktok')}
                    className="text-zinc-950 focus:ring-zinc-800 w-4 h-4 cursor-pointer"
                  />
                  TikTok Shop
                </label>

                <label className="inline-flex items-center gap-1 cursor-pointer font-semibold text-gray-700">
                  <input 
                    type="radio" 
                    name="sync-chan" 
                    checked={syncChannel === 'woocommerce'}
                    onChange={() => setSyncChannel('woocommerce')}
                    className="text-indigo-600 focus:ring-indigo-500 w-4 h-4 cursor-pointer"
                  />
                  WooCommerce
                </label>

                <label className="inline-flex items-center gap-1 cursor-pointer font-semibold text-gray-700">
                  <input 
                    type="radio" 
                    name="sync-chan" 
                    checked={syncChannel === 'all'}
                    onChange={() => setSyncChannel('all')}
                    className="text-emerald-600 focus:ring-emerald-500 w-4 h-4 cursor-pointer"
                  />
                  Tất cả các kênh
                </label>
              </div>

              <button
                onClick={handleBulkPublish}
                disabled={syncing}
                className="px-5 py-2.5 bg-linear-to-r from-orange-500 to-rose-600 hover:from-orange-600 hover:to-rose-700 text-white rounded-xl font-bold text-xs transition-all flex items-center gap-2 cursor-pointer shadow-sm disabled:from-gray-300 disabled:to-gray-400 disabled:cursor-not-allowed shrink-0"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
                Đồng bộ lên kênh ({targetProducts.length} SP)
              </button>
            </div>

            {/* Sync Progress animation */}
            {syncProgress >= 0 && (
              <div className="mt-4 p-4 bg-gray-50 rounded-2xl border border-gray-100 space-y-3">
                <div className="flex justify-between items-center text-xs">
                  <span className="font-semibold text-gray-600">Đang đẩy dữ liệu đồng bộ...</span>
                  <span className="font-bold text-gray-900 font-mono">{syncProgress}%</span>
                </div>
                <div className="w-full bg-gray-200 h-2 rounded-full overflow-hidden">
                  <div 
                    className="bg-linear-to-r from-orange-500 to-indigo-600 h-full rounded-full transition-all duration-300"
                    style={{ width: `${syncProgress}%` }}
                  ></div>
                </div>

                {/* Progress Logs */}
                <div className="bg-gray-900 p-3 rounded-xl font-mono text-[11px] max-h-40 overflow-y-auto space-y-1.5 scrollbar-thin">
                  {syncLogs.map((logLine, idx) => (
                    <div
                      key={idx}
                      className={`leading-normal ${
                        logLine.type === 'success'
                          ? 'text-emerald-400'
                          : logLine.type === 'error'
                            ? 'text-rose-400'
                            : 'text-slate-300'
                      }`}
                    >
                      {logLine.text}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
      </div>

      {!aiPanelOpen && (
        <button
          type="button"
          onClick={() => setAiPanelOpen(true)}
          className="fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full bg-linear-to-br from-indigo-600 to-violet-700 hover:from-indigo-500 hover:to-violet-600 text-white shadow-xl shadow-indigo-500/30 flex items-center justify-center cursor-pointer transition-all hover:scale-105"
          title="Mở Cố Vấn AI"
        >
          <Sparkles className="w-6 h-6" />
        </button>
      )}

      {aiPanelOpen && (
        <div className="fixed bottom-6 right-6 z-50 w-[min(400px,calc(100vw-2rem))] max-h-[min(85vh,720px)] overflow-y-auto bg-linear-to-b from-slate-900 to-indigo-950 p-5 rounded-3xl text-white shadow-2xl shadow-indigo-900/40 border border-indigo-500/20 space-y-5 scrollbar-thin">
          <div className="absolute top-0 right-0 w-32 h-32 bg-indigo-500/20 rounded-full blur-2xl pointer-events-none" />

          <div className="flex items-start justify-between gap-2 relative">
            <div className="space-y-1 min-w-0">
              <div className="inline-flex items-center gap-1.5 bg-indigo-500/20 text-indigo-300 px-3 py-1 rounded-full text-[11px] font-bold border border-indigo-400/10">
                <Sparkles className="w-3.5 h-3.5" /> AI Gemini Assistant
              </div>
              <h3 className="text-base font-bold">Cố Vấn Bán Hàng Thông Minh</h3>
              <p className="text-[11px] text-indigo-200">
                Tối ưu tiêu đề SEO, phân tích giá bán bằng Gemini AI.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setAiPanelOpen(false)}
              className="p-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white/80 hover:text-white shrink-0 cursor-pointer"
              title="Thu nhỏ"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="space-y-4 relative">
            {/* Target Select */}
            <div className="space-y-1.5 text-xs">
              <label className="text-indigo-200 font-medium">Chọn sản phẩm phân tích:</label>
              <select
                value={aiTargetProdId}
                onChange={(e) => setAiTargetProdId(e.target.value)}
                className="w-full bg-white/10 hover:bg-white/15 text-white py-2 px-3 rounded-xl border border-white/10 outline-none text-xs cursor-pointer"
              >
                {targetProducts.length === 0 ? (
                  <option value="" className="text-slate-900">Chưa chọn sản phẩm nào</option>
                ) : (
                  targetProducts.map(p => (
                    <option key={p.id} value={p.id} className="text-slate-900">
                      {p.title} (SKU: {p.sku})
                    </option>
                  ))
                )}
              </select>
            </div>

            {/* Actions Select */}
            <div className="grid grid-cols-3 gap-2">
              <button
                onClick={() => setAiAction('optimize-title')}
                className={`py-2 px-1 text-[11px] font-semibold rounded-xl border transition-all text-center ${
                  aiAction === 'optimize-title' 
                    ? 'bg-white text-slate-950 border-white' 
                    : 'bg-white/5 text-white border-white/10 hover:bg-white/10'
                }`}
              >
                Tối ưu Tiêu Đề
              </button>
              <button
                onClick={() => setAiAction('suggest-prices')}
                className={`py-2 px-1 text-[11px] font-semibold rounded-xl border transition-all text-center ${
                  aiAction === 'suggest-prices' 
                    ? 'bg-white text-slate-950 border-white' 
                    : 'bg-white/5 text-white border-white/10 hover:bg-white/10'
                }`}
              >
                Phân Tích Giá
              </button>
              <button
                onClick={() => setAiAction('bulk-tag')}
                className={`py-2 px-1 text-[11px] font-semibold rounded-xl border transition-all text-center ${
                  aiAction === 'bulk-tag' 
                    ? 'bg-white text-slate-950 border-white' 
                    : 'bg-white/5 text-white border-white/10 hover:bg-white/10'
                }`}
              >
                Gợi ý Hashtags
              </button>
            </div>

            {/* Run AI Button */}
            <button
              onClick={handleRunAI}
              disabled={aiLoading || !aiTargetProdId}
              className="w-full py-2.5 bg-indigo-500 hover:bg-indigo-600 text-white rounded-xl font-bold text-xs transition-all flex items-center justify-center gap-2 cursor-pointer shadow-sm disabled:bg-indigo-800 disabled:text-indigo-400"
            >
              <Sparkles className={`w-3.5 h-3.5 ${aiLoading ? 'animate-spin' : ''}`} />
              {aiLoading ? 'AI Đang Tính Toán...' : 'Thực Hiện Phân Tích AI'}
            </button>

            {/* AI Error */}
            {aiError && (
              <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-xs text-red-200 flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{aiError}</span>
              </div>
            )}

            {/* AI Result Box */}
            {aiResponse && (
              <div className="space-y-2 pt-2 border-t border-white/10">
                <h4 className="text-[11px] font-bold text-indigo-300 uppercase tracking-wider">Kết quả đề xuất chi tiết:</h4>
                <div className="bg-black/30 p-4 rounded-xl border border-white/5 text-xs text-indigo-100 max-h-64 overflow-y-auto whitespace-pre-wrap leading-relaxed font-sans scrollbar-thin">
                  {aiResponse}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
